// Route health, stored in Redis, at TWO levels:
//   (gateway, method)        e.g. "mockpay-a:bank_transfer"
//   (gateway, method, bank)  e.g. "mockpay-a:bank_transfer:058"  (GTBank)
//
// Why per METHOD: a NIBSS outage takes bank transfers down on every gateway at
// once while cards keep working. Why per BANK: often a single bank is having a
// bad day; we want to avoid "GTBank via mockpay-a" without abandoning mockpay-a
// for everyone else.
//
// For every route we keep two kinds of evidence (so either routing strategy can
// be switched on, and the dashboard can show both):
//  1. Circuit breaker: a rolling window of the last N outcomes plus a state
//     (healthy / degraded / probing). The RULES live in @po/routing (pure
//     functions) and are shared with the routing lab, so the lab measures
//     exactly what production runs.
//  2. Thompson sampling: success/failure counts that decay with a half-life.
import type { PaymentMethod, RouteState } from '@po/shared';
import {
  addOutcome,
  decay,
  emptyCounts,
  initialBreaker,
  recordOutcome,
  tickBreaker,
  type BreakerConfig,
  type BreakerState,
  type DecayedCounts,
} from '@po/routing';
import type { Redis } from 'ioredis';
import type { Env } from '../../lib/env';

export interface RouteKey {
  gateway: string;
  method: PaymentMethod;
  bankCode?: string | null;
}

export interface RouteHealth {
  gateway: string;
  method: PaymentMethod;
  bankCode: string | null;
  state: RouteState;
  samples: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  degradedUntil: string | null;
  probeSuccesses: number;
  lastChange: string | null;
  reason: string | null;
  /** Thompson-sampling evidence (decayed), for display. */
  decayed: { successes: number; failures: number };
}

type HealthConfig = Pick<
  Env,
  | 'ROUTING_WINDOW_SIZE'
  | 'ROUTING_MIN_SAMPLES'
  | 'ROUTING_MIN_SUCCESS_RATE'
  | 'ROUTING_COOLDOWN_MS'
  | 'ROUTING_PROBE_SUCCESSES'
  | 'ROUTING_TS_HALF_LIFE_MS'
>;

const PREFIX = 'po:health';
const ROUTES_SET = `${PREFIX}:routes`;
export const routeId = (k: RouteKey) => (k.bankCode ? `${k.gateway}:${k.method}:${k.bankCode}` : `${k.gateway}:${k.method}`);
const windowKey = (id: string) => `${PREFIX}:${id}:window`;
const stateKey = (id: string) => `${PREFIX}:${id}:state`;
const countsKey = (id: string) => `${PREFIX}:${id}:ts`;

export function parseRouteId(id: string): RouteKey {
  const [gateway, method, bankCode] = id.split(':');
  return { gateway: gateway!, method: method as PaymentMethod, bankCode: bankCode ?? null };
}

export class HealthTracker {
  private readonly breaker: BreakerConfig;

  constructor(
    private readonly redis: Redis,
    private readonly config: HealthConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.breaker = {
      minSamples: config.ROUTING_MIN_SAMPLES,
      minSuccessRate: config.ROUTING_MIN_SUCCESS_RATE,
      cooldownMs: config.ROUTING_COOLDOWN_MS,
      probeSuccesses: config.ROUTING_PROBE_SUCCESSES,
    };
  }

  // ---------- breaker state ----------

  private async readBreaker(id: string): Promise<BreakerState> {
    const raw = await this.redis.hgetall(stateKey(id));
    const stored: BreakerState = raw.state
      ? {
          state: raw.state as RouteState,
          until: raw.until ? Number(raw.until) : null,
          probeOk: Number(raw.probeOk ?? 0),
          changedAt: raw.changedAt ? Number(raw.changedAt) : null,
          reason: raw.reason ?? null,
        }
      : initialBreaker();
    // Cooldown over? The shared rule turns degraded into probing (half-open).
    const ticked = tickBreaker(stored, this.now());
    if (ticked !== stored) await this.writeBreaker(id, ticked);
    return ticked;
  }

