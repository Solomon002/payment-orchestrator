import { DEFAULT_CONTROL } from '@po/mock-gateway';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, parseEnv } from '../src/lib/env';
import { resetDemo } from '../src/modules/demo/demo.service';
import { seedDemoMerchant } from '../src/modules/merchants/merchant.service';
import { HealthTracker } from '../src/modules/routing/health.tracker';
import { startHarness, waitFor, type Harness } from './harness';
import { listen, resetDatabase, silentLog, teardown, testContext } from './helpers';

const owner = { 'x-admin-key': env().ADMIN_API_KEY };

describe('public demo mode (PUBLIC_DEMO=true)', () => {
  let h: Harness;

  async function demoSession() {
    const res = await request(h.url).post('/demo/session');
    expect(res.status).toBe(201);
    return { 'x-admin-key': res.body.token as string };
  }

  beforeAll(async () => {
    h = await startHarness({
      config: {
        ...env(),
        PUBLIC_DEMO: true,
        ENABLE_NAIVE_ENDPOINTS: false,
        DEMO_PAYMENTS_PER_SESSION_PER_HOUR: 5,
        DEMO_ACTIONS_PER_MIN: 1_000,
      },
      log: silentLog,
    });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await resetDatabase(h.ctx);
    for (const gw of Object.values(h.mocks)) Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
    await seedDemoMerchant(h.ctx.prisma, h.ctx.config.DEMO_MERCHANT_API_KEY);
  });

  it('advertises the demo and hands out temporary sessions', async () => {
    const info = await request(h.url).get('/demo/info');
    expect(info.body).toMatchObject({ enabled: true, limits: { paymentsPerClick: 20, paymentsPerHour: 5 } });
    const s = await request(h.url).post('/demo/session');
    expect(s.body.token).toMatch(/^demo_[0-9a-f]{48}$/);
    expect(Date.parse(s.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('a demo session can read the dashboard and identifies as "demo"', async () => {
    const demo = await demoSession();
    expect((await request(h.url).get('/admin/overview').set(demo)).status).toBe(200);
    expect((await request(h.url).get('/admin/me').set(demo)).body.role).toBe('demo');
    expect((await request(h.url).get('/admin/me').set(owner)).body.role).toBe('owner');
  });

  it('a demo session may break and fix the mock gateways and send test payments', async () => {
    const demo = await demoSession();
    const put = await request(h.url).put('/admin/simulator/gateways/mockpay-a/control').set(demo).send({ failureRate: 100 });
    expect(put.status).toBe(200);
    const fire = await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 2, method: 'card' });
    expect(fire.status).toBe(200);
    expect(fire.body.accepted).toBe(2);
  });

  it('a demo session is refused anything outside the allow-list (enforced by the server)', async () => {
    const demo = await demoSession();
    const upload = await request(h.url)
      .post('/admin/reconciliation/settlements/upload')
      .set(demo)
      .set('content-type', 'text/csv')
      .send('gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id\n');
    expect(upload.status).toBe(403);
    expect(upload.body.error.code).toBe('FORBIDDEN_IN_DEMO');
    const resolve = await request(h.url)
      .post('/admin/reconciliation/discrepancies/00000000-0000-0000-0000-000000000000/resolve')
      .set(demo)
      .send({ note: 'not allowed' });
    expect(resolve.status).toBe(403);
  });

  it('limits payments per click and per hour, but not for the owner', async () => {
    const demo = await demoSession();
    const tooMany = await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 21, method: 'card' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('DEMO_LIMIT');

    expect((await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 3, method: 'card' })).status).toBe(200);
    const over = await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 3, method: 'card' }); // 6 > 5
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('DEMO_QUOTA');
    // The refused reservation was handed back: 2 more still fit.
    expect((await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 2, method: 'card' })).status).toBe(200);

    expect((await request(h.url).post('/admin/simulator/payments').set(owner).send({ count: 10, method: 'card' })).status).toBe(200);
  });

  it('rejects unknown demo tokens', async () => {
    const res = await request(h.url).get('/admin/overview').set('x-admin-key', `demo_${'0'.repeat(48)}`);
    expect(res.status).toBe(401);
  });

  it('the reset wipes the sandbox, empties and resets the mocks, and reseeds the demo merchant', async () => {
    const demo = await demoSession();
    await request(h.url).post('/admin/simulator/payments').set(demo).send({ count: 3, method: 'card' });
    await waitFor(async () => (await h.ctx.prisma.payment.count({ where: { status: 'succeeded' } })) === 3);
    h.mocks['mockpay-a'].control.failureRate = 100;
    await new HealthTracker(h.ctx.redis, h.ctx.config).record('mockpay-a', 'card', false, 10);

    await resetDemo(h.ctx);

    expect(await h.ctx.prisma.payment.count()).toBe(0);
    expect(await h.ctx.prisma.merchant.count()).toBe(1); // demo merchant reseeded
    expect(h.mocks['mockpay-a'].control.failureRate).toBe(DEFAULT_CONTROL.failureRate);
    expect(h.mocks['mockpay-a'].charges.size + h.mocks['mockpay-b'].charges.size).toBe(0);
    expect(await h.ctx.redis.keys('po:health:*')).toEqual([]);
    expect((await request(h.url).get('/admin/me').set(demo)).status).toBe(200); // visitors stay signed in
  });
});

describe('public demo mode switched off (default)', () => {
  const ctx = testContext();
  const { server, url } = listen(ctx);
  afterAll(() => teardown(ctx, server));

  it('has no demo sessions and refuses demo-looking tokens', async () => {
    expect((await request(url).get('/demo/info')).body).toEqual({ enabled: false });
    expect((await request(url).post('/demo/session')).status).toBe(404);
    expect((await request(url).get('/admin/overview').set('x-admin-key', `demo_${'a'.repeat(48)}`)).status).toBe(401);
  });

  it('the reset refuses to run', async () => {
    await expect(resetDemo(ctx)).rejects.toThrow(/PUBLIC_DEMO is not enabled/);
  });

  it('env validation refuses PUBLIC_DEMO together with the unsafe naive endpoints', () => {
    expect(() => parseEnv({ ...process.env, PUBLIC_DEMO: 'true', ENABLE_NAIVE_ENDPOINTS: 'true' })).toThrow(/ENABLE_NAIVE_ENDPOINTS/);
  });

  it('nothing else changes for the owner', async () => {
    await resetDatabase(ctx);
    expect((await request(url).get('/admin/me').set(owner)).body).toEqual({ role: 'owner', expiresAt: null, nextResetAt: null });
  });
});
