// HYBRID routing: the circuit breaker decides WHICH routes are alive, Thompson
// sampling decides the ORDER among the healthy ones.
//
// Why (from the routing lab, docs/ROUTING-LAB.md):
//  - The breaker is best at outages: its cooldown + consecutive-probe rules give
//    it memory that a route is dead (hysteresis), so a dead rail gets a trickle
//    of probes, not a flood of payments.
//  - A pure bandit with time-decayed evidence has no such memory: during a long
//    outage its belief drifts back toward "gateways usually work" and traffic
//    returns too early.
//  - But on normal days Thompson sampling spreads traffic by measured quality and
//    cost, which the breaker's "best success rate first" ordering doesn't.
import { orderByBreaker, type BreakerRoute } from './breaker';

/**
 * Takes the breaker's order (degraded excluded, probing placed by the breaker's
 * rules) and re-orders only the HEALTHY positions using `preferredHealthy`
 * (e.g. a Thompson ranking). Healthy routes missing from the preference keep
 * their breaker order after the preferred ones.
 */
export function orderHybrid(routes: BreakerRoute[], minSamples: number, callNumber: number, preferredHealthy: string[]): string[] {
  const base = orderByBreaker(routes, minSamples, callNumber);
  const healthy = new Set(routes.filter((r) => r.state === 'healthy').map((r) => r.gateway));
  const preferred = preferredHealthy.filter((g) => healthy.has(g));
  const ordered = [...preferred, ...base.filter((g) => healthy.has(g) && !preferred.includes(g))];
  let i = 0;
  return base.map((g) => (healthy.has(g) ? ordered[i++]! : g));
}