  private async writeBreaker(id: string, s: BreakerState) {
    const fields: Record<string, string> = { state: s.state, probeOk: String(s.probeOk) };
    if (s.until !== null) fields.until = String(s.until);
    if (s.changedAt !== null) fields.changedAt = String(s.changedAt);
    if (s.reason !== null) fields.reason = s.reason;
    await this.redis.multi().del(stateKey(id)).hset(stateKey(id), fields).exec();
  }

  private async window(id: string) {
    const entries = await this.redis.lrange(windowKey(id), 0, -1);
    const parsed = entries.map((e) => {
      const [ok, latency] = e.split(':');
      return { ok: ok === '1', latency: Number(latency) };
    });
    const samples = parsed.length;
    const successes = parsed.filter((p) => p.ok).length;
    return {
      samples,
      successRate: samples ? successes / samples : null,
      avgLatencyMs: samples ? Math.round(parsed.reduce((s, p) => s + p.latency, 0) / samples) : null,
    };
  }

  // ---------- decayed counts (Thompson sampling) ----------

  async counts(key: RouteKey): Promise<DecayedCounts> {
    const raw = await this.redis.hgetall(countsKey(routeId(key)));
    const stored = raw.t ? { s: Number(raw.s), f: Number(raw.f), t: Number(raw.t) } : emptyCounts(this.now());
    return decay(stored, this.now(), this.config.ROUTING_TS_HALF_LIFE_MS);
  }

  // ---------- public API ----------

  /** Records one outcome at ONE level (the caller decides which levels a result counts for). */
  async record(gateway: string, method: PaymentMethod, ok: boolean, latencyMs: number, bankCode?: string | null): Promise<void> {
    const key: RouteKey = { gateway, method, bankCode: bankCode ?? null };
    const id = routeId(key);
    const now = this.now();

    await this.redis
      .multi()
      .sadd(ROUTES_SET, id)
      .lpush(windowKey(id), `${ok ? 1 : 0}:${Math.round(latencyMs)}`)
      .ltrim(windowKey(id), 0, this.config.ROUTING_WINDOW_SIZE - 1)
      .exec();

    const current = await this.readBreaker(id);
    const update = recordOutcome(current, ok, await this.window(id), this.breaker, now);
    if (update.clearWindow) await this.redis.del(windowKey(id));
    if (update.state !== current) await this.writeBreaker(id, update.state);

    const c = addOutcome(await this.counts(key), ok, now, this.config.ROUTING_TS_HALF_LIFE_MS);
    await this.redis.hset(countsKey(id), { s: String(c.s), f: String(c.f), t: String(c.t) });
  }

  async health(gateway: string, method: PaymentMethod, bankCode?: string | null): Promise<RouteHealth> {
    const key: RouteKey = { gateway, method, bankCode: bankCode ?? null };
    const id = routeId(key);
    const s = await this.readBreaker(id);
    const w = await this.window(id);
    const c = await this.counts(key);
    return {
      gateway,
      method,
      bankCode: key.bankCode ?? null,
      state: s.state,
      samples: w.samples,
      successRate: w.successRate,
      avgLatencyMs: w.avgLatencyMs,
      degradedUntil: s.state === 'degraded' && s.until ? new Date(s.until).toISOString() : null,
      probeSuccesses: s.probeOk,
      lastChange: s.changedAt ? new Date(s.changedAt).toISOString() : null,
      reason: s.reason,
      decayed: { successes: Number(c.s.toFixed(2)), failures: Number(c.f.toFixed(2)) },
    };
  }

  /** Every route that has ever recorded an outcome (including bank-level ones). */
  async knownRoutes(): Promise<RouteKey[]> {
    return (await this.redis.smembers(ROUTES_SET)).map(parseRouteId);
  }

  /** Forget everything (used by the simulator's reset button and tests). */
  async reset(): Promise<void> {
    const keys = await this.redis.keys(`${PREFIX}:*`);
    if (keys.length) await this.redis.del(...keys);
  }
}
