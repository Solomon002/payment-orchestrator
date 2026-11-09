// The circuit-breaker RULES as pure functions: no Redis, no clock, no I/O.
//
// Production (apps/api, state stored in Redis) and the routing lab (state in
// memory) both call these, so the lab measures exactly the logic that ships.
//
//   healthy  --(success rate < threshold over >= minSamples calls)-->  degraded
//   degraded --(cooldown elapsed)-->                                    probing
//   probing  --(probeSuccesses successes in a row)-->                  healthy
//   probing  --(any failure)-->                                        degraded (new cooldown)
import type { RouteState } from '@po/shared';

export interface BreakerConfig {
  minSamples: number;
  minSuccessRate: number;
  cooldownMs: number;
  probeSuccesses: number;
}

export interface BreakerState {
  state: RouteState;
  /** When a degraded route may start probing (epoch ms). */
  until: number | null;
  probeOk: number;
  changedAt: number | null;
  reason: string | null;
}

export interface WindowStats {
  samples: number;
  successRate: number | null;
}

export interface BreakerUpdate {
  state: BreakerState;
  /** True when the rolling window should be emptied (judge the next phase on fresh data). */
  clearWindow: boolean;
  /** True when the state changed (for counting transitions). */
  changed: boolean;
}

export const initialBreaker = (): BreakerState => ({ state: 'healthy', until: null, probeOk: 0, changedAt: null, reason: null });

/** Applies time: a degraded route whose cooldown is over becomes probing (half-open). */
export function tickBreaker(s: BreakerState, now: number): BreakerState {
  if (s.state === 'degraded' && s.until !== null && now >= s.until) {
    return { state: 'probing', until: null, probeOk: 0, changedAt: now, reason: 'cooldown elapsed, probing' };
  }
  return s;
}

const trip = (now: number, cfg: BreakerConfig, reason: string): BreakerUpdate => ({
  state: { state: 'degraded', until: now + cfg.cooldownMs, probeOk: 0, changedAt: now, reason },
  clearWindow: true,
  changed: true,
});

/**
 * Feeds one call outcome into the breaker. `window` must already include this
 * outcome. Call tickBreaker first so cooldowns are applied.
 */
export function recordOutcome(s: BreakerState, ok: boolean, window: WindowStats, cfg: BreakerConfig, now: number): BreakerUpdate {
  if (s.state === 'probing') {
    if (!ok) return trip(now, cfg, 'probe failed');
    const probeOk = s.probeOk + 1;
    if (probeOk >= cfg.probeSuccesses) {
      return {
        state: { state: 'healthy', until: null, probeOk: 0, changedAt: now, reason: `${probeOk} successful probes` },
        clearWindow: true,
        changed: true,
      };
    }
    return { state: { ...s, probeOk }, clearWindow: false, changed: false };
  }

  if (s.state === 'healthy' && window.samples >= cfg.minSamples && (window.successRate ?? 1) < cfg.minSuccessRate) {
    return trip(now, cfg, `success rate ${Math.round((window.successRate ?? 0) * 100)}% over last ${window.samples} calls`);
  }

  // healthy and fine, or degraded and still cooling down: no change.
  return { state: s, clearWindow: false, changed: false };
}

/** A gateway as the breaker-based router sees it. */
export interface BreakerRoute {
  gateway: string;
  /** Combined state: degraded if any level is degraded, else probing if any level is probing. */
  state: RouteState;
  samples: number;
  successRate: number | null;
  avgLatencyMs: number | null;
}

/** Worst of several levels (e.g. gateway+method and gateway+method+bank). */
export function combineStates(states: RouteState[]): RouteState {
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('probing')) return 'probing';
  return 'healthy';
}

/** Every Nth payment puts a probing route first, to test whether it recovered. */
export const PROBE_EVERY = 5;

/**
 * Orders candidates for the breaker strategy:
 *  - degraded routes are excluded,
 *  - healthy routes first, best success rate then lowest latency
 *    (a route with fewer than minSamples results counts as 100%, so one early
 *    failure can't push it to the back forever),
 *  - probing routes last, except every PROBE_EVERY-th call where they go first.
 * Array.sort is stable, so ties keep the input (priority) order.
 */
export function orderByBreaker(routes: BreakerRoute[], minSamples: number, callNumber: number): string[] {
  const score = (r: BreakerRoute) => (r.samples >= minSamples ? (r.successRate ?? 1) : 1);
  const latency = (r: BreakerRoute) => (r.samples >= minSamples ? (r.avgLatencyMs ?? 0) : 0);
  const healthy = routes
    .filter((r) => r.state === 'healthy')
    .sort((a, b) => score(b) - score(a) || latency(a) - latency(b))
    .map((r) => r.gateway);
  const probing = routes.filter((r) => r.state === 'probing').map((r) => r.gateway);
  if (healthy.length === 0) return probing;
  if (probing.length === 0) return healthy;
  return callNumber % PROBE_EVERY === 0 ? [...probing, ...healthy] : [...healthy, ...probing];
}
