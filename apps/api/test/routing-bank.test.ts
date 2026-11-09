import { DEFAULT_CONTROL } from '@po/mock-gateway';
import { seededRng } from '@po/routing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';
import { HealthAwareRouter } from '../src/modules/routing/health.router';
import { startHarness, type Harness } from './harness';
import { merchantWithBalance, resetDatabase, silentLog } from './helpers';

const GTB = '058';
const ZENITH = '057';

function pay(h: Harness, auth: Record<string, string>, method: 'card' | 'bank_transfer', bankCode?: string) {
  return request(h.url)
    .post('/v1/payments')
    .set(auth)
    .set('idempotency-key', randomUUID())
    .send({ amountKobo: 100_000, method, reference: `r-${randomUUID()}`, customerEmail: 'ada@example.com', ...(bankCode ? { bankCode } : {}) });
}

async function attemptsFor(h: Harness, paymentId: string) {
  return h.ctx.prisma.paymentAttempt.count({ where: { paymentId } });
}

function resetMocks(h: Harness) {
  for (const gw of Object.values(h.mocks)) {
    Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
  }
}

describe('bank-level routing (breaker strategy)', () => {
  let h: Harness;
  let auth: Record<string, string>;
  const state = (gateway: string, bank?: string) =>
    (h.ctx.router as HealthAwareRouter).tracker.health(gateway, 'bank_transfer', bank).then((r) => r.state);

  beforeAll(async () => {
    // Long cooldown: these tests check exclusion, not recovery (probing is covered in routing.test.ts).
    h = await startHarness({ config: { ...env(), ROUTING_STRATEGY: 'breaker', ROUTING_COOLDOWN_MS: 60_000 }, log: silentLog, router: 'health' });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await resetDatabase(h.ctx);
    resetMocks(h);
    auth = (await merchantWithBalance(h.ctx, 0n)).auth;
  });

  it('one bank failing on a gateway degrades only that bank route, not the gateway', async () => {
    h.mocks['mockpay-a'].control.bankOutages = [GTB];
    for (let i = 0; i < 3; i++) {
      const res = await pay(h, auth, 'bank_transfer', GTB);
      expect(res.body.payment.gateway).toBe('mockpay-b'); // failed over
    }
    expect(await state('mockpay-a', GTB)).toBe('degraded');
    expect(await state('mockpay-a')).toBe('healthy'); // bank failures were not blamed on the gateway

    const zenith = await pay(h, auth, 'bank_transfer', ZENITH);
    expect(zenith.body.payment.gateway).toBe('mockpay-a'); // other banks still use mockpay-a

    const gtb = await pay(h, auth, 'bank_transfer', GTB);
    expect(gtb.body.payment.gateway).toBe('mockpay-b');
    expect(await attemptsFor(h, gtb.body.payment.id)).toBe(1); // mockpay-a not even tried for GTBank
  });

  it('a bank down on EVERY gateway fails fast with a bank-specific message and suggests card', async () => {
    h.mocks['mockpay-a'].control.bankOutages = [GTB];
    h.mocks['mockpay-b'].control.bankOutages = [GTB];
    for (let i = 0; i < 3; i++) expect((await pay(h, auth, 'bank_transfer', GTB)).status).toBe(402);

    const res = await pay(h, auth, 'bank_transfer', GTB);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('METHOD_UNAVAILABLE');
    expect(res.body.error.details).toMatchObject({ bankCode: GTB, alternatives: ['card'] });
    expect(res.body.error.message).toContain('GTBank');

    expect((await pay(h, auth, 'bank_transfer', ZENITH)).status).toBe(201); // other banks unaffected
    expect((await pay(h, auth, 'card', GTB)).status).toBe(201); // GTBank cards unaffected
  });

  it('exposes bank-level routes on the admin health endpoint', async () => {
    h.mocks['mockpay-a'].control.bankOutages = [GTB];
    for (let i = 0; i < 3; i++) await pay(h, auth, 'bank_transfer', GTB);
    const res = await request(h.url).get('/admin/routing/health').set('x-admin-key', env().ADMIN_API_KEY);
    expect(res.body.strategy).toBe('breaker');
    const route = res.body.bankRoutes.find((r: { gateway: string; bankCode: string }) => r.gateway === 'mockpay-a' && r.bankCode === GTB);
    expect(route.state).toBe('degraded');
    expect(route.expectedSuccess).toBeLessThan(0.9);
  });
});

