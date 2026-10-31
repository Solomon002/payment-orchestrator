// Brings gateway settlement data into our database: either pulled from a
// gateway's API, or uploaded as a CSV file (for gateways without an API).
import { settlementRowSchema, type SettlementRow } from '@po/shared';
import type { AppContext } from '../../context';
import { badRequest } from '../../lib/errors';

export const CSV_HEADER = 'gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id';
export const MAX_CSV_ROWS = 5_000;

async function upsertSettlements(ctx: AppContext, gateway: string, rows: SettlementRow[], source: string) {
  for (const r of rows) {
    // Upsert, not insert: a gateway may re-export a corrected report, and the
    // latest version of the truth is what we reconcile against.
    await ctx.prisma.gatewaySettlement.upsert({
      where: { gateway_reference: { gateway, reference: r.reference } },
      create: {
        gateway,
        reference: r.reference,
        amountKobo: BigInt(r.amountKobo),
        feeKobo: BigInt(r.feeKobo),
        settledAt: new Date(r.settledAt),
        batchId: r.batchId,
        source,
      },
      update: {
        amountKobo: BigInt(r.amountKobo),
        feeKobo: BigInt(r.feeKobo),
        settledAt: new Date(r.settledAt),
        batchId: r.batchId,
        source,
        importedAt: new Date(),
      },
    });
  }
  return rows.length;
}

/** Pulls settlements from every gateway that has a settlement API. */
export async function importSettlementsFromGateways(ctx: AppContext) {
  const result: Record<string, number | string> = {};
  for (const adapter of ctx.gateways.list()) {
    try {
      const rows = await adapter.fetchSettlements();
      result[adapter.name] = rows === null ? 'no settlement API (use CSV upload)' : await upsertSettlements(ctx, adapter.name, rows, 'api_import');
    } catch (err) {
      result[adapter.name] = `error: ${(err as Error).message}`;
      ctx.log.warn({ gateway: adapter.name, err: (err as Error).message }, 'settlement import failed');
    }
  }
  return result;
}

/**
 * Parses a settlement CSV with the header:
 *   gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id
 * Deliberately simple: no quoted fields, because our references and batch ids
 * never contain commas. Every row is validated; one bad row rejects the file.
 */
export function parseSettlementCsv(text: string): Array<SettlementRow & { gateway: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== CSV_HEADER) throw badRequest(`CSV header must be exactly: ${CSV_HEADER}`);
  const body = lines.slice(1);
  if (body.length > MAX_CSV_ROWS) throw badRequest(`CSV has more than ${MAX_CSV_ROWS} rows`);

  return body.map((line, i) => {
    const cells = line.split(',');
    if (cells.length !== 6) throw badRequest(`Row ${i + 2}: expected 6 columns, got ${cells.length}`);
    const [gateway, reference, amount, fee, settledAt, batchId] = cells as [string, string, string, string, string, string];
    if (!/^\d+$/.test(amount) || !/^\d+$/.test(fee)) throw badRequest(`Row ${i + 2}: amounts must be whole kobo`);
    if (Number.isNaN(Date.parse(settledAt))) throw badRequest(`Row ${i + 2}: invalid settled_at`);
    const row = settlementRowSchema.safeParse({
      reference,
      amountKobo: Number(amount),
      feeKobo: Number(fee),
      settledAt,
      batchId,
    });
    if (!row.success || !/^[a-z0-9-]{2,50}$/.test(gateway)) throw badRequest(`Row ${i + 2}: invalid values`);
    return { ...row.data, gateway };
  });
}

export async function importSettlementCsv(ctx: AppContext, text: string) {
  const rows = parseSettlementCsv(text);
  const byGateway = new Map<string, SettlementRow[]>();
  for (const { gateway, ...row } of rows) byGateway.set(gateway, [...(byGateway.get(gateway) ?? []), row]);
  const result: Record<string, number> = {};
  for (const [gateway, list] of byGateway) result[gateway] = await upsertSettlements(ctx, gateway, list, 'csv_upload');
  return result;
}
