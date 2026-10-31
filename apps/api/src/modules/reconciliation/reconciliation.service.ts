// RECONCILIATION: compare what OUR LEDGER says happened with what each GATEWAY
// says it settled, and flag every difference for a human.
//
// Analogy: checking your bank statement against your own spending notes at
// the end of the month. Every line should appear in both, with the same amount.
//
// Discrepancy types:
//  missing_in_ledger   gateway settled money for a reference we have no payment for
//  missing_in_gateway  our ledger says a payment succeeded, the gateway's report doesn't have it
//  amount_mismatch     both have it, but the gross amount or the fee differs
//  status_mismatch     gateway settled it, but our payment is still pending/failed/expired
//                      (e.g. a lost webhook the poller hasn't caught yet)
import type { DiscrepancyType, Prisma } from '@prisma/client';
import type { AppContext } from '../../context';
import { importSettlementsFromGateways } from './settlement.importer';

export interface RunOptions {
  from?: Date;
  to?: Date;
  /** Pull fresh settlement data from gateway APIs before comparing. */
  importFirst?: boolean;
}

interface LedgerView {
  id: string;
  reference: string;
  gateway: string | null;
  status: string;
  grossKobo: bigint | null; // gateway_clearing + gateway_fees postings of the "succeeded" entry
  feeKobo: bigint | null;
}

/** Reads succeeded-payment amounts from the LEDGER (postings), not the payments table. */
async function ledgerViews(ctx: AppContext, where: Prisma.PaymentWhereInput): Promise<LedgerView[]> {
  const payments = await ctx.prisma.payment.findMany({
    where,
    select: { id: true, reference: true, selectedGateway: true, status: true },
  });
  if (payments.length === 0) return [];
  const ids = payments.map((p) => p.id);
  const sums = await ctx.prisma.$queryRaw<{ payment_id: string; gross: bigint | null; fee: bigint | null }[]>`
    SELECT je.payment_id,
           SUM(po.amount_kobo) FILTER (WHERE a.type IN ('gateway_clearing', 'gateway_fees'))::bigint AS gross,
           SUM(po.amount_kobo) FILTER (WHERE a.type = 'gateway_fees')::bigint AS fee
    FROM journal_entries je
    JOIN postings po ON po.journal_entry_id = je.id
    JOIN accounts a ON a.id = po.account_id
    WHERE je.payment_id = ANY(${ids}::uuid[])
      AND je.reference = 'payment:' || je.payment_id || ':succeeded'
    GROUP BY je.payment_id`;
  const byId = new Map(sums.map((s) => [s.payment_id, s]));
  return payments.map((p) => ({
    id: p.id,
    reference: p.reference,
    gateway: p.selectedGateway,
    status: p.status,
    grossKobo: byId.get(p.id)?.gross ?? null,
    feeKobo: byId.get(p.id)?.fee ?? (byId.has(p.id) ? 0n : null),
  }));
}

