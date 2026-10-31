import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { merchantBalances } from '../src/modules/withdrawals/withdrawal.service';
import { listen, merchantWithBalance, resetDatabase, teardown, testContext } from './helpers';

const ctx = testContext();
const { server, url } = listen(ctx);

describe('auth', () => {
  beforeAll(() => resetDatabase(ctx));

  it('rejects requests without an API key', async () => {
    const res = await request(url).get('/v1/balance');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown API key', async () => {
    const res = await request(url).get('/v1/balance').set('authorization', `Bearer sk_test_${'0'.repeat(48)}`);
    expect(res.status).toBe(401);
  });
});

describe('idempotency', () => {
  beforeEach(() => resetDatabase(ctx));

  it('requires an Idempotency-Key on money-moving endpoints', async () => {
    const { auth } = await merchantWithBalance(ctx, 100_000n);
    const res = await request(url).post('/v1/withdrawals').set(auth).send({ amountKobo: 1_000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the stored response for the same key and body, moving money once', async () => {
    const { merchant, auth } = await merchantWithBalance(ctx, 100_000n);
    const key = `test-${randomUUID()}`;
    const first = await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 1_000 });
    const second = await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 1_000 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.withdrawal.id).toBe(first.body.withdrawal.id);
    expect(await ctx.prisma.withdrawal.count({ where: { merchantId: merchant.id } })).toBe(1);
    expect((await merchantBalances(ctx, merchant.id)).availableKobo).toBe(99_000n);
  });

  it('returns 422 when a key is reused with a different body', async () => {
    const { auth } = await merchantWithBalance(ctx, 100_000n);
    const key = `test-${randomUUID()}`;
    await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 1_000 });
    const res = await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 2_000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('stores and replays 4xx business errors too (insufficient funds)', async () => {
    const { auth } = await merchantWithBalance(ctx, 500n);
    const key = `test-${randomUUID()}`;
    const first = await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 1_000 });
    const again = await request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 1_000 });
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(again.status).toBe(409);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  it('keys are scoped per merchant', async () => {
    const a = await merchantWithBalance(ctx, 100_000n);
    const b = await merchantWithBalance(ctx, 100_000n);
    const key = `shared-${randomUUID()}`;
    const ra = await request(url).post('/v1/withdrawals').set(a.auth).set('idempotency-key', key).send({ amountKobo: 1_000 });
    const rb = await request(url).post('/v1/withdrawals').set(b.auth).set('idempotency-key', key).send({ amountKobo: 5_000 });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
  });
});

describe('concurrent withdrawals', () => {
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => teardown(ctx, server));

  it('SAFE: 50 simultaneous withdrawals never overdraw the balance', async () => {
    const { merchant, auth } = await merchantWithBalance(ctx, 1_000_000n); // NGN 10,000
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', randomUUID()).send({ amountKobo: 100_000 }),
      ),
    );
    const ok = responses.filter((r) => r.status === 201).length;
    const insufficient = responses.filter((r) => r.body?.error?.code === 'INSUFFICIENT_FUNDS').length;

    expect(ok).toBe(10);
    expect(insufficient).toBe(40);
    expect((await merchantBalances(ctx, merchant.id)).availableKobo).toBe(0n);
  });

  it('SAFE: 20 simultaneous requests with ONE key create exactly one withdrawal', async () => {
    const { merchant, auth } = await merchantWithBalance(ctx, 1_000_000n);
    const key = `one-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        request(url).post('/v1/withdrawals').set(auth).set('idempotency-key', key).send({ amountKobo: 100_000 }),
      ),
    );
    expect(await ctx.prisma.withdrawal.count({ where: { merchantId: merchant.id } })).toBe(1);
  });

  it('NAIVE: documents the bug - concurrent requests can overdraw (expected to overdraw with a race window)', async () => {
    const { merchant, auth } = await merchantWithBalance(ctx, 1_000_000n);
    await Promise.all(
      Array.from({ length: 30 }, () =>
        request(url).post('/v1/withdrawals/naive').set(auth).send({ amountKobo: 100_000 }),
      ),
    );
    // We assert the bug happens so the demo stays honest; if this ever fails,
    // the race window was too small to reproduce on this machine.
    expect((await merchantBalances(ctx, merchant.id)).availableKobo).toBeLessThan(0n);
  });
});
