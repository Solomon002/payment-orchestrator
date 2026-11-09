// THOMPSON SAMPLING for payment routing (a "multi-armed bandit").
//
// Analogy: a row of slot machines (gateways) with unknown payout rates (success
// rates). You want to play the best one, but you only learn a machine's rate by
// playing it. Thompson sampling handles this "explore vs exploit" trade-off:
//   1. For each route, keep a probability distribution (a Beta distribution)
//      of what its success rate might be, given what we've seen.
//   2. For each payment, draw one random guess from each route's distribution
//      and try the route with the best guess first.
// A route we know little about has a wide distribution, so it sometimes draws a
// high guess and gets tried (exploration). A route that is clearly good almost
// always draws the best guess (exploitation). No hand-tuned "trip at 80%" rules.
//
// Three refinements make it fit payments:
//  - DISCOUNTING: counts decay with a half-life, so old evidence fades. After an
//    outage, a gateway's failures slowly lose weight, its distribution widens,
//    and it starts winning draws again: recovery without a cooldown timer.
//  - TWO FACTORS: success = P(gateway+method works) x P(customer's bank works via
//    this gateway). Failures are attributed to the gateway or the bank (from the
//    error), so one bad bank doesn't make a whole gateway look bad.
//  - BORROWING STRENGTH: the bank factor's prior uses that bank's results on the
//    OTHER gateways too, so a bank outage seen on one gateway is suspected on all.
// Plus a VIABILITY threshold: routes whose draw is below it are skipped; if all
// are skipped the payment fails fast ("this method is down, try card").
import { sampleBeta, type Rng } from './random';

/** Success/failure counts that decay over time. `t` is when they were last decayed. */
export interface DecayedCounts {
  s: number;
  f: number;
  t: number;
}

export const emptyCounts = (t = 0): DecayedCounts => ({ s: 0, f: 0, t });

/** Applies exponential decay: every halfLifeMs, old evidence counts half as much. */
export function decay(c: DecayedCounts, now: number, halfLifeMs: number): DecayedCounts {
  if (now <= c.t) return c;
  const factor = Math.pow(0.5, (now - c.t) / halfLifeMs);
  return { s: c.s * factor, f: c.f * factor, t: now };
}

export function addOutcome(c: DecayedCounts, ok: boolean, now: number, halfLifeMs: number): DecayedCounts {
  const d = decay(c, now, halfLifeMs);
  return ok ? { ...d, s: d.s + 1 } : { ...d, f: d.f + 1 };
}

export function sumCounts(list: DecayedCounts[], now: number, halfLifeMs: number): DecayedCounts {
  return list.reduce(
    (acc, c) => {
      const d = decay(c, now, halfLifeMs);
      return { s: acc.s + d.s, f: acc.f + d.f, t: now };
    },
    emptyCounts(now),
  );
}

export interface BetaPrior {
  alpha: number;
  beta: number;
}

export interface ThompsonConfig {
  halfLifeMs: number;
  /** Belief about a gateway+method before any data: mean alpha/(alpha+beta). */
  gatewayPrior: BetaPrior;
  /** Belief about a bank via a gateway before any data. */
  bankPrior: BetaPrior;
  /** How much the same bank's results on other gateways count (0..1). */
  poolWeight: number;
  /** Routes whose sampled success probability is below this are skipped. */
  minViableRate: number;
}

export const DEFAULT_THOMPSON: ThompsonConfig = {
  halfLifeMs: 60_000,
  gatewayPrior: { alpha: 9.5, beta: 0.5 }, // "gateways usually work (~95%)", worth ~10 observations
  bankPrior: { alpha: 19.8, beta: 0.2 }, // "banks usually work (~99%)", worth ~20 observations
  poolWeight: 0.5,
  minViableRate: 0.5,
};

export interface ThompsonRoute {
  gateway: string;
  /** Successes + gateway-attributed failures for (gateway, method). */
  gatewayCounts: DecayedCounts;
  /** Successes + bank-attributed failures for (gateway, method, bank); null if no bank known. */
  bankCounts: DecayedCounts | null;
  /** The same bank's counts summed over the OTHER gateways (for borrowing strength). */
  otherGatewaysBankCounts: DecayedCounts | null;
  /** Merchant's net value if this route succeeds (amount - fee), for the cost-aware objective. */
  netValueKobo?: number;
}

export function gatewayPosterior(r: ThompsonRoute, cfg: ThompsonConfig, now: number): BetaPrior {
  const g = decay(r.gatewayCounts, now, cfg.halfLifeMs);
  return { alpha: cfg.gatewayPrior.alpha + g.s, beta: cfg.gatewayPrior.beta + g.f };
}

export function bankPosterior(r: ThompsonRoute, cfg: ThompsonConfig, now: number): BetaPrior | null {
  if (!r.bankCounts) return null;
  const local = decay(r.bankCounts, now, cfg.halfLifeMs);
  const pool = r.otherGatewaysBankCounts ? decay(r.otherGatewaysBankCounts, now, cfg.halfLifeMs) : emptyCounts(now);
  return {
    alpha: cfg.bankPrior.alpha + cfg.poolWeight * pool.s + local.s,
    beta: cfg.bankPrior.beta + cfg.poolWeight * pool.f + local.f,
  };
}

export const betaMean = (p: BetaPrior) => p.alpha / (p.alpha + p.beta);

/** Posterior-mean success probability of a route (for display, not routing). */
export function expectedSuccess(r: ThompsonRoute, cfg: ThompsonConfig, now: number): number {
  const bank = bankPosterior(r, cfg, now);
  return betaMean(gatewayPosterior(r, cfg, now)) * (bank ? betaMean(bank) : 1);
}

/** One Thompson draw of a route's success probability. */
export function sampleSuccess(rng: Rng, r: ThompsonRoute, cfg: ThompsonConfig, now: number): number {
  const g = gatewayPosterior(r, cfg, now);
  const b = bankPosterior(r, cfg, now);
  return sampleBeta(rng, g.alpha, g.beta) * (b ? sampleBeta(rng, b.alpha, b.beta) : 1);
}

export type ThompsonObjective = 'success' | 'net_revenue';

/**
 * Orders routes by one Thompson draw each.
 *  - 'success':     maximise the chance the payment succeeds
 *  - 'net_revenue': maximise expected merchant revenue = P(success) x (amount - fee),
 *                   so a cheaper gateway wins when success rates are close
 * Routes whose draw is below minViableRate are left out entirely.
 */
export function orderByThompson(
  rng: Rng,
  routes: ThompsonRoute[],
  cfg: ThompsonConfig,
  now: number,
  objective: ThompsonObjective = 'success',
): string[] {
  return routes
    .map((r) => {
      const p = sampleSuccess(rng, r, cfg, now);
      return { gateway: r.gateway, p, score: objective === 'net_revenue' ? p * (r.netValueKobo ?? 1) : p };
    })
    .filter((x) => x.p >= cfg.minViableRate)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.gateway);
}
