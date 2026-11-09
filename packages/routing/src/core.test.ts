import { describe, expect, it } from 'vitest';
import { initialBreaker, orderByBreaker, recordOutcome, tickBreaker, type BreakerConfig } from './breaker';
import { sampleBeta, seededRng } from './random';
import { addOutcome, decay, DEFAULT_THOMPSON, emptyCounts, expectedSuccess, orderByThompson, type ThompsonRoute } from './thompson';

describe('random', () => {
  it('is reproducible for a given seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('samples Beta(a, b) with the right mean and variance', () => {
    const rng = seededRng(7);
    const [alpha, beta] = [3, 7];
    const xs = Array.from({ length: 20_000 }, () => sampleBeta(rng, alpha, beta));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    expect(mean).toBeCloseTo(alpha / (alpha + beta), 2); // 0.3
    expect(variance).toBeCloseTo((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)), 3); // ~0.0191
  });

  it('handles Beta shapes below 1', () => {
    const rng = seededRng(1);
    const xs = Array.from({ length: 10_000 }, () => sampleBeta(rng, 0.5, 0.5));
    expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
  });
});

describe('breaker rules', () => {
  const cfg: BreakerConfig = { minSamples: 3, minSuccessRate: 0.8, cooldownMs: 1_000, probeSuccesses: 2 };

  it('trips below the threshold, probes after the cooldown, recovers after consecutive probes', () => {
    let s = initialBreaker();
    s = recordOutcome(s, false, { samples: 3, successRate: 1 / 3 }, cfg, 0).state;
    expect(s.state).toBe('degraded');
    expect(tickBreaker(s, 999).state).toBe('degraded');
    s = tickBreaker(s, 1_000);
    expect(s.state).toBe('probing');
    s = recordOutcome(s, true, { samples: 1, successRate: 1 }, cfg, 1_100).state;
    expect(s.state).toBe('probing');
    const healed = recordOutcome(s, true, { samples: 2, successRate: 1 }, cfg, 1_200);
    expect(healed.state.state).toBe('healthy');
    expect(healed.clearWindow).toBe(true);
  });

  it('does not trip before the minimum sample size', () => {
    const u = recordOutcome(initialBreaker(), false, { samples: 2, successRate: 0 }, cfg, 0);
    expect(u.state.state).toBe('healthy');
  });

  it('orders healthy routes before probing ones and excludes degraded', () => {
    const routes = [
      { gateway: 'a', state: 'probing' as const, samples: 0, successRate: null, avgLatencyMs: null },
      { gateway: 'b', state: 'healthy' as const, samples: 10, successRate: 0.9, avgLatencyMs: 100 },
      { gateway: 'c', state: 'healthy' as const, samples: 10, successRate: 0.99, avgLatencyMs: 100 },
      { gateway: 'd', state: 'degraded' as const, samples: 0, successRate: null, avgLatencyMs: null },
    ];
    expect(orderByBreaker(routes, 3, 1)).toEqual(['c', 'b', 'a']);
    expect(orderByBreaker(routes, 3, 5)).toEqual(['a', 'c', 'b']); // every 5th call probes first
  });
});

describe('thompson sampling', () => {
  const cfg = DEFAULT_THOMPSON;
  const route = (gateway: string, s: number, f: number): ThompsonRoute => ({
    gateway,
    gatewayCounts: { s, f, t: 0 },
    bankCounts: null,
    otherGatewaysBankCounts: null,
  });

  it('decays evidence with the configured half-life', () => {
    const d = decay({ s: 8, f: 4, t: 0 }, cfg.halfLifeMs, cfg.halfLifeMs);
    expect(d.s).toBeCloseTo(4);
    expect(d.f).toBeCloseTo(2);
    expect(addOutcome(emptyCounts(0), true, 0, cfg.halfLifeMs).s).toBe(1);
  });

  it('prefers the route with the better record almost every time', () => {
    const rng = seededRng(3);
    let firstIsGood = 0;
    for (let i = 0; i < 1_000; i++) {
      if (orderByThompson(rng, [route('bad', 60, 40), route('good', 95, 5)], cfg, 0)[0] === 'good') firstIsGood++;
    }
    expect(firstIsGood).toBeGreaterThan(990);
  });

  it('skips routes that are clearly down (fail fast)', () => {
    const rng = seededRng(4);
    expect(orderByThompson(rng, [route('down', 0, 40)], cfg, 0)).toEqual([]);
  });

  it('forgets an outage over time, so a recovered route gets tried again', () => {
    const rng = seededRng(5);
    const down = route('a', 0, 40);
    expect(orderByThompson(rng, [down], cfg, 0)).toEqual([]);
    const tenHalfLivesLater = 10 * cfg.halfLifeMs;
    expect(orderByThompson(rng, [down], cfg, tenHalfLivesLater)).toEqual(['a']);
  });

  it('a bank failing on other gateways lowers this gateway\'s estimate for that bank', () => {
    const clean: ThompsonRoute = { ...route('a', 50, 0), bankCounts: emptyCounts(0), otherGatewaysBankCounts: emptyCounts(0) };
    const suspect: ThompsonRoute = { ...clean, otherGatewaysBankCounts: { s: 0, f: 40, t: 0 } };
    expect(expectedSuccess(suspect, cfg, 0)).toBeLessThan(expectedSuccess(clean, cfg, 0) - 0.3);
  });

  it('net-revenue objective picks the cheaper gateway when success rates are equal', () => {
    const rng = seededRng(6);
    const cheap = { ...route('cheap', 500, 10), netValueKobo: 495_000 };
    const dear = { ...route('dear', 500, 10), netValueKobo: 492_500 };
    let cheapFirst = 0;
    for (let i = 0; i < 1_000; i++) if (orderByThompson(rng, [dear, cheap], cfg, 0, 'net_revenue')[0] === 'cheap') cheapFirst++;
    expect(cheapFirst).toBeGreaterThan(500);
  });
});
