import { DEFAULT_CONTROL } from '@po/mock-gateway';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';
import { createMerchant } from '../src/modules/merchants/merchant.service';
import { startHarness, waitFor, type Harness } from './harness';
import { resetDatabase, silentLog } from './helpers';

let h: Harness;
const admin = { 'x-admin-key': env().ADMIN_API_KEY };

beforeAll(async () => {
  h = await startHarness({ config: env(), log: silentLog });
});
afterAll(() => h.close());
beforeEach(async () => {
  await resetDatabase(h.ctx);
  for (const gw of Object.values(h.mocks)) {
    Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
  }
  // The simulator acts as the demo merchant from DEMO_MERCHANT_API_KEY.
  await createMerchant(h.ctx.prisma, 'Demo Merchant Ltd', env().DEMO_MERCHANT_API_KEY);
});

describe('admin API', () => {
  it('rejects a wrong admin key', async () => {
    const res = await request(h.url).get('/admin/overview').set('x-admin-key', 'x'.repeat(64));
    expect(res.status).toBe(401);
  });

  it('simulator fires payments; overview, list and detail reflect them with a balanced ledger', async () => {
    const fire = await request(h.url).post('/admin/simulator/payments').set(admin).send({ count: 3, method: 'card' });
    expect(fire.status).toBe(200);
    expect(fire.body.accepted).toBe(3);

    await waitFor(async () => (await h.ctx.prisma.payment.count({ where: { status: 'succeeded' } })) === 3);

    const overview = await request(h.url).get('/admin/overview').set(admin);
    expect(overview.body.payments.counts.succeeded).toBe(3);
    expect(overview.body.payments.succeededVolumeKobo).toBe(1_500_000);
    expect(overview.body.ledgerCheck).toEqual({ totalKobo: 0, balanced: true });

    const list = await request(h.url).get('/admin/payments?status=succeeded&limit=2').set(admin);
    expect(list.body.payments).toHaveLength(2);
    expect(list.body.nextCursor).toBeTruthy();
    const page2 = await request(h.url).get(`/admin/payments?status=succeeded&limit=2&cursor=${list.body.nextCursor}`).set(admin);
    expect(page2.body.payments).toHaveLength(1);

    const detail = await request(h.url).get(`/admin/payments/${list.body.payments[0].id}`).set(admin);
    expect(detail.body.journalEntries).toHaveLength(2);
    for (const je of detail.body.journalEntries) {
      const sum = je.postings.reduce((s: number, p: { amountKobo: number }) => s + p.amountKobo, 0);
      expect(sum).toBe(0);
    }
    expect(detail.body.webhooks[0].status).toBe('processed');
  });

  it('simulator forwards control changes to the mock gateway (validated)', async () => {
    const ok = await request(h.url)
      .put('/admin/simulator/gateways/mockpay-b/control')
      .set(admin)
      .send({ methodOutages: { bank_transfer: true } });
    expect(ok.status).toBe(200);
    expect(h.mocks['mockpay-b'].control.methodOutages.bank_transfer).toBe(true);

    const bad = await request(h.url).put('/admin/simulator/gateways/mockpay-b/control').set(admin).send({ latencyMs: -5 });
    expect(bad.status).toBe(400);

    const unknown = await request(h.url).put('/admin/simulator/gateways/nope/control').set(admin).send({});
    expect(unknown.status).toBe(404);
  });

  it('lists ledger accounts with a zero grand total', async () => {
    await request(h.url).post('/admin/simulator/payments').set(admin).send({ count: 1, method: 'bank_transfer' });
    await waitFor(async () => (await h.ctx.prisma.payment.count({ where: { status: 'succeeded' } })) === 1);
    const res = await request(h.url).get('/admin/ledger/accounts').set(admin);
    expect(res.body.totalKobo).toBe(0);
    expect(res.body.accounts.find((a: { type: string }) => a.type === 'platform_revenue').balanceKobo).toBe(7_500);
  });
});
