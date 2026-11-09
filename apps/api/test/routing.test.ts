import { DEFAULT_CONTROL } from '@po/mock-gateway';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';
import { HealthAwareRouter } from '../src/modules/routing/health.router';
import { HealthTracker } from '../src/modules/routing/health.tracker';
import { startHarness, type Harness } from './harness';
import { merchantWithBalance, resetDatabase, silentLog } from './helpers';

let h: Harness;
let auth: Record<string, string>;
// Test settings: MIN_SAMPLES=3, MIN_SUCCESS_RATE=0.8, PROBE_SUCCESSES=2. A long cooldown so a
// degraded route can't drift into 'probing' mid-test on a slow machine; the recovery
// test below uses its own harness with a short cooldown.
const config = { ...env(), ROUTING_COOLDOWN_MS: 60_000 };

const pay = (method: 'card' | 'bank_transfer' = 'card') =>
  request(h.url)
    .post('/v1/payments')
    .set(auth)
    .set('idempotency-key', randomUUID())
    .send({ amountKobo: 100_000, method, reference: `r-${randomUUID()}`, customerEmail: 'ada@example.com' });

const routeState = async (gateway: string, method: 'card' | 'bank_transfer') =>
  (await (h.ctx.router as HealthAwareRouter).tracker.health(gateway, method)).state;

beforeAll(async () => {
  h = await startHarness({ config, log: silentLog, router: 'health' });
});
afterAll(() => h.close());
beforeEach(async () => {
  await resetDatabase(h.ctx);
  for (const gw of Object.values(h.mocks)) {
    Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
  }
  auth = (await merchantWithBalance(h.ctx, 0n)).auth;
});

describe('health tracker (circuit breaker), with a fake clock', () => {
  const cfg = { ...config, ROUTING_MIN_SAMPLES: 3, ROUTING_MIN_SUCCESS_RATE: 0.8, ROUTING_COOLDOWN_MS: 1_000, ROUTING_PROBE_SUCCESSES: 2 };
  let clock = 0;
  const tracker = () => new HealthTracker(h.ctx.redis, cfg, () => clock);

  it('does not trip before the minimum sample size (no flip-flop on one blip)', async () => {
    const t = tracker();
    await t.record('g', 'card', false, 10);
    await t.record('g', 'card', false, 10);
    expect((await t.health('g', 'card')).state).toBe('healthy');
  });

  it('trips when the success rate drops below the threshold, then probes after the cooldown', async () => {
    clock = 10_000;
    const t = tracker();
    for (const ok of [true, false, false]) await t.record('g', 'card', ok, 10);
    expect((await t.health('g', 'card')).state).toBe('degraded');

    clock += 999;
    expect((await t.health('g', 'card')).state).toBe('degraded');
    clock += 1;
    expect((await t.health('g', 'card')).state).toBe('probing');
  });

  it('a failed probe re-opens the breaker; consecutive successful probes close it', async () => {
    clock = 50_000;
    const t = tracker();
    for (let i = 0; i < 3; i++) await t.record('g', 'card', false, 10);
    clock += 1_000;
    expect((await t.health('g', 'card')).state).toBe('probing');

    await t.record('g', 'card', false, 10);
    expect((await t.health('g', 'card')).state).toBe('degraded');

    clock += 1_000;
    await t.record('g', 'card', true, 10);
    expect((await t.health('g', 'card')).state).toBe('probing'); // one success is not enough
    await t.record('g', 'card', true, 10);
    expect((await t.health('g', 'card')).state).toBe('healthy');
  });
});

describe('routing + failover', () => {
  it('stops sending traffic to a failing gateway once it is degraded', async () => {
    h.mocks['mockpay-a'].control.failureRate = 100;
    for (let i = 0; i < 3; i++) {
      const res = await pay();
      expect(res.body.payment.gateway).toBe('mockpay-b'); // failed over inside the request
    }
    expect(await routeState('mockpay-a', 'card')).toBe('degraded');

    const next = await pay();
    const attempts = await h.ctx.prisma.paymentAttempt.count({ where: { paymentId: next.body.payment.id } });
    expect(attempts).toBe(1); // mockpay-a is no longer even tried
    expect(next.body.payment.gateway).toBe('mockpay-b');
  });

  it('tracks health per METHOD: a bank_transfer outage does not affect cards', async () => {
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = true;
    for (let i = 0; i < 3; i++) await pay('bank_transfer');
    expect(await routeState('mockpay-a', 'bank_transfer')).toBe('degraded');
    expect(await routeState('mockpay-a', 'card')).toBe('healthy');

    const card = await pay('card');
    expect(card.body.payment.gateway).toBe('mockpay-a');
    const bank = await pay('bank_transfer');
    expect(bank.body.payment.gateway).toBe('mockpay-b');
  });

  it('NIBSS-style outage: bank_transfer down on every gateway -> 503 suggesting card', async () => {
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = true;
    h.mocks['mockpay-b'].control.methodOutages.bank_transfer = true;
    for (let i = 0; i < 3; i++) expect((await pay('bank_transfer')).status).toBe(402);

    const res = await pay('bank_transfer');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('METHOD_UNAVAILABLE');
    expect(res.body.error.details.alternatives).toEqual(['card']);
    expect((await pay('card')).status).toBe(201);
  });

  it('recovers: after the cooldown a fixed gateway is probed and returns to healthy', async () => {
    const cooldown = 1_500;
    const r = await startHarness({ config: { ...config, ROUTING_COOLDOWN_MS: cooldown }, log: silentLog, router: 'health' });
    try {
      for (const gw of Object.values(r.mocks)) Object.assign(gw.control, { latencyMs: 5, completionDelayMs: 50 });
      const a = (await merchantWithBalance(r.ctx, 0n)).auth;
      const payR = () =>
        request(r.url)
          .post('/v1/payments')
          .set(a)
          .set('idempotency-key', randomUUID())
          .send({ amountKobo: 100_000, method: 'card', reference: `r-${randomUUID()}`, customerEmail: 'ada@example.com' });
      const stateR = async () => (await (r.ctx.router as HealthAwareRouter).tracker.health('mockpay-a', 'card')).state;

      r.mocks['mockpay-a'].control.failureRate = 100;
      for (let i = 0; i < 3; i++) await payR();
      expect(await stateR()).toBe('degraded');

      r.mocks['mockpay-a'].control.failureRate = 0; // gateway fixed
      await new Promise((res) => setTimeout(res, cooldown + 100));
      expect(await stateR()).toBe('probing');

      // Force traffic onto the probing route by breaking mockpay-b.
      r.mocks['mockpay-b'].control.failureRate = 100;
      await payR();
      await payR();
      expect(await stateR()).toBe('healthy');
    } finally {
      await r.close();
    }
  });

  it('exposes routing health to admins only', async () => {
    expect((await request(h.url).get('/admin/routing/health')).status).toBe(401);
    const res = await request(h.url).get('/admin/routing/health').set('x-admin-key', config.ADMIN_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.routes).toHaveLength(4); // 2 gateways x 2 methods
  });
});
