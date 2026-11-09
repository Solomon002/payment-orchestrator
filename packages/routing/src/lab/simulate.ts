// Runs one (scenario, strategy, seed) and measures what happened.
//
// Simplification: payments are processed one at a time in arrival order, each
// attempt observed immediately (no concurrency between payments). Attempts in a
// payment happen one after another, advancing the clock by their latency.
import { seededRng } from '../random';
import { attempt, feeKobo, GATEWAYS, MAX_ATTEMPTS, SWITCH_TO_CARD_PROB, type SimPayment } from './model';
import type { Scenario } from './scenarios';
import { makeStrategy, type LabStrategy, type StrategyId } from './strategies';

const BUCKET_MS = 10_000;
const TRAILING_BUCKETS = 6; // 60s trailing window for adapt/recover detection

export interface IncidentMetrics {
  /** Success rate of the payments the incident is about, while it was active. */
  successRate: number | null;
  /** Minutes from incident start until traffic to affected routes fell to 25% of normal. Null = never. */
  adaptMin: number | null;
  /** Minutes from incident end until traffic to affected routes returned to 50% of normal. Null = never. */
  recoverMin: number | null;
}

export interface RunMetrics {
  payments: number;
  succeeded: number;
  successRate: number;
  viaAlternative: number;
  fastFails: number;
  avgAttempts: number;
  failedAttempts: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  feeRateBps: number;
  netRevenuePerPaymentKobo: number;
  transitions: number;
  incident: IncidentMetrics;
}

export interface MinutePoint {
  minute: number;
  successRate: number | null;
  /** Share of focus payments whose first attempt went to an affected route. */
  exposure: number | null;
  avgAttempts: number | null;
}

export interface RunResult {
  metrics: RunMetrics;
  minutes: MinutePoint[];
}

interface Bucket {
  payments: number;
  succeeded: number;
  attempts: number;
  eligible: number;
  exposed: number;
}

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

