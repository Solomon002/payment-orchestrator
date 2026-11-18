// PUBLIC DEMO MODE: a shared, self-resetting sandbox for visitors.
//
// - Visitors get a temporary DEMO SESSION (a random token kept in Redis with a
//   TTL), not the owner's admin key.
// - A demo session may read everything but only make the changes on an
//   allow-list (break/fix the mock gateways, fire test payments, run the poller
//   and reconciliation). Enforced on the server by demoPolicy.
// - Quotas stop one visitor (or all of them together) from flooding the
//   database, and every DEMO_RESET_INTERVAL_MS the whole sandbox is wiped and
//   reseeded, so a visitor who breaks things only breaks them for a while.
// Everything here is inert unless PUBLIC_DEMO=true.
import { randomBytes } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { AppContext } from '../../context';
import { sha256Hex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { MockGatewayAdapter } from '../gateways/mock.adapter';
import { seedDemoMerchant } from '../merchants/merchant.service';

export const DEMO_TOKEN_PREFIX = 'demo_';
/** Most simulated payments a demo visitor can send in one click. */
export const DEMO_MAX_PAYMENTS_PER_REQUEST = 20;

const KEY = {
  session: (hash: string) => `po:demo:session:${hash}`,
  actions: (hash: string, minute: number) => `po:demo:actions:${hash}:${minute}`,
  sessionQuota: (hash: string, hour: number) => `po:demo:quota:session:${hash}:${hour}`,
  globalQuota: (hour: number) => `po:demo:quota:global:${hour}`,
  nextReset: 'po:demo:next-reset',
};

export interface DemoSession {
  hash: string;
  expiresAt: string;
}

/** Creates a demo session. Only the token's SHA-256 is stored, like merchant API keys. */
export async function createDemoSession(ctx: AppContext) {
  const token = `${DEMO_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(Date.now() + ctx.config.DEMO_SESSION_TTL_MS).toISOString();
  await ctx.redis.set(KEY.session(sha256Hex(token)), JSON.stringify({ expiresAt }), 'PX', ctx.config.DEMO_SESSION_TTL_MS);
  return { token, expiresAt };
}

export async function getDemoSession(ctx: AppContext, token: string): Promise<DemoSession | null> {
  if (!ctx.config.PUBLIC_DEMO || !token.startsWith(DEMO_TOKEN_PREFIX) || token.length > 100) return null;
  const hash = sha256Hex(token);
  const raw = await ctx.redis.get(KEY.session(hash));
  if (!raw) return null;
  return { hash, expiresAt: (JSON.parse(raw) as { expiresAt: string }).expiresAt };
}

export async function nextResetAt(ctx: AppContext): Promise<string | null> {
  const v = await ctx.redis.get(KEY.nextReset);
  return v ? new Date(Number(v)).toISOString() : null;
}

// ---------- permissions ----------

/** The ONLY changes a demo session may make (paths relative to /admin). Everything else is denied. */
const DEMO_ALLOWED_WRITES: RegExp[] = [
  /^\/simulator\/gateways\/[a-z0-9-]+\/control$/,
  /^\/simulator\/gateways\/[a-z0-9-]+\/reset$/,
  /^\/simulator\/gateways\/[a-z0-9-]+\/settlements\/(tamper|omit|phantom)$/,
  /^\/simulator\/payments$/,
  /^\/simulator\/poll$/,
  /^\/routing\/reset$/,
  /^\/reconciliation\/run$/,
  /^\/reconciliation\/import$/,
];

export const demoSessionOf = (res: Response) => res.locals.demoSession as DemoSession | undefined;

/**
 * Runs after adminAuth. Owners pass straight through. Demo sessions may read
 * anything, may only make allow-listed changes, and only so many per minute.
 */
export function demoPolicy(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const session = demoSessionOf(res);
    if (!session || req.method === 'GET' || req.method === 'HEAD') return next();
    if (!DEMO_ALLOWED_WRITES.some((re) => re.test(req.path))) {
      throw new AppError(403, 'FORBIDDEN_IN_DEMO', 'This action is not available in the public demo');
    }
    const minute = Math.floor(Date.now() / 60_000);
    const key = KEY.actions(session.hash, minute);
    const used = await ctx.redis.incr(key);
    if (used === 1) await ctx.redis.expire(key, 120);
    if (used > ctx.config.DEMO_ACTIONS_PER_MIN) {
      throw new AppError(429, 'DEMO_RATE_LIMITED', 'Too many changes in a minute; slow down a little');
    }
    next();
  };
}

/**
 * Reserves `count` simulated payments against the visitor's hourly quota and
 * the global hourly quota. INCRBY is atomic, so concurrent visitors can't both
 * squeeze past the limit; an over-limit reservation is handed back.
 */
export async function consumeDemoPaymentQuota(ctx: AppContext, session: DemoSession, count: number) {
  if (count > DEMO_MAX_PAYMENTS_PER_REQUEST) {
    throw new AppError(400, 'DEMO_LIMIT', `The public demo sends at most ${DEMO_MAX_PAYMENTS_PER_REQUEST} payments at a time`);
  }
  const hour = Math.floor(Date.now() / 3_600_000);
  const reserve = async (key: string, limit: number, message: string) => {
    const used = await ctx.redis.incrby(key, count);
    if (used === count) await ctx.redis.expire(key, 7_200);
    if (used > limit) {
      await ctx.redis.decrby(key, count);
      throw new AppError(429, 'DEMO_QUOTA', message);
    }
  };
  await reserve(KEY.sessionQuota(session.hash, hour), ctx.config.DEMO_PAYMENTS_PER_SESSION_PER_HOUR, 'You have used this hour\'s demo payment allowance. It refreshes on the hour.');
  try {
    await reserve(KEY.globalQuota(hour), ctx.config.DEMO_PAYMENTS_GLOBAL_PER_HOUR, 'The demo is busy right now (hourly limit for all visitors reached). Please try again later.');
  } catch (err) {
    await ctx.redis.decrby(KEY.sessionQuota(session.hash, hour), count); // give the visitor's share back
    throw err;
  }
}

// ---------- hourly reset ----------

const TABLES =
  'postings, journal_entries, withdrawals, payment_attempts, payments, accounts, merchants, idempotency_keys, ' +
  'webhook_events, gateway_settlements, discrepancies, reconciliation_runs';

/**
 * Wipes the sandbox back to a clean state: mock gateways reset and emptied,
 * every table truncated (TRUNCATE bypasses the ledger's append-only row
 * triggers, which is why it is only ever allowed in demo mode), routing health
 * and queued webhook jobs cleared, and the demo merchant reseeded.
 * Demo sessions are kept, so visitors aren't logged out.
 */
export async function resetDemo(ctx: AppContext) {
  if (!ctx.config.PUBLIC_DEMO) throw new Error('resetDemo refused: PUBLIC_DEMO is not enabled');

  for (const adapter of ctx.gateways.list()) {
    if (!(adapter instanceof MockGatewayAdapter)) continue;
    for (const path of ['/control/reset', '/control/clear']) {
      await fetch(`${adapter.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-control-key': ctx.config.MOCK_CONTROL_KEY },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      }).catch((err: unknown) => ctx.log.warn({ err, gateway: adapter.name }, 'demo reset: mock gateway unreachable'));
    }
  }

  await ctx.queues.webhooks.drain(true);

  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
      break;
    } catch (err) {
      // A webhook may still be settling; TRUNCATE needs an exclusive lock (deadlock 40P01). Retry.
      if (attempt >= 10 || !String(err).includes('40P01')) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const routing = await ctx.redis.keys('po:health:*');
  if (routing.length) await ctx.redis.del(...routing);

  await seedDemoMerchant(ctx.prisma, ctx.config.DEMO_MERCHANT_API_KEY);
  await ctx.redis.set(KEY.nextReset, String(Date.now() + ctx.config.DEMO_RESET_INTERVAL_MS));
  ctx.log.info('public demo reset complete');
}

/** Called when the worker starts, so visitors see a countdown before the first reset. */
export async function initDemoSchedule(ctx: AppContext) {
  await ctx.redis.set(KEY.nextReset, String(Date.now() + ctx.config.DEMO_RESET_INTERVAL_MS), 'NX');
}
