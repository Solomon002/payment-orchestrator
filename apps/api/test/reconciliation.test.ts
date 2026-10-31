import { DEFAULT_CONTROL } from '@po/mock-gateway';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/lib/env';
import { runReconciliation } from '../src/modules/reconciliation/reconciliation.service';
import { parseSettlementCsv } from '../src/modules/reconciliation/settlement.importer';
import { startHarness, waitFor, type Harness } from './harness';
import { merchantWithBalance, resetDatabase, silentLog } from './helpers';

let h: Harness;
let auth: Record<string, string>;
const admin = { 'x-admin-key': env().ADMIN_API_KEY };

async function succeededPayment(amountKobo = 250_000) {
  const res = await request(h.url)
    .post('/v1/payments')
    .set(auth)
    .set('idempotency-key', randomUUID())
    .send({ amountKobo, method: 'card', reference: `r-${randomUUID()}`, customerEmail: 'ada@example.com' });
  expect(res.status).toBe(201);
  const id: string = res.body.payment.id;
  await waitFor(async () => (await h.ctx.prisma.payment.findUnique({ where: { id } }))?.status === 'succeeded');
  return res.body.payment as { id: string; reference: string; gateway: string };
}

const control = (gateway: string, path: string, body: unknown) =>
  request(h.mocks[gateway as keyof Harness['mocks']].app)
    .post(`/control${path}`)
    .set('x-control-key', env().MOCK_CONTROL_KEY)
    .send(body as object);

beforeAll(async () => {
  h = await startHarness({ config: env(), log: silentLog });
});
afterAll(() => h.close());
beforeEach(async () => {
  await resetDatabase(h.ctx);
  for (const gw of Object.values(h.mocks)) {
    gw.charges.clear();
    Object.assign(gw.control, structuredClone(DEFAULT_CONTROL), { latencyMs: 5, completionDelayMs: 50 });
    await request(gw.app).post('/control/reset').set('x-control-key', env().MOCK_CONTROL_KEY);
  }
  auth = (await merchantWithBalance(h.ctx, 0n)).auth;
});

describe('reconciliation', () => {
  it('a clean day reconciles with zero discrepancies', async () => {
    for (let i = 0; i < 3; i++) await succeededPayment();
    const run = await runReconciliation(h.ctx);
    expect(run.status).toBe('completed');
    expect(run.discrepancies).toHaveLength(0);
    expect(run.totals).toMatchObject({ matched: 3, discrepancies: 0 });
  });

  it('flags every discrepancy type', async () => {
    const tampered = await succeededPayment();
    const omitted = await succeededPayment();
    const ok = await succeededPayment();

    // status_mismatch: the gateway completes the charge but the webhook is lost
    // and the poller hasn't run yet, so our payment is still "pending".
    h.mocks['mockpay-a'].control.webhookMode = 'drop';
    const res = await request(h.url)
      .post('/v1/payments')
      .set(auth)
      .set('idempotency-key', randomUUID())
      .send({ amountKobo: 100_000, method: 'card', reference: `r-${randomUUID()}`, customerEmail: 'ada@example.com' });
    const stuck = res.body.payment;
    await waitFor(async () => h.mocks['mockpay-a'].charges.get(stuck.reference)?.status === 'succeeded');

    await control(tampered.gateway, '/settlements/tamper', { reference: tampered.reference, amountKobo: 249_000 });
    await control(omitted.gateway, '/settlements/omit', { reference: omitted.reference });
    await control('mockpay-a', '/settlements/phantom', { amountKobo: 77_700 });

    const run = await runReconciliation(h.ctx);
    const types = run.discrepancies.map((d) => d.type).sort();
    expect(types).toEqual(['amount_mismatch', 'missing_in_gateway', 'missing_in_ledger', 'status_mismatch']);

    const byType = Object.fromEntries(run.discrepancies.map((d) => [d.type, d]));
    expect(byType.amount_mismatch!.gatewayReference).toBe(tampered.reference);
    expect(byType.amount_mismatch!.ledgerAmount).toBe(250_000n);
    expect(byType.amount_mismatch!.gatewayAmount).toBe(249_000n);
    expect(byType.missing_in_gateway!.gatewayReference).toBe(omitted.reference);
    expect(byType.status_mismatch!.gatewayReference).toBe(stuck.reference);
    expect(run.totals).toMatchObject({ matched: 1 });
    expect(ok.reference).toBeTruthy();
  });

  it('flags the same reference settled on a second gateway (possible double charge after failover)', async () => {
    const p = await succeededPayment();
    const other = p.gateway === 'mockpay-a' ? 'mockpay-b' : 'mockpay-a';
    await h.ctx.prisma.gatewaySettlement.create({
      data: { gateway: other, reference: p.reference, amountKobo: 250_000n, feeKobo: 3_750n, settledAt: new Date(), batchId: 'x', source: 'csv_upload' },
    });
    const run = await runReconciliation(h.ctx);
    expect(run.discrepancies).toHaveLength(1);
    expect(run.discrepancies[0]).toMatchObject({ type: 'missing_in_ledger', gateway: other, gatewayReference: p.reference });
  });

  it('runs on demand through the admin API and lists discrepancies', async () => {
    await succeededPayment();
    await control('mockpay-a', '/settlements/phantom', { amountKobo: 10_000 });

    const res = await request(h.url).post('/admin/reconciliation/run').set(admin).send({});
    expect(res.status).toBe(201);
    expect(res.body.run.discrepancies).toHaveLength(1);

    const list = await request(h.url).get('/admin/reconciliation/discrepancies?resolved=false').set(admin);
    expect(list.body.discrepancies).toHaveLength(1);
    const id = list.body.discrepancies[0].id;
    const resolve = await request(h.url).post(`/admin/reconciliation/discrepancies/${id}/resolve`).set(admin).send({ note: 'chargeback from old system' });
    expect(resolve.status).toBe(200);
  });

  it('imports settlements from an uploaded CSV and validates it', async () => {
    const p = await succeededPayment();
    const settled = h.mocks[p.gateway as 'mockpay-a'].charges.get(p.reference)!;
    const csv = [
      'gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id',
      `paystack,${'ext_' + randomUUID().slice(0, 8)},120000,1800,${new Date().toISOString()},ps-batch-1`,
      `${p.gateway},${p.reference},${settled.amountKobo},${settled.feeKobo},${settled.paidAt},b-1`,
    ].join('\n');
    const up = await request(h.url).post('/admin/reconciliation/settlements/upload').set(admin).set('content-type', 'text/csv').send(csv);
    expect(up.status).toBe(201);
    expect(up.body.imported).toEqual({ paystack: 1, [p.gateway]: 1 });

    const run = await runReconciliation(h.ctx, { importFirst: false });
    expect(run.discrepancies.map((d) => d.type)).toEqual(['missing_in_ledger']);

    expect(() => parseSettlementCsv('wrong,header\n1,2')).toThrow(/header/);
    expect(() => parseSettlementCsv('gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id\nmockpay-a,r1,12.5,0,2026-01-01,b')).toThrow(/whole kobo/);
  });
});
