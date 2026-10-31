// Concurrency demo: fires 50 simultaneous withdrawals at a merchant who can only
// afford 10 of them, first against the NAIVE endpoint, then against the SAFE one.
//
//   pnpm demo:concurrency
//
// It starts its own copy of the API on a random port, so nothing else needs to
// be running except Postgres and Redis (docker compose).
import autocannon from 'autocannon';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { formatNaira } from '@po/shared';
import { createApp } from '../app';
import { closeContext, createContext } from '../context';
import { env } from '../lib/env';
import { koboToNumber } from '../lib/money';
import { createMerchant, topUpMerchant } from '../modules/merchants/merchant.service';
import { merchantBalances } from '../modules/withdrawals/withdrawal.service';

const REQUESTS = 50;
const STARTING_BALANCE = 1_000_000n; // NGN 10,000
const WITHDRAWAL = 100_000; // NGN 1,000 -> at most 10 can succeed

const config = {
  ...env(),
  LOG_LEVEL: 'silent' as const,
  ENABLE_NAIVE_ENDPOINTS: true,
  RATE_LIMIT_GLOBAL_PER_MIN: 100_000,
  RATE_LIMIT_MONEY_PER_MIN: 100_000,
};
const { default: pino } = await import('pino');
const ctx = createContext({ config, log: pino({ level: 'silent' }) });
const server = createApp(ctx).listen(0);
const port = (server.address() as AddressInfo).port;

async function freshMerchant(label: string) {
  const { merchant, apiKey } = await createMerchant(ctx.prisma, `Concurrency demo (${label}) ${new Date().toISOString()}`);
  await topUpMerchant(ctx.prisma, merchant.id, STARTING_BALANCE, `demo:topup:${merchant.id}`);
  return { merchant, apiKey };
}

async function fire(path: string, apiKey: string, idempotencyKey: () => string | undefined) {
  const result = await autocannon({
    url: `http://localhost:${port}${path}`,
    method: 'POST',
    connections: REQUESTS, // 50 sockets open at once...
    amount: REQUESTS, // ...each sending exactly one request
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ amountKobo: WITHDRAWAL }),
    requests: [
      {
        setupRequest: (req) => {
          const key = idempotencyKey();
          return key ? { ...req, headers: { ...req.headers, 'idempotency-key': key } } : req;
        },
      },
    ],
  });
  return { ok: result['2xx'], rejected: result.non2xx, errors: result.errors };
}

async function round(label: string, path: string, keyFn: () => string | undefined) {
  const { merchant, apiKey } = await freshMerchant(label);
  const outcome = await fire(path, apiKey, keyFn);
  const balance = await merchantBalances(ctx, merchant.id);
  const withdrawn = await ctx.prisma.withdrawal.aggregate({
    where: { merchantId: merchant.id },
    _sum: { amountKobo: true },
    _count: true,
  });
  return {
    label,
    succeeded: outcome.ok,
    rejected: outcome.rejected,
    withdrawals: withdrawn._count,
    withdrawn: formatNaira(koboToNumber(withdrawn._sum.amountKobo ?? 0n)),
    finalBalance: formatNaira(koboToNumber(balance.availableKobo)),
    negative: balance.availableKobo < 0n,
  };
}

try {
  console.log(`\nMerchant balance ${formatNaira(Number(STARTING_BALANCE))}; ${REQUESTS} simultaneous withdrawals of ${formatNaira(WITHDRAWAL)} each.`);
  console.log(`At most ${Number(STARTING_BALANCE) / WITHDRAWAL} can legitimately succeed.\n`);

  const naive = await round('NAIVE (no lock)', '/v1/withdrawals/naive', () => undefined);
  const safe = await round('SAFE (FOR UPDATE + idempotency)', '/v1/withdrawals', () => randomUUID());
  const sameKey = `same-key-${randomUUID()}`;
  const replay = await round('SAFE, all 50 reuse ONE key', '/v1/withdrawals', () => sameKey);

  console.table([naive, safe, replay]);

  const pass = !safe.negative && safe.withdrawals === 10 && replay.withdrawals === 1;
  console.log(naive.negative ? 'NAIVE: double-spend reproduced, balance went negative.' : 'NAIVE: race not reproduced this run (try again or raise RACE_WINDOW_MS).');
  console.log(pass ? 'SAFE: exactly 10 withdrawals, balance never negative. One key = one withdrawal.' : 'SAFE: UNEXPECTED RESULT, investigate!');
  process.exitCode = pass ? 0 : 1;
} finally {
  server.close();
  await closeContext(ctx);
}