describe('hybrid strategy (production default)', () => {
  let h: Harness;
  let auth: Record<string, string>;
  const tracker = () => (h.ctx.router as HealthAwareRouter).tracker;

  beforeAll(async () => {
    h = await startHarness({ config: { ...env(), ROUTING_STRATEGY: 'hybrid', ROUTING_COOLDOWN_MS: 60_000 }, log: silentLog, router: 'health', random: seededRng(11) });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await resetDatabase(h.ctx);
    resetMocks(h);
    auth = (await merchantWithBalance(h.ctx, 0n)).auth;
  });

  it('moves traffic off a failing gateway (Thompson ordering stops putting it first, often before its breaker even trips)', async () => {
    h.mocks['mockpay-a'].control.failureRate = 100;
    const firstTry: string[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await pay(h, auth, 'card');
      expect(res.status).toBe(201);
      expect(res.body.payment.gateway).toBe('mockpay-b');
      const first = await h.ctx.prisma.paymentAttempt.findFirst({ where: { paymentId: res.body.payment.id }, orderBy: { startedAt: 'asc' } });
      firstTry.push(first!.gateway);
    }
    // Exact guarantee: each first-try on mockpay-a records a failure, and its breaker trips
    // after ROUTING_MIN_SAMPLES failures, so it can be tried first at most that many times.
    expect(firstTry.filter((g) => g === 'mockpay-a').length).toBeLessThanOrEqual(env().ROUTING_MIN_SAMPLES);
  });

  it('excludes a gateway once its breaker is degraded, whatever the Thompson ordering would prefer', async () => {
    // Force the trip directly, then check the hybrid never offers that gateway.
    for (let i = 0; i < 3; i++) await tracker().record('mockpay-a', 'card', false, 10);
    expect((await tracker().health('mockpay-a', 'card')).state).toBe('degraded');
    for (let i = 0; i < 10; i++) expect(await h.ctx.router.candidates('card', { amountKobo: 100_000 })).toEqual(['mockpay-b']);
  });

  it('routes one bank around a gateway while that gateway keeps serving other banks', async () => {
    h.mocks['mockpay-a'].control.bankOutages = [GTB];
    const firstTry: string[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await pay(h, auth, 'bank_transfer', GTB);
      expect(res.status).toBe(201);
      const first = await h.ctx.prisma.paymentAttempt.findFirst({ where: { paymentId: res.body.payment.id }, orderBy: { startedAt: 'asc' } });
      firstTry.push(first!.gateway);
    }
    // Exact guarantee: each first-try on mockpay-a for GTBank records a BANK failure, and the
    // (mockpay-a, transfer, GTBank) breaker trips after ROUTING_MIN_SAMPLES of them, capping
    // how often Thompson's exploration can send GTBank there. Customers still succeed via failover.
    expect(firstTry.filter((g) => g === 'mockpay-a').length).toBeLessThanOrEqual(env().ROUTING_MIN_SAMPLES);
    expect((await tracker().health('mockpay-a', 'bank_transfer')).state).toBe('healthy'); // gateway not blamed
    // Other banks still get mockpay-a's (cheaper-for-them or better) route: it is offered for Zenith.
    expect(await h.ctx.router.candidates('bank_transfer', { bankCode: ZENITH, amountKobo: 100_000 })).toContain('mockpay-a');
  });
});

describe('Thompson sampling strategy', () => {
  let h: Harness;
  let auth: Record<string, string>;

  beforeAll(async () => {
    // Seeded Thompson draws: the test is reproducible instead of passing "most of the time".
    h = await startHarness({ config: { ...env(), ROUTING_STRATEGY: 'thompson' }, log: silentLog, router: 'health', random: seededRng(7) });
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await resetDatabase(h.ctx);
    resetMocks(h);
    auth = (await merchantWithBalance(h.ctx, 0n)).auth;
  });

  it('learns to send traffic away from a failing gateway', async () => {
    h.mocks['mockpay-a'].control.failureRate = 100;
    const firstTry: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await pay(h, auth, 'card');
      expect(res.status).toBe(201);
      const first = await h.ctx.prisma.paymentAttempt.findFirst({ where: { paymentId: res.body.payment.id }, orderBy: { startedAt: 'asc' } });
      firstTry.push(first!.gateway);
    }
    const lateA = firstTry.slice(10).filter((g) => g === 'mockpay-a').length;
    expect(lateA).toBeLessThanOrEqual(2); // after learning, mockpay-a is rarely tried first
  });

  it('fails fast once a method is clearly down everywhere', async () => {
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = true;
    h.mocks['mockpay-b'].control.methodOutages.bank_transfer = true;
    let sawFastFail = false;
    for (let i = 0; i < 40 && !sawFastFail; i++) {
      const res = await pay(h, auth, 'bank_transfer');
      if (res.status === 503) {
        expect(res.body.error.code).toBe('METHOD_UNAVAILABLE');
        sawFastFail = true;
      }
    }
    expect(sawFastFail).toBe(true);
    expect((await pay(h, auth, 'card')).status).toBe(201);
  });
});
