// The routing strategies under test. The breaker and Thompson strategies call
// the SAME pure functions production uses (breaker.ts, thompson.ts); only the
// storage differs (in-memory here, Redis in apps/api).
import type { PaymentMethod } from '@po/shared';
import {
  combineStates,
  initialBreaker,
  orderByBreaker,
  recordOutcome,
  tickBreaker,
  type BreakerConfig,
  type BreakerState,
} from '../breaker';
import { orderHybrid } from '../hybrid';
import type { Rng } from '../random';
import {
  addOutcome,
  decay,
  DEFAULT_THOMPSON,
  emptyCounts,
  boundedThompsonOrder,
  rankByThompson,
  sumCounts,
  type DecayedCounts,
  type ThompsonConfig,
  type ThompsonRoute,
} from '../thompson';
import { feeKobo, GATEWAYS } from './model';

export interface RouteRequest {
  method: PaymentMethod;
  bank: string;
  amountKobo: number;
  now: number;
}

export interface Observation {
  gateway: string;
  method: PaymentMethod;
  bank: string;
  ok: boolean;
  scope: 'gateway' | 'bank';
  latencyMs: number;
  now: number;
}

export interface LabStrategy {
  id: string;
  title: string;
  order(req: RouteRequest): string[];
  observe(o: Observation): void;
  /** Number of breaker state changes (a flip-flop indicator); 0 for non-breaker strategies. */
  transitions(): number;
}

/** Production defaults (apps/api/src/lib/env.ts). */
export const LAB_BREAKER: BreakerConfig & { windowSize: number } = {
  windowSize: 20,
  minSamples: 5,
  minSuccessRate: 0.8,
  cooldownMs: 30_000,
  probeSuccesses: 3,
};

const gm = (g: string, m: string) => `${g}:${m}`;
const gmb = (g: string, m: string, b: string) => `${g}:${m}:${b}`;

/** In-memory mirror of HealthTracker's breaker bookkeeping (window + state per route). */
class BreakerStore {
  private readonly routes = new Map<string, { win: { ok: boolean; latency: number }[]; state: BreakerState }>();
  changes = 0;

  constructor(private readonly cfg: typeof LAB_BREAKER) {}

  private entry(id: string, now: number) {
    let e = this.routes.get(id);
    if (!e) {
      e = { win: [], state: initialBreaker() };
      this.routes.set(id, e);
    }
    const ticked = tickBreaker(e.state, now);
    if (ticked !== e.state) {
      e.state = ticked;
      this.changes++;
    }
    return e;
  }

  view(id: string, now: number) {
    const e = this.entry(id, now);
    const n = e.win.length;
    return {
      state: e.state.state,
      samples: n,
      successRate: n ? e.win.filter((w) => w.ok).length / n : null,
      avgLatencyMs: n ? e.win.reduce((s, w) => s + w.latency, 0) / n : null,
    };
  }

  record(id: string, ok: boolean, latency: number, now: number) {
    const e = this.entry(id, now);
    e.win.unshift({ ok, latency });
    if (e.win.length > this.cfg.windowSize) e.win.length = this.cfg.windowSize;
    const n = e.win.length;
    const update = recordOutcome(e.state, ok, { samples: n, successRate: e.win.filter((w) => w.ok).length / n }, this.cfg, now);
    if (update.clearWindow) e.win = [];
    if (update.changed) this.changes++;
    e.state = update.state;
  }
}

const names = (method: PaymentMethod) => GATEWAYS.filter((g) => g.base[method] > 0).map((g) => g.name);

export function staticStrategy(): LabStrategy {
  return {
    id: 'static',
    title: 'Static priority (no learning)',
    order: (r) => names(r.method),
    observe: () => {},
    transitions: () => 0,
  };
}

/**
 * The circuit breaker. With bankLevel=false it is the original Phase 3 design:
 * one breaker per (gateway, method) and every failure counts against it.
 * With bankLevel=true it is the current production design: a second breaker
 * per (gateway, method, bank), and failures are attributed to gateway or bank.
 */
