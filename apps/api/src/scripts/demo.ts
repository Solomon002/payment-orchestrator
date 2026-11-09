// `pnpm demo`: a scripted end-to-end tour of every pattern in the project.
//
// It starts its own API + worker + two mock gateways in this process, against a
// separate scratch database (payments_demo) and Redis DB 2, so it never touches
// your dev data and works whether or not `pnpm dev` is running.
// Only Postgres and Redis (docker compose) need to be up.
import { formatNaira } from '@po/shared';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pino from 'pino';
import { startHarness, waitFor, type Harness } from '../dev/stack';
import { env } from '../lib/env';
import { koboToNumber } from '../lib/money';
import { accountCode } from '../modules/ledger/accounts';
import { accountBalance, ledgerTotal } from '../modules/ledger/ledger.service';
import { createMerchant } from '../modules/merchants/merchant.service';
import { runReconciliation } from '../modules/reconciliation/reconciliation.service';
import { MockGatewayAdapter } from '../modules/gateways/mock.adapter';
import { HealthAwareRouter } from '../modules/routing/health.router';
import { pollPendingPayments } from '../queues/poller';

const base = env();
const demoDbUrl = base.DATABASE_URL.replace(/\/payments(\?|$)/, '/payments_demo$1');
const demoRedisUrl = base.REDIS_URL.replace(/\/\d+$/, '/2');

const results: { scenario: string; result: string; ok: boolean }[] = [];
const step = (msg: string) => console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
const note = (msg: string) => console.log(`  ${msg}`);
function record(scenario: string, ok: boolean, result: string) {
  results.push({ scenario, ok, result });
  console.log(`  ${ok ? '\x1b[32m✔' : '\x1b[31m✘'} ${result}\x1b[0m`);
}