export async function runReconciliation(ctx: AppContext, options: RunOptions = {}) {
  const to = options.to ?? new Date(Date.now() + 60_000);
  const from = options.from ?? new Date(to.getTime() - 7 * 24 * 3_600_000);
  const run = await ctx.prisma.reconciliationRun.create({ data: { windowFrom: from, windowTo: to } });

  try {
    const imported = options.importFirst === false ? null : await importSettlementsFromGateways(ctx);

    const settlements = await ctx.prisma.gatewaySettlement.findMany({ where: { settledAt: { gte: from, lte: to } } });
    const succeededInWindow = await ledgerViews(ctx, { status: 'succeeded', succeededAt: { gte: from, lte: to } });

    // Look items up by reference regardless of the window, so a payment at
    // 23:59 settled at 00:01 isn't reported as missing on either side.
    const settlementRefs = settlements.map((s) => s.reference);
    const paymentsForSettlements = await ledgerViews(ctx, { reference: { in: settlementRefs } });
    const paymentByRef = new Map([...paymentsForSettlements, ...succeededInWindow].map((p) => [p.reference, p]));
    const allSettlementsForPayments = await ctx.prisma.gatewaySettlement.findMany({
      where: { reference: { in: succeededInWindow.map((p) => p.reference) } },
    });
    const settlementByRef = new Map([...allSettlementsForPayments, ...settlements].map((s) => [s.reference, s]));
    // Only expect settlements from gateways we actually have settlement data for.
    const gatewaysWithData = new Set(
      (await ctx.prisma.gatewaySettlement.findMany({ distinct: ['gateway'], select: { gateway: true } })).map((g) => g.gateway),
    );

    const found: Prisma.DiscrepancyCreateManyInput[] = [];
    const add = (d: Omit<Prisma.DiscrepancyCreateManyInput, 'runId'>) => found.push({ ...d, runId: run.id });
    let matched = 0;

    for (const s of settlements) {
      const p = paymentByRef.get(s.reference);
      if (!p) {
        add({ type: 'missing_in_ledger', gateway: s.gateway, gatewayReference: s.reference, gatewayAmount: s.amountKobo, note: 'Gateway settled a reference we have no payment for' });
      } else if (p.gateway !== s.gateway) {
        // Same reference settled by a gateway that did NOT complete the payment: e.g. a
        // failover where the first gateway timed out but actually charged the customer.
        add({ type: 'missing_in_ledger', gateway: s.gateway, paymentId: p.id, gatewayReference: s.reference, gatewayAmount: s.amountKobo, note: `Settled on ${s.gateway} but our payment completed on ${p.gateway}: possible double charge` });
      } else if (p.status !== 'succeeded') {
        add({ type: 'status_mismatch', gateway: s.gateway, paymentId: p.id, gatewayReference: s.reference, gatewayAmount: s.amountKobo, note: `Gateway settled it but our payment is "${p.status}"` });
      } else if (p.grossKobo !== s.amountKobo) {
        add({ type: 'amount_mismatch', gateway: s.gateway, paymentId: p.id, gatewayReference: s.reference, ledgerAmount: p.grossKobo, gatewayAmount: s.amountKobo, note: 'Gross amount differs' });
      } else if (p.feeKobo !== s.feeKobo) {
        add({ type: 'amount_mismatch', gateway: s.gateway, paymentId: p.id, gatewayReference: s.reference, ledgerAmount: p.feeKobo, gatewayAmount: s.feeKobo, note: 'Fee differs' });
      } else {
        matched++;
      }
    }

    let skippedNoData = 0;
    for (const p of succeededInWindow) {
      if (settlementByRef.has(p.reference)) continue;
      if (!p.gateway || !gatewaysWithData.has(p.gateway)) {
        skippedNoData++;
        continue;
      }
      add({ type: 'missing_in_gateway', gateway: p.gateway, paymentId: p.id, gatewayReference: p.reference, ledgerAmount: p.grossKobo, note: 'Ledger shows success but the gateway report has no settlement' });
    }

    if (found.length) await ctx.prisma.discrepancy.createMany({ data: found });
    const byType: Record<DiscrepancyType, number> = { missing_in_ledger: 0, missing_in_gateway: 0, amount_mismatch: 0, status_mismatch: 0 };
    for (const d of found) byType[d.type]++;

    const totals = {
      settlementsChecked: settlements.length,
      paymentsChecked: succeededInWindow.length,
      matched,
      discrepancies: found.length,
      byType,
      skippedNoSettlementData: skippedNoData,
      imported,
    };
    return ctx.prisma.reconciliationRun.update({
      where: { id: run.id },
      data: { status: 'completed', finishedAt: new Date(), totals },
      include: { discrepancies: true },
    });
  } catch (err) {
    await ctx.prisma.reconciliationRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), error: (err as Error).message.slice(0, 1000) },
    });
    throw err;
  }
}

/** Nightly job: look back 48h so anything settled late is still compared. */
export function runNightlyReconciliation(ctx: AppContext) {
  const to = new Date();
  return runReconciliation(ctx, { from: new Date(to.getTime() - 48 * 3_600_000), to, importFirst: true });
}
