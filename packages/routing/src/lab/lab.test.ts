// Tests for the routing lab: reproducibility, plus the key findings checked on
// short runs so a change to the routing code that breaks them is noticed.
import { describe, expect, it } from 'vitest';
import { orderHybrid } from '../hybrid';
import { seededRng } from '../random';
import { generateTraffic, type TrafficSpec } from './model';
import { runLab } from './run';
import { SCENARIOS } from './scenarios';
import { simulate } from './simulate';

// 30 simulated minutes, incidents shifted to fit.
const SHORT: TrafficSpec = { durationMs: 30 * 60_000, ratePerSec: 2, cardShare: 0.6, medianAmountKobo: 800_000 };
const shrink = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id)!;
  return { ...s, incidents: s.incidents.map((i) => ({ ...i, startMs: 5 * 60_000, endMs: 20 * 60_000 })) };
};

describe('routing lab', () => {
  it('is reproducible: same seed, same result', () => {
    const traffic = generateTraffic(seededRng(1), SHORT);
    const a = simulate(shrink('nibss_outage'), 'thompson', 1, traffic, SHORT.durationMs);
    const b = simulate(shrink('nibss_outage'), 'thompson', 1, traffic, SHORT.durationMs);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('bank-level attribution beats a per-gateway breaker when one bank fails everywhere', () => {
    const r = runLab({ seeds: 3, traffic: SHORT, scenarios: [shrink('bank_outage_everywhere')] }).scenarios[0]!;
    const rate = (id: string) => r.strategies.find((s) => s.strategy === id)!.stats.successRate!.mean;
    expect(rate('breaker_bank')).toBeGreaterThan(rate('breaker') + 0.01);
  });

  it('in a NIBSS-style outage the breaker family fails fast while static priority burns timeouts', () => {
    const r = runLab({ seeds: 3, traffic: SHORT, scenarios: [shrink('nibss_outage')] }).scenarios[0]!;
    const s = (id: string) => r.strategies.find((x) => x.strategy === id)!.stats;
    expect(s('hybrid').p95LatencyMs!.mean).toBeLessThan(2_000);
    expect(s('static').p95LatencyMs!.mean).toBeGreaterThan(10_000);
    expect(s('hybrid').successRate!.mean).toBeGreaterThan(s('static').successRate!.mean);
  });

  it('bounded exploration does better than unbounded Thompson sampling in a long outage', () => {
    const r = runLab({ seeds: 3, traffic: SHORT, scenarios: [shrink('nibss_outage')] }).scenarios[0]!;
    const rate = (id: string) => r.strategies.find((x) => x.strategy === id)!.stats.successRate!.mean;
    expect(rate('thompson')).toBeGreaterThan(rate('thompson_v1'));
  });

  it('orderHybrid keeps the breaker\'s exclusions and probe placement but reorders healthy routes', () => {
    const routes = [
      { gateway: 'a', state: 'healthy' as const, samples: 10, successRate: 0.99, avgLatencyMs: 100 },
      { gateway: 'b', state: 'healthy' as const, samples: 10, successRate: 0.95, avgLatencyMs: 100 },
      { gateway: 'c', state: 'probing' as const, samples: 0, successRate: null, avgLatencyMs: null },
      { gateway: 'd', state: 'degraded' as const, samples: 0, successRate: null, avgLatencyMs: null },
    ];
    expect(orderHybrid(routes, 5, 1, ['b', 'a', 'd'])).toEqual(['b', 'a', 'c']);
    expect(orderHybrid(routes, 5, 5, ['b', 'a'])).toEqual(['c', 'b', 'a']); // probe call: probing route first
  });
});