export function breakerStrategy(bankLevel: boolean): LabStrategy {
  const store = new BreakerStore(LAB_BREAKER);
  const counters: Record<string, number> = {};
  return {
    id: bankLevel ? 'breaker_bank' : 'breaker',
    title: bankLevel ? 'Circuit breaker, per gateway+method AND bank' : 'Circuit breaker, per gateway+method',
    order(r) {
      const routes = names(r.method).map((g) => {
        const top = store.view(gm(g, r.method), r.now);
        const states = [top.state];
        if (bankLevel) states.push(store.view(gmb(g, r.method, r.bank), r.now).state);
        return { gateway: g, state: combineStates(states), samples: top.samples, successRate: top.successRate, avgLatencyMs: top.avgLatencyMs };
      });
      counters[r.method] = (counters[r.method] ?? 0) + 1;
      return orderByBreaker(routes, LAB_BREAKER.minSamples, counters[r.method]!);
    },
    observe(o) {
      if (!bankLevel) {
        store.record(gm(o.gateway, o.method), o.ok, o.latencyMs, o.now);
        return;
      }
      if (o.ok) {
        store.record(gm(o.gateway, o.method), true, o.latencyMs, o.now);
        store.record(gmb(o.gateway, o.method, o.bank), true, o.latencyMs, o.now);
      } else if (o.scope === 'bank') {
        store.record(gmb(o.gateway, o.method, o.bank), false, o.latencyMs, o.now);
      } else {
        store.record(gm(o.gateway, o.method), false, o.latencyMs, o.now);
      }
    },
    transitions: () => store.changes,
  };
}

/**
 * Discounted, bank-aware Thompson sampling (the same model as production).
 * bounded=false is version 1 (unbounded exploration), kept to show why it was replaced.
 */
export function thompsonStrategy(
  rng: Rng,
  objective: 'success' | 'net_revenue',
  bounded = true,
  cfg: ThompsonConfig = DEFAULT_THOMPSON,
): LabStrategy {
  const counts = new Map<string, DecayedCounts>();
  const lastProbe = new Map<string, number>();
  const get = (id: string, now: number) => decay(counts.get(id) ?? emptyCounts(now), now, cfg.halfLifeMs);
  const add = (id: string, ok: boolean, now: number) => counts.set(id, addOutcome(counts.get(id) ?? emptyCounts(now), ok, now, cfg.halfLifeMs));

  return {
    id: !bounded ? 'thompson_v1' : objective === 'success' ? 'thompson' : 'thompson_cost',
    title: !bounded
      ? 'Thompson sampling v1 (unbounded exploration)'
      : objective === 'success'
        ? 'Thompson sampling (max success)'
        : 'Thompson sampling (max net revenue)',
    order(r) {
      const gws = GATEWAYS.filter((g) => g.base[r.method] > 0);
      const bankCounts = gws.map((g) => get(gmb(g.name, r.method, r.bank), r.now));
      const routes: ThompsonRoute[] = gws.map((g, i) => ({
        gateway: g.name,
        gatewayCounts: get(gm(g.name, r.method), r.now),
        bankCounts: bankCounts[i]!,
        otherGatewaysBankCounts: sumCounts(bankCounts.filter((_, j) => j !== i), r.now, cfg.halfLifeMs),
        netValueKobo: r.amountKobo - feeKobo(g, r.amountKobo),
      }));
      const picks = rankByThompson(rng, routes, cfg, r.now, objective);
      if (!bounded) return picks.map((p) => p.gateway);
      return boundedThompsonOrder(picks, (p) => {
        const key = p.probeLevel === 'bank' ? gmb(p.gateway, r.method, r.bank) : gm(p.gateway, r.method);
        const last = lastProbe.get(key);
        if (last !== undefined && r.now - last < cfg.probeIntervalMs) return false;
        lastProbe.set(key, r.now);
        return true;
      });
    },
    observe(o) {
      if (o.ok) {
        add(gm(o.gateway, o.method), true, o.now);
        add(gmb(o.gateway, o.method, o.bank), true, o.now);
      } else if (o.scope === 'bank') {
        add(gmb(o.gateway, o.method, o.bank), false, o.now);
      } else {
        add(gm(o.gateway, o.method), false, o.now);
      }
    },
    transitions: () => 0,
  };
}

