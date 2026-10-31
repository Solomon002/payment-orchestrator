// Health tracking per (gateway, payment method), stored in Redis.
//
// Why per METHOD and not just per gateway: a NIBSS outage takes bank transfers
// down on every gateway at once while cards keep working. Tracking only "is
// mockpay-a healthy?" would either kill card payments needlessly or keep
// sending bank transfers into a black hole.
//
// Each (gateway, method) pair is a small CIRCUIT BREAKER, like the one in your
// house's fuse box:
//   healthy  --(success rate < threshold over >= MIN_SAMPLES calls)-->  degraded
//   degraded --(cooldown elapsed)-->                                     probing
//   probing  --(PROBE_SUCCESSES successes in a row)-->                   healthy
//   probing  --(any failure)-->                                          degraded (new cooldown)
// The minimum sample size, the cooldown and the consecutive-probe requirement
// are what stop it FLIP-FLOPPING between states on every random blip.
import type { PaymentMethod, RouteState } from '@po/shared';
import type { Redis } from 'ioredis';
import type { Env } from '../../lib/env';

export interface RouteHealth {
  gateway: string;
  method: PaymentMethod;
  state: RouteState;
  samples: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  degradedUntil: string | null;
  probeSuccesses: number;
  lastChange: string | null;
  reason: string | null;
}

type HealthConfig = Pick<
  Env,
  'ROUTING_WINDOW_SIZE' | 'ROUTING_MIN_SAMPLES' | 'ROUTING_MIN_SUCCESS_RATE' | 'ROUTING_COOLDOWN_MS' | 'ROUTING_PROBE_SUCCESSES'
>;

const PREFIX = 'po:health';
const windowKey = (g: string, m: string) => `${PREFIX}:${g}:${m}:window`;
const stateKey = (g: string, m: string) => `${PREFIX}:${g}:${m}:state`;

export class HealthTracker {
  constructor(
    private readonly redis: Redis,
    private readonly config: HealthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private async readState(gateway: string, method: string) {
    const raw = await this.redis.hgetall(stateKey(gateway, method));
    let state = (raw.state as RouteState | undefined) ?? 'healthy';
    const until = raw.until ? Number(raw.until) : null;
    // Cooldown over: let a little traffic through to test the water (half-open).
    if (state === 'degraded' && until !== null && this.now() >= until) {
      state = 'probing';
      await this.setState(gateway, method, 'probing', 'cooldown elapsed, probing');
    }
    return {
      state,
      until,
      probeOk: Number(raw.probeOk ?? 0),
      changedAt: raw.changedAt ? Number(raw.changedAt) : null,
      reason: raw.reason ?? null,
    };
  }

  private async setState(gateway: string, method: string, state: RouteState, reason: string, until?: number) {
    const key = stateKey(gateway, method);
    await this.redis
      .multi()
      .del(key)
      .hset(key, {
        state,
        reason,
        changedAt: String(this.now()),
        probeOk: '0',
        ...(until !== undefined ? { until: String(until) } : {}),
      })
      .exec();
  }

  private async window(gateway: string, method: string) {
    const entries = await this.redis.lrange(windowKey(gateway, method), 0, -1);
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

  async record(gateway: string, method: PaymentMethod, ok: boolean, latencyMs: number): Promise<void> {
    const current = await this.readState(gateway, method);
    await this.redis
      .multi()
      .lpush(windowKey(gateway, method), `${ok ? 1 : 0}:${Math.round(latencyMs)}`)
      .ltrim(windowKey(gateway, method), 0, this.config.ROUTING_WINDOW_SIZE - 1)
      .exec();

    if (current.state === 'probing') {
      if (!ok) {
        await this.trip(gateway, method, 'probe failed');
        return;
      }
      const probeOk = await this.redis.hincrby(stateKey(gateway, method), 'probeOk', 1);
      if (probeOk >= this.config.ROUTING_PROBE_SUCCESSES) {
        await this.redis.del(windowKey(gateway, method)); // judge the recovered route on fresh data
        await this.setState(gateway, method, 'healthy', `${probeOk} successful probes`);
      }
      return;
    }

    if (current.state === 'healthy') {
      const w = await this.window(gateway, method);
      if (w.samples >= this.config.ROUTING_MIN_SAMPLES && (w.successRate ?? 1) < this.config.ROUTING_MIN_SUCCESS_RATE) {
        await this.trip(gateway, method, `success rate ${Math.round((w.successRate ?? 0) * 100)}% over last ${w.samples} calls`);
      }
    }
    // 'degraded' (still cooling down): results are recorded but don't change state.
  }

  private async trip(gateway: string, method: string, reason: string) {
    await this.redis.del(windowKey(gateway, method));
    await this.setState(gateway, method, 'degraded', reason, this.now() + this.config.ROUTING_COOLDOWN_MS);
  }

  async health(gateway: string, method: PaymentMethod): Promise<RouteHealth> {
    const s = await this.readState(gateway, method);
    const w = await this.window(gateway, method);
    return {
      gateway,
      method,
      state: s.state,
      samples: w.samples,
      successRate: w.successRate,
      avgLatencyMs: w.avgLatencyMs,
      degradedUntil: s.state === 'degraded' && s.until ? new Date(s.until).toISOString() : null,
      probeSuccesses: s.probeOk,
      lastChange: s.changedAt ? new Date(s.changedAt).toISOString() : null,
      reason: s.reason,
    };
  }

  /** Forget everything (used by the simulator's reset button and tests). */
  async reset(): Promise<void> {
    const keys = await this.redis.keys(`${PREFIX}:*`);
    if (keys.length) await this.redis.del(...keys);
  }
}