async function prepareDatabase() {
  // Create the scratch database if needed, apply migrations, and empty it.
  const admin = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });
  const exists = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = 'payments_demo'`;
  if (exists.length === 0) await admin.$executeRawUnsafe('CREATE DATABASE payments_demo');
  await admin.$disconnect();
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, DATABASE_URL: demoDbUrl },
    stdio: 'pipe',
  });
  const db = new PrismaClient({ datasources: { db: { url: demoDbUrl } } });
  await db.$executeRawUnsafe(`TRUNCATE postings, journal_entries, withdrawals, payment_attempts, payments, accounts, merchants,
    idempotency_keys, webhook_events, gateway_settlements, discrepancies, reconciliation_runs RESTART IDENTITY CASCADE`);
  await db.$disconnect();
}

async function main() {
  console.log('\nMulti-Rail Payment Orchestrator: scripted demo (test mode, mock gateways, no real money)');
  await prepareDatabase();

  const h: Harness = await startHarness({
    config: {
      ...base,
      DATABASE_URL: demoDbUrl,
      REDIS_URL: demoRedisUrl,
      LOG_LEVEL: 'silent',
      ROUTING_MIN_SAMPLES: 3,
      ROUTING_COOLDOWN_MS: 5_000,
      PENDING_POLL_AFTER_MS: 0,
      RATE_LIMIT_GLOBAL_PER_MIN: 100_000,
      RATE_LIMIT_MONEY_PER_MIN: 100_000,
    },
    log: pino({ level: 'silent' }),
    router: 'health',
  });
  const { ctx } = h;
  await (ctx.router as HealthAwareRouter).tracker.reset();

  try {
    const { merchant, apiKey } = await createMerchant(ctx.prisma, 'Demo Store');
    const pay = async (method: 'card' | 'bank_transfer', amountKobo = 500_000, bankCode?: string) => {
      const res = await fetch(`${h.url}/v1/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ amountKobo, method, reference: `order-${randomUUID().slice(0, 8)}`, customerEmail: 'ada@example.com', ...(bankCode ? { bankCode } : {}) }),
      });
      return { status: res.status, body: (await res.json()) as { payment?: { id: string; reference: string; gateway: string }; error?: { code: string; message: string; details?: { alternatives?: string[] } } } };
    };
    const statusOf = async (id: string) => (await ctx.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
    const merchantBalance = async () => {
      const acc = await ctx.prisma.account.findUniqueOrThrow({ where: { code: accountCode.merchantBalance(merchant.id) } });
      return accountBalance(ctx.prisma, acc.id);
    };

    // 1. Happy path
    step('1. Normal card payment of NGN 5,000');
    const p1 = await pay('card');
    note(`API answered ${p1.status}, payment is "pending" on ${p1.body.payment?.gateway}; waiting for the webhook...`);
    await waitFor(async () => (await statusOf(p1.body.payment!.id)) === 'succeeded');
    const bal1 = await merchantBalance();
    note(`Webhook verified with the gateway; merchant credited ${formatNaira(koboToNumber(bal1))} (NGN 5,000 minus 1.5% platform fee)`);
    record('Normal payment', bal1 === 492_500n, `succeeded, merchant balance ${formatNaira(koboToNumber(bal1))}`);

    // 2. Duplicate webhooks
    step('2. Gateway sends every webhook THREE times (same event id)');
    for (const gw of Object.values(h.mocks)) gw.control.webhookMode = 'duplicate';
    const p2 = await pay('card');
    await waitFor(async () => (await statusOf(p2.body.payment!.id)) === 'succeeded');
    const ev = await waitFor(async () => {
      const e = await ctx.prisma.webhookEvent.findFirst({ where: { reference: p2.body.payment!.reference } });
      return e && e.duplicateCount >= 2 ? e : undefined;
    });
    const entries = await ctx.prisma.journalEntry.count({ where: { reference: `payment:${p2.body.payment!.id}:succeeded` } });
    record('Duplicate webhook', entries === 1, `3 deliveries -> 1 stored event (${ev.duplicateCount} duplicates ignored), money posted ${entries} time`);
    for (const gw of Object.values(h.mocks)) gw.control.webhookMode = 'normal';

    // 3a. One gateway down
    step('3a. mockpay-a starts failing every request (HTTP 503)');
    h.mocks['mockpay-a'].control.failureRate = 100;
    const tracker = (ctx.router as HealthAwareRouter).tracker;
    const routed: string[] = [];
    // Keep paying until the breaker has seen enough failures to trip (order varies under the hybrid strategy).
    while (routed.length < 15 && (await tracker.health('mockpay-a', 'card')).state !== 'degraded') {
      routed.push((await pay('card')).body.payment?.gateway ?? 'none');
    }
    const aState = (await tracker.health('mockpay-a', 'card')).state;
    note(`${routed.length} card payments routed to: ${routed.join(', ')}; mockpay-a/card is now "${aState}"`);
    record('Gateway failover', routed.every((g) => g === 'mockpay-b') && aState === 'degraded', `all traffic failed over to mockpay-b; mockpay-a card route ${aState}`);
    h.mocks['mockpay-a'].control.failureRate = 0;

    // 3b. NIBSS-style outage
    step('3b. NIBSS-style outage: bank_transfer down on EVERY gateway, cards fine');
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = true;
    h.mocks['mockpay-b'].control.methodOutages.bank_transfer = true;
    for (let i = 0; i < 3; i++) await pay('bank_transfer');
    const bank = await pay('bank_transfer');
    const card = await pay('card');
    note(`bank_transfer -> ${bank.status} ${bank.body.error?.code}: "${bank.body.error?.message}"`);
    note(`card -> ${card.status} via ${card.body.payment?.gateway}`);
    record(
      'Per-method outage',
      bank.status === 503 && (bank.body.error?.details?.alternatives ?? []).includes('card') && card.status === 201,
      'bank_transfer refused fast with "try card"; card payments unaffected',
    );
    h.mocks['mockpay-a'].control.methodOutages.bank_transfer = false;
    h.mocks['mockpay-b'].control.methodOutages.bank_transfer = false;

    // 3c. One bank failing on one gateway
    step('3c. GTBank (058) transfers fail on mockpay-a only; other banks and gateways are fine');
    await tracker.reset(); // start from clean routing health (3b left the transfer routes degraded)
    h.mocks['mockpay-a'].control.bankOutages = ['058'];
    const gtb: number[] = [];
    while (gtb.length < 15 && (await tracker.health('mockpay-a', 'bank_transfer', '058')).state !== 'degraded') {
      gtb.push((await pay('bank_transfer', 500_000, '058')).status);
    }
    const bankRoute = (await tracker.health('mockpay-a', 'bank_transfer', '058')).state;
    const gatewayRoute = (await tracker.health('mockpay-a', 'bank_transfer')).state;
    const zenith = await pay('bank_transfer', 500_000, '057');
    note(`${gtb.length} GTBank transfers: all ${gtb.every((s) => s === 201) ? 'succeeded (failed over)' : 'NOT all succeeded'}`);
    note(`mockpay-a + GTBank route: "${bankRoute}"; mockpay-a + bank_transfer for everyone else: "${gatewayRoute}"; a Zenith transfer -> ${zenith.status}`);
    record(
      'Bank-level health',
      gtb.every((s) => s === 201) && bankRoute === 'degraded' && gatewayRoute === 'healthy' && zenith.status === 201,
      'only the GTBank route on mockpay-a was cut off; the gateway stayed healthy for other banks',
    );
    h.mocks['mockpay-a'].control.bankOutages = [];

    // 4. Dropped webhook
    step('4. Webhook is never delivered (dropped)');
    for (const gw of Object.values(h.mocks)) gw.control.webhookMode = 'drop';
    const p4 = await pay('card');
    const gw4 = h.mocks[p4.body.payment!.gateway as 'mockpay-a'];
    await waitFor(async () => gw4.charges.get(p4.body.payment!.reference)?.status === 'succeeded');
    note(`Gateway charged the customer, but we were never told: our status is "${await statusOf(p4.body.payment!.id)}"`);
    const poll = await pollPendingPayments(ctx);
    const s4 = await statusOf(p4.body.payment!.id);
    note(`Poller checked ${poll.checked} pending payment(s) with the gateway's verify API`);
    record('Dropped webhook', s4 === 'succeeded', `recovered by polling fallback -> ${s4}`);
    for (const gw of Object.values(h.mocks)) gw.control.webhookMode = 'normal';

    // 5. Reconciliation
    step('5. Nightly reconciliation, with a tampered settlement report');
    const victim = p1.body.payment!;
    await fetch(`${(ctx.gateways.require(victim.gateway) as MockGatewayAdapter).baseUrl}/control/settlements/tamper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-key': base.MOCK_CONTROL_KEY },
      body: JSON.stringify({ reference: victim.reference, amountKobo: 450_000 }),
    });
    note(`${victim.gateway} now reports ${victim.reference.slice(0, 16)}... as NGN 4,500 instead of NGN 5,000`);
    const run = await runReconciliation(ctx);
    const totals = run.totals as { matched: number; discrepancies: number };
    const mismatch = run.discrepancies.find((d) => d.type === 'amount_mismatch');
    note(`Run: ${totals.matched} matched, ${totals.discrepancies} discrepancy(ies): ${run.discrepancies.map((d) => d.type).join(', ')}`);
    record('Reconciliation', run.discrepancies.length === 1 && mismatch?.gatewayReference === victim.reference, 'amount_mismatch caught for the tampered settlement');

    // Ledger integrity
    step('Ledger integrity check');
    const total = await ledgerTotal(ctx.prisma);
    record('Ledger balanced', total === 0n, `sum of every posting ever written = ${total} kobo`);
  } finally {
    await h.close();
  }

  console.log('\n\x1b[1mSummary\x1b[0m');
  console.table(results.map((r) => ({ scenario: r.scenario, result: r.result, pass: r.ok ? 'PASS' : 'FAIL' })));
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\x1b[32mAll scenarios passed.\x1b[0m' : `\x1b[31m${failed} scenario(s) failed.\x1b[0m`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