/**
 * HYBRID (see hybrid.ts): bank-aware breaker decides which routes are alive;
 * Thompson sampling (net-revenue objective) orders the healthy ones.
 */
export function hybridStrategy(rng: Rng, cfg: ThompsonConfig = DEFAULT_THOMPSON): LabStrategy {
  const store = new BreakerStore(LAB_BREAKER);
  const counts = new Map<string, DecayedCounts>();
  const counters: Record<string, number> = {};
  const get = (id: string, now: number) => decay(counts.get(id) ?? emptyCounts(now), now, cfg.halfLifeMs);
  const add = (id: string, ok: boolean, now: number) => counts.set(id, addOutcome(counts.get(id) ?? emptyCounts(now), ok, now, cfg.halfLifeMs));
  return {
    id: 'hybrid',
    title: 'Hybrid: breaker gate + Thompson ordering',
    order(r) {
      const gws = GATEWAYS.filter((g) => g.base[r.method] > 0);
      const routes = gws.map((g) => {
        const top = store.view(gm(g.name, r.method), r.now);
        const bank = store.view(gmb(g.name, r.method, r.bank), r.now);
        return { gateway: g.name, state: combineStates([top.state, bank.state]), samples: top.samples, successRate: top.successRate, avgLatencyMs: top.avgLatencyMs };
      });
      const bankCounts = gws.map((g) => get(gmb(g.name, r.method, r.bank), r.now));
      const ts: ThompsonRoute[] = gws.map((g, i) => ({
        gateway: g.name,
        gatewayCounts: get(gm(g.name, r.method), r.now),
        bankCounts: bankCounts[i]!,
        otherGatewaysBankCounts: sumCounts(bankCounts.filter((_, j) => j !== i), r.now, cfg.halfLifeMs),
        netValueKobo: r.amountKobo - feeKobo(g, r.amountKobo),
      }));
      const preferred = rankByThompson(rng, ts, cfg, r.now, 'net_revenue').map((p) => p.gateway);
      counters[r.method] = (counters[r.method] ?? 0) + 1;
      return orderHybrid(routes, LAB_BREAKER.minSamples, counters[r.method]!, preferred);
    },
    observe(o) {
      const top = gm(o.gateway, o.method);
      const bank = gmb(o.gateway, o.method, o.bank);
      if (o.ok) {
        store.record(top, true, o.latencyMs, o.now);
        store.record(bank, true, o.latencyMs, o.now);
        add(top, true, o.now);
        add(bank, true, o.now);
      } else if (o.scope === 'bank') {
        store.record(bank, false, o.latencyMs, o.now);
        add(bank, false, o.now);
      } else {
        store.record(top, false, o.latencyMs, o.now);
        add(top, false, o.now);
      }
    },
    transitions: () => store.changes,
  };
}

export const STRATEGY_IDS = ['static', 'breaker', 'breaker_bank', 'thompson_v1', 'thompson', 'thompson_cost', 'hybrid'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export function makeStrategy(id: StrategyId, rng: Rng): LabStrategy {
  switch (id) {
    case 'static':
      return staticStrategy();
    case 'breaker':
      return breakerStrategy(false);
    case 'breaker_bank':
      return breakerStrategy(true);
    case 'thompson_v1':
      return thompsonStrategy(rng, 'success', false);
    case 'thompson':
      return thompsonStrategy(rng, 'success');
    case 'thompson_cost':
      return thompsonStrategy(rng, 'net_revenue');
    case 'hybrid':
      return hybridStrategy(rng);
  }
}
