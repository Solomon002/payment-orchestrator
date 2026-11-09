import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';
import { signWebhook, DEFAULT_CONTROL } from '@po/mock-gateway';
import { accountCode } from '../src/modules/ledger/accounts';
import { accountBalance, ledgerTotal } from '../src/modules/ledger/ledger.service';
import { settlePayment } from '../src/modules/payments/payment.service';
import { canTransition, IllegalTransitionError, transition } from '../src/modules/payments/payment.state';
import { pollPendingPayments } from '../src/queues/poller';
import { startHarness, waitFor, type Harness } from './harness';
import { merchantWithBalance, resetDatabase, silentLog } from './helpers';

let h: Harness;
let auth: Record<string, string>;
let merchantId: string;

const newPayment = (overrides: Record<string, unknown> = {}) => ({
  amountKobo: 500_000, // NGN 5,000
  method: 'card',
  reference: `order-${randomUUID()}`,
  customerEmail: 'ada@example.com',
  ...overrides,
});

async function pay(body = newPayment()) {
  return request(h.url).post('/v1/payments').set(auth).set('idempotency-key', randomUUID()).send(body);
}

async function paymentStatus(id: string) {
  return (await h.ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
}

async function balanceOf(code: string) {
  const account = await h.ctx.prisma.account.findUnique({ where: { code } });
  return account ? accountBalance(h.ctx.prisma, account.id) : 0n;
}

beforeAll(async () => {
  h = await startHarness({ config: env(), log: silentLog });
});
afterAll(() => h.close());

beforeEach(async () => {
  await resetDatabase(h.ctx);
  for (const gw of Object.values(h.mocks)) {
    Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
  }
  const m = await merchantWithBalance(h.ctx, 0n);
  auth = m.auth;
  merchantId = m.merchant.id;
});

describe('payment state machine', () => {
  it('only allows the documented transitions', () => {
    expect(canTransition('created', 'pending')).toBe(true);
    expect(canTransition('pending', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(canTransition('failed', 'succeeded')).toBe(false);
    expect(canTransition('created', 'succeeded')).toBe(false);
  });

  it('rejects an illegal transition at the database layer', async () => {
    const res = await pay();
    const id = res.body.payment.id;
    await waitFor(async () => (await paymentStatus(id)) === 'succeeded');
    await expect(h.ctx.prisma.$transaction((tx) => transition(tx, id, 'succeeded', 'failed'))).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it('a late "failed" outcome cannot undo a succeeded payment', async () => {
    const res = await pay();
    const id = res.body.payment.id;
    await waitFor(async () => (await paymentStatus(id)) === 'succeeded');
    const result = await settlePayment(h.ctx, id, { status: 'failed', gateway: 'mockpay-a' });
    expect(result.changed).toBe(false);
    expect(await paymentStatus(id)).toBe('succeeded');
  });
});

describe('payments + webhooks', () => {
  it('validates input (integer kobo only)', async () => {
    const res = await pay(newPayment({ amountKobo: 100.5 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('happy path: pending -> webhook -> verified -> succeeded with balanced ledger entries', async () => {
    const res = await pay();
    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe('pending');
    const id = res.body.payment.id;

    await waitFor(async () => (await paymentStatus(id)) === 'succeeded');

    // NGN 5,000, platform fee 1.5% = NGN 75 -> merchant gets NGN 4,925
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(492_500n);
    expect(await balanceOf(accountCode.merchantPending(merchantId))).toBe(0n);
    expect(await balanceOf(accountCode.platformRevenue())).toBe(7_500n);
    expect(await ledgerTotal(h.ctx.prisma)).toBe(0n);
    const entries = await h.ctx.prisma.journalEntry.findMany({ where: { paymentId: id } });
    expect(entries.map((e) => e.reference).sort()).toEqual([`payment:${id}:pending`, `payment:${id}:succeeded`]);
  });

  it('duplicate webhooks are stored once and processed once', async () => {
    h.mocks['mockpay-a'].control.webhookMode = 'duplicate';
    const res = await pay();
    const id = res.body.payment.id;
    await waitFor(async () => (await paymentStatus(id)) === 'succeeded');
    // Wait until all three deliveries have landed.
    const event = await waitFor(async () => {
      const e = await h.ctx.prisma.webhookEvent.findFirst({ where: { reference: res.body.payment.reference } });
      return e && e.duplicateCount >= 2 ? e : undefined;
    });
    expect(await h.ctx.prisma.webhookEvent.count({ where: { signatureValid: true } })).toBe(1);
    expect(event.status).toBe('processed');
    expect(await h.ctx.prisma.journalEntry.count({ where: { reference: `payment:${id}:succeeded` } })).toBe(1);
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(492_500n);
  });

  it('rejects a webhook with a bad signature and does not move money', async () => {
    h.mocks['mockpay-a'].control.webhookMode = 'bad_signature';
    const res = await pay();
    const rejected = await waitFor(() => h.ctx.prisma.webhookEvent.findFirst({ where: { status: 'rejected' } }));
    expect(rejected.signatureValid).toBe(false);
    expect(await paymentStatus(res.body.payment.id)).toBe('pending');
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(0n);
  });

  it('rejects a forged webhook sent directly to the endpoint', async () => {
    const body = JSON.stringify({ id: 'evt_forged', type: 'charge.succeeded', data: {} });
    const res = await request(h.url)
      .post('/webhooks/mockpay-a')
      .set('content-type', 'application/json')
      .set('x-mock-signature', signWebhook('not-the-secret', body))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('a dropped webhook is recovered by the polling fallback', async () => {
    h.mocks['mockpay-a'].control.webhookMode = 'drop';
    const res = await pay();
    const id = res.body.payment.id;
    // Wait for the mock to complete the charge (it just never tells us).
    await waitFor(async () => h.mocks['mockpay-a'].charges.get(res.body.payment.reference)?.status === 'succeeded');
    expect(await paymentStatus(id)).toBe('pending');

    const summary = await pollPendingPayments(h.ctx);
    expect(summary.succeeded).toBe(1);
    expect(await paymentStatus(id)).toBe('succeeded');
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(492_500n);
  });

  it('a delayed webhook arriving AFTER the poller settled the payment changes nothing', async () => {
    h.mocks['mockpay-a'].control.webhookMode = 'delayed';
    h.mocks['mockpay-a'].control.webhookDelayMs = 1_000;
    const res = await pay();
    const id = res.body.payment.id;
    await waitFor(async () => h.mocks['mockpay-a'].charges.get(res.body.payment.reference)?.status === 'succeeded');
    await pollPendingPayments(h.ctx);
    expect(await paymentStatus(id)).toBe('succeeded');

    const late = await waitFor(async () => {
      const e = await h.ctx.prisma.webhookEvent.findFirst({ where: { reference: res.body.payment.reference } });
      return e?.status === 'processed' ? e : undefined;
    });
    expect(late.status).toBe('processed');
    expect(await h.ctx.prisma.journalEntry.count({ where: { paymentId: id } })).toBe(2);
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(492_500n);
  });

  it('a declined charge fails the payment and releases the pending amount', async () => {
    h.mocks['mockpay-a'].control.declineRate = 100;
    const res = await pay();
    const id = res.body.payment.id;
    await waitFor(async () => (await paymentStatus(id)) === 'failed');
    expect(await balanceOf(accountCode.merchantPending(merchantId))).toBe(0n);
    expect(await balanceOf(accountCode.merchantBalance(merchantId))).toBe(0n);
    expect(await ledgerTotal(h.ctx.prisma)).toBe(0n);
  });

  it('fails over to the next gateway inside a single request', async () => {
    h.mocks['mockpay-a'].control.failureRate = 100;
    const res = await pay();
    expect(res.status).toBe(201);
    expect(res.body.payment.gateway).toBe('mockpay-b');
    const attempts = await h.ctx.prisma.paymentAttempt.findMany({ where: { paymentId: res.body.payment.id }, orderBy: { startedAt: 'asc' } });
    expect(attempts.map((a) => [a.gateway, a.status])).toEqual([
      ['mockpay-a', 'error'],
      ['mockpay-b', 'initiated'],
    ]);
  });

  it('REGRESSION: an error in our own bookkeeping after the gateway accepted the charge never triggers failover (no double charge)', async () => {
    // Found by `pnpm demo`: a slow DB transaction right after a successful initialize
    // was treated as a gateway failure, so the payment was charged on BOTH gateways.
    const original = h.ctx.router.recordResult.bind(h.ctx.router);
    h.ctx.router.recordResult = async () => {
      throw new Error('simulated Redis outage while recording health');
    };
    try {
      const res = await pay();
      expect(res.status).toBe(201);
      const attempts = await h.ctx.prisma.paymentAttempt.findMany({ where: { paymentId: res.body.payment.id } });
      expect(attempts.map((a) => a.gateway)).toEqual(['mockpay-a']); // never tried mockpay-b
      expect(h.mocks['mockpay-b'].charges.has(res.body.payment.reference)).toBe(false); // and mockpay-b never charged this customer
    } finally {
      h.ctx.router.recordResult = original;
    }
  });

  it('when every gateway fails, returns 402 with a failed payment and a suggested alternative method', async () => {
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = true;
    h.mocks['mockpay-b'].control.methodOutages.bank_transfer = true;
    const res = await pay(newPayment({ method: 'bank_transfer' }));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_FAILED');
    expect(res.body.error.details.payment.status).toBe('failed');
    expect(res.body.error.details.alternatives).toEqual(['card']);
    expect(await ledgerTotal(h.ctx.prisma)).toBe(0n);
  });

  it('rejects a duplicate merchant reference', async () => {
    const body = newPayment();
    await pay(body);
    const again = await pay(body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_REFERENCE');
  });

  it('a merchant cannot read another merchant\'s payment', async () => {
    const res = await pay();
    const other = await merchantWithBalance(h.ctx, 0n);
    const peek = await request(h.url).get(`/v1/payments/${res.body.payment.id}`).set(other.auth);
    expect(peek.status).toBe(404);
  });
});