export function simulate(scenario: Scenario, strategyId: StrategyId, seed: number, traffic: SimPayment[], durationMs: number): RunResult {
  const worldRng = seededRng(seed * 7_919 + 1);
  const strategy: LabStrategy = makeStrategy(strategyId, seededRng(seed * 104_729 + 2));
  const specs = new Map(GATEWAYS.map((g) => [g.name, g]));
  const focus = scenario.focus;
  const isAffected = (g: string) => !!focus && (focus.gateways === 'all' || focus.gateways.includes(g));

  const buckets: Bucket[] = Array.from({ length: Math.ceil(durationMs / BUCKET_MS) + 1 }, () => ({ payments: 0, succeeded: 0, attempts: 0, eligible: 0, exposed: 0 }));
  const latencies: number[] = [];
  let succeeded = 0;
  let viaAlternative = 0;
  let fastFails = 0;
  let attemptsTotal = 0;
  let failedAttempts = 0;
  let feesTotal = 0;
  let volumeTotal = 0;
  let netRevenue = 0;
  let incidentEligible = 0;
  let incidentSucceeded = 0;

  const runMethod = (p: SimPayment, method: SimPayment['method'], startAt: number) => {
    let now = startAt;
    const order = strategy.order({ method, bank: p.bank, amountKobo: p.amountKobo, now }).slice(0, MAX_ATTEMPTS);
    let tried = 0;
    for (const name of order) {
      const g = specs.get(name)!;
      const res = attempt(worldRng, scenario.incidents, g, { ...p, method }, now);
      tried++;
      strategy.observe({ gateway: name, method, bank: p.bank, ok: res.ok, scope: res.scope, latencyMs: res.latencyMs, now: now + res.latencyMs });
      now += res.latencyMs;
      if (res.ok) return { ok: true, gateway: g, tried, end: now, order };
      failedAttempts++;
    }
    return { ok: false, gateway: null, tried, end: now, order };
  };

  for (const p of traffic) {
    const bucket = buckets[Math.floor(p.t / BUCKET_MS)]!;
    bucket.payments++;
    const eligible = !!focus && (!focus.method || focus.method === p.method) && (!focus.bank || focus.bank === p.bank);

    let r = runMethod(p, p.method, p.t);
    if (eligible) {
      bucket.eligible++;
      if (r.order[0] && isAffected(r.order[0])) bucket.exposed++;
    }
    let tried = r.tried;
    if (r.order.length === 0) {
      fastFails++;
      // Told "bank transfer is down, try card", some customers do.
      if (p.method === 'bank_transfer' && worldRng() < SWITCH_TO_CARD_PROB) {
        r = runMethod(p, 'card', p.t + 50);
        tried += r.tried;
        if (r.ok) viaAlternative++;
      }
    }
    attemptsTotal += tried;
    bucket.attempts += tried;
    latencies.push(Math.max(50, r.end - p.t));

    const inIncident = scenario.incidents.some((i) => p.t >= i.startMs && p.t < i.endMs);
    if (eligible && inIncident) incidentEligible++;
    if (r.ok && r.gateway) {
      succeeded++;
      bucket.succeeded++;
      if (eligible && inIncident) incidentSucceeded++;
      const fee = feeKobo(r.gateway, p.amountKobo);
      feesTotal += fee;
      volumeTotal += p.amountKobo;
      netRevenue += p.amountKobo - fee;
    }
  }

  // ---- adapt / recover timing from trailing-window exposure ----
  const exposureBetween = (fromMs: number, toMs: number) => {
    let e = 0;
    let x = 0;
    for (let b = Math.max(0, Math.floor(fromMs / BUCKET_MS)); b < Math.min(buckets.length, Math.floor(toMs / BUCKET_MS)); b++) {
      e += buckets[b]!.eligible;
      x += buckets[b]!.exposed;
    }
    return e ? x / e : null;
  };
  const trailing = (endMs: number) => exposureBetween(endMs - TRAILING_BUCKETS * BUCKET_MS, endMs);

  const adapts: number[] = [];
  const recovers: number[] = [];
  let neverAdapted = false;
  let neverRecovered = false;
  if (focus) {
    const sorted = [...scenario.incidents].sort((a, b) => a.startMs - b.startMs);
    sorted.forEach((inc, k) => {
      const pre = exposureBetween(inc.startMs - 10 * 60_000, inc.startMs);
      if (!pre) return;
      let adapted: number | null = null;
      for (let t = inc.startMs + BUCKET_MS; t <= inc.endMs; t += BUCKET_MS) {
        const x = trailing(t);
        if (x !== null && x <= 0.25 * pre) {
          adapted = (t - inc.startMs) / 60_000;
          break;
        }
      }
      if (adapted === null) neverAdapted = true;
      else adapts.push(adapted);
      // Recovery is only meaningful if the strategy had moved traffic away.
      if (adapted === null) return;
      const limit = sorted[k + 1]?.startMs ?? durationMs;
      let recovered: number | null = null;
      for (let t = inc.endMs + BUCKET_MS; t <= limit; t += BUCKET_MS) {
        const x = trailing(t);
        if (x !== null && x >= 0.5 * pre) {
          recovered = (t - inc.endMs) / 60_000;
          break;
        }
      }
      if (recovered === null) neverRecovered = true;
      else recovers.push(recovered);
    });
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  latencies.sort((a, b) => a - b);
  const minutes: MinutePoint[] = [];
  const perMinute = 60_000 / BUCKET_MS;
  for (let m = 0; m * perMinute < buckets.length - 1; m++) {
    const slice = buckets.slice(m * perMinute, (m + 1) * perMinute);
    const sum = (k: keyof Bucket) => slice.reduce((s, b) => s + b[k], 0);
    const payments = sum('payments');
    const eligible = sum('eligible');
    minutes.push({
      minute: m,
      successRate: payments ? sum('succeeded') / payments : null,
      exposure: eligible ? sum('exposed') / eligible : null,
      avgAttempts: payments ? sum('attempts') / payments : null,
    });
  }

  return {
    metrics: {
      payments: traffic.length,
      succeeded,
      successRate: succeeded / traffic.length,
      viaAlternative,
      fastFails,
      avgAttempts: attemptsTotal / traffic.length,
      failedAttempts,
      meanLatencyMs: mean(latencies),
      p95LatencyMs: percentile(latencies, 0.95),
      feeRateBps: volumeTotal ? (feesTotal / volumeTotal) * 10_000 : 0,
      netRevenuePerPaymentKobo: netRevenue / traffic.length,
      transitions: strategy.transitions(),
      incident: {
        successRate: incidentEligible ? incidentSucceeded / incidentEligible : null,
        adaptMin: neverAdapted || adapts.length === 0 ? null : mean(adapts),
        recoverMin: neverAdapted || neverRecovered || recovers.length === 0 ? null : mean(recovers),
      },
    },
    minutes,
  };
}
