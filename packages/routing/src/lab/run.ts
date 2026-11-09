// Runs every scenario x strategy x seed and aggregates the results with
// confidence intervals. Each seed gets its own traffic, shared by all
// strategies ("common random numbers"), so differences between strategies come
// from the strategies, not from luckier traffic.
import { seededRng } from '../random';
import { DEFAULT_TRAFFIC, generateTraffic, type TrafficSpec } from './model';
import { SCENARIOS, type Scenario } from './scenarios';
import { simulate, type MinutePoint, type RunMetrics } from './simulate';
import { STRATEGY_IDS, makeStrategy, type StrategyId } from './strategies';

export interface Stat {
  mean: number;
  /** Half-width of the 95% confidence interval for the mean (Student t). */
  ci95: number;
  /** How many seeds produced a value (adapt/recover can be "never"). */
  n: number;
}

export interface StrategyResult {
  strategy: StrategyId;
  title: string;
  stats: Record<string, Stat | null>;
  /** Fraction of seeds where the strategy never adapted to the incident. */
  neverAdapted: number;
  minutes: MinutePoint[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  description: string;
  strategies: StrategyResult[];
}

export interface LabResults {
  generatedAt: string;
  seeds: number;
  traffic: TrafficSpec;
  scenarios: ScenarioResult[];
}

// Two-sided 95% Student-t critical values by degrees of freedom.
const T95: Record<number, number> = { 1: 12.71, 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 15: 2.13, 20: 2.09, 30: 2.04 };
const tCrit = (df: number) => {
  if (df <= 0) return 0;
  const keys = Object.keys(T95).map(Number).sort((a, b) => a - b);
  const k = keys.filter((x) => x <= df).at(-1) ?? 1;
  return df > 30 ? 1.96 : T95[k]!;
};

export function stat(values: (number | null)[]): Stat | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean, ci95: (tCrit(xs.length - 1) * sd) / Math.sqrt(xs.length), n: xs.length };
}

const METRICS: Record<string, (m: RunMetrics) => number | null> = {
  successRate: (m) => m.successRate,
  incidentSuccessRate: (m) => m.incident.successRate,
  avgAttempts: (m) => m.avgAttempts,
  meanLatencyMs: (m) => m.meanLatencyMs,
  p95LatencyMs: (m) => m.p95LatencyMs,
  feeRateBps: (m) => m.feeRateBps,
  netRevenuePerPaymentKobo: (m) => m.netRevenuePerPaymentKobo,
  fastFails: (m) => m.fastFails,
  viaAlternative: (m) => m.viaAlternative,
  transitions: (m) => m.transitions,
  adaptMin: (m) => m.incident.adaptMin,
  recoverMin: (m) => m.incident.recoverMin,
};

function averageMinutes(runs: MinutePoint[][]): MinutePoint[] {
  const len = Math.min(...runs.map((r) => r.length));
  const avg = (vals: (number | null)[]) => {
    const xs = vals.filter((v): v is number => v !== null);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  return Array.from({ length: len }, (_, i) => ({
    minute: i,
    successRate: avg(runs.map((r) => r[i]!.successRate)),
    exposure: avg(runs.map((r) => r[i]!.exposure)),
    avgAttempts: avg(runs.map((r) => r[i]!.avgAttempts)),
  }));
}

export function runLab(opts: { seeds?: number; traffic?: TrafficSpec; scenarios?: Scenario[]; onProgress?: (msg: string) => void } = {}): LabResults {
  const seeds = opts.seeds ?? 8;
  const traffic = opts.traffic ?? DEFAULT_TRAFFIC;
  const scenarios = opts.scenarios ?? SCENARIOS;
  const out: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const perStrategy = new Map<StrategyId, { metrics: RunMetrics[]; minutes: MinutePoint[][] }>();
    for (let seed = 1; seed <= seeds; seed++) {
      const payments = generateTraffic(seededRng(seed), traffic);
      for (const id of STRATEGY_IDS) {
        const r = simulate(scenario, id, seed, payments, traffic.durationMs);
        const acc = perStrategy.get(id) ?? { metrics: [], minutes: [] };
        acc.metrics.push(r.metrics);
        acc.minutes.push(r.minutes);
        perStrategy.set(id, acc);
      }
    }
    opts.onProgress?.(`${scenario.id}: done`);
    out.push({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      strategies: STRATEGY_IDS.map((id) => {
        const acc = perStrategy.get(id)!;
        return {
          strategy: id,
          title: makeStrategy(id, seededRng(0)).title,
          stats: Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, stat(acc.metrics.map(f))])),
          neverAdapted: scenario.focus ? acc.metrics.filter((m) => m.incident.adaptMin === null).length / acc.metrics.length : 0,
          minutes: averageMinutes(acc.minutes),
        };
      }),
    });
  }
  return { generatedAt: new Date().toISOString(), seeds, traffic, scenarios: out };
}
