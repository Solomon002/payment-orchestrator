import { useMemo, useState } from 'react';
import { BarChart, LineChart, type LineSeries } from '../components/charts';
import { DataList } from '../components/DataList';
import { Card, cx, inputClass, Mono } from '../components/ui';
import lab from '../data/routing-lab.json';

interface Stat {
  mean: number;
  ci95: number;
  n: number;
}
interface StrategyResult {
  strategy: string;
  title: string;
  stats: Record<string, Stat | null>;
  neverAdapted: number;
  minutes: { minute: number; successRate: number | null; exposure: number | null; avgAttempts: number | null }[];
}
interface ScenarioResult {
  id: string;
  title: string;
  description: string;
  incidents: { label: string; startMin: number; endMin: number }[];
  strategies: StrategyResult[];
}
interface LabResults {
  generatedAt: string;
  seeds: number;
  traffic: { durationMs: number; ratePerSec: number };
  scenarios: ScenarioResult[];
}

const results = lab as unknown as LabResults;

// Colour follows the strategy (fixed slot), never its rank or visibility.
const STRATEGIES: Record<string, { label: string; slot: number; blurb: string }> = {
  hybrid: { label: 'Hybrid (default)', slot: 1, blurb: 'Breaker decides which routes are alive; Thompson sampling orders the healthy ones by expected net revenue.' },
  breaker_bank: { label: 'Breaker + bank', slot: 2, blurb: 'Circuit breaker per gateway+method and per gateway+method+bank, failures attributed to gateway or bank.' },
  breaker: { label: 'Breaker (gateway only)', slot: 3, blurb: 'The original design: one breaker per gateway+method; every failure counts against it.' },
  static: { label: 'Static priority', slot: 4, blurb: 'Always tries gateways in the same order. No learning; relies on failover alone.' },
  thompson: { label: 'Thompson', slot: 5, blurb: 'Thompson sampling, maximise success, with bounded exploration.' },
  thompson_cost: { label: 'Thompson (cost)', slot: 6, blurb: 'Thompson sampling, maximise P(success) x (amount - fee), bounded exploration.' },
  thompson_v1: { label: 'Thompson v1', slot: 7, blurb: 'First Thompson design with unbounded exploration; kept to show the flaw the lab found.' },
};
const meta = (id: string) => STRATEGIES[id] ?? { label: id, slot: 7, blurb: '' };
const color = (id: string) => `var(--series-${meta(id).slot})`;
const DEFAULT_VISIBLE = ['hybrid', 'breaker_bank', 'breaker', 'static'];

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const statPct = (s: Stat | null | undefined, d = 1) => (s ? `${pct(s.mean, d)} ± ${(s.ci95 * 100).toFixed(d)}` : '-');
const statMs = (s: Stat | null | undefined) => (s ? `${Math.round(s.mean).toLocaleString('en')} ms` : '-');
const statMin = (s: Stat | null | undefined, seeds: number) => (s ? `${s.mean.toFixed(1)} min${s.n < seeds ? ` (never in ${seeds - s.n}/${seeds})` : ''}` : 'never');

const METRICS = {
  successRate: { label: 'Success rate (all payments)', format: (v: number) => pct(v, 1), domain: undefined as [number, number] | undefined },
  exposure: { label: 'Share of affected payments sent to the failing route first', format: (v: number) => pct(v, 0), domain: [0, 1] as [number, number] },
  avgAttempts: { label: 'Gateway attempts per payment', format: (v: number) => v.toFixed(2), domain: undefined as [number, number] | undefined },
} as const;
type MetricKey = keyof typeof METRICS;

function scenario(id: string) {
  return results.scenarios.find((s) => s.id === id);
}
function strategy(sc: ScenarioResult | undefined, id: string) {
  return sc?.strategies.find((s) => s.strategy === id);
}

/** Headline findings, computed from the results file so they never go stale. */
function Findings() {
  const bank = scenario('bank_outage_everywhere');
  const nibss = scenario('nibss_outage');
  const base = scenario('baseline');
  const items: { title: string; body: string }[] = [];
  const bb = strategy(bank, 'breaker_bank')?.stats.successRate;
  const b = strategy(bank, 'breaker')?.stats.successRate;
  if (bb && b) {
    items.push({
      title: 'Bank-level health pays off',
      body: `When one bank fails everywhere, attributing failures to the bank lifts overall success from ${statPct(b, 2)} to ${statPct(bb, 2)}: the old breaker punished every bank's customers for one bank's problem.`,
    });
  }
  const hy = strategy(nibss, 'hybrid')?.stats;
  const st = strategy(nibss, 'static')?.stats;
  const ts = strategy(nibss, 'thompson')?.stats;
  if (hy && st && ts) {
    items.push({
      title: 'Fail fast in a rail outage',
      body: `In a NIBSS-style outage, p95 latency is ${statMs(hy.p95LatencyMs)} for the hybrid vs ${statMs(ts.p95LatencyMs)} for pure Thompson sampling and ${statMs(st.p95LatencyMs)} for static priority, which keeps waiting on timeouts.`,
    });
  }
  const hf = strategy(base, 'hybrid')?.stats.feeRateBps;
  const bf = strategy(base, 'breaker_bank')?.stats.feeRateBps;
  if (hf && bf) {
    items.push({
      title: 'Cheaper on a normal day',
      body: `With equal success rates, Thompson ordering lowers the average fee from ${(bf.mean / 100).toFixed(2)}% to ${(hf.mean / 100).toFixed(2)}% of volume, by measuring gateways instead of always picking the "best" one.`,
    });
  }
  const v1 = strategy(nibss, 'thompson_v1')?.stats.successRate;
  const v2 = strategy(nibss, 'thompson')?.stats.successRate;
  if (v1 && v2) {
    items.push({
      title: 'The lab caught a design flaw',
      body: `Unbounded Thompson sampling flooded a dead rail once old failures decayed (${statPct(v1)} success in the NIBSS outage). Bounded exploration reached ${statPct(v2)}; the hybrid's breaker memory did best.`,
    });
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.title} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="text-sm font-semibold">{i.title}</div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{i.body}</p>
        </div>
      ))}
    </div>
  );
}

export function RoutingLabPage() {
  const [scenarioId, setScenarioId] = useState('nibss_outage');
  const [metric, setMetric] = useState<MetricKey>('successRate');
  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE);
  const sc = scenario(scenarioId) ?? results.scenarios[0]!;
  // Legend, lines and table all follow the fixed colour-slot order (hybrid first).
  const ordered = [...sc.strategies].sort((a, b) => meta(a.strategy).slot - meta(b.strategy).slot);
  const hasIncident = sc.incidents.length > 0;

  const series: LineSeries[] = useMemo(
    () =>
      ordered
        .filter((s) => visible.includes(s.strategy))
        .map((s) => ({ id: s.strategy, label: meta(s.strategy).label, color: color(s.strategy), values: s.minutes.map((p) => p[metric]) })),
    [ordered, visible, metric],
  );
  const x = sc.strategies[0]?.minutes.map((p) => p.minute) ?? [];

  const bar = hasIncident
    ? { title: 'Affected payments that succeeded during the incident', key: 'incidentSuccessRate', format: (v: number) => pct(v, 1), max: 1, lowerBetter: false }
    : { title: 'Average fee (share of payment volume): lower is better', key: 'feeRateBps', format: (v: number) => `${(v / 100).toFixed(2)}%`, max: undefined, lowerBetter: true };
  const barRows = sc.strategies
    .map((s) => ({ id: s.strategy, label: meta(s.strategy).label, value: s.stats[bar.key]?.mean ?? 0, ci: s.stats[bar.key]?.ci95, emphasized: s.strategy === 'hybrid' }))
    .sort((a, b) => (bar.lowerBetter ? a.value - b.value : b.value - a.value));

  const toggle = (id: string) => setVisible((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Routing Lab</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Seven routing strategies replayed against the same simulated traffic in seven outage scenarios ({results.seeds} seeds each,{' '}
          {results.traffic.ratePerSec} payments/s for {results.traffic.durationMs / 60_000} minutes). Values are means with 95% confidence intervals.{' '}
          <strong className="font-medium text-slate-700 dark:text-slate-200">All gateway, bank and outage parameters are illustrative assumptions, not real data.</strong>{' '}
          Re-run with <Mono>pnpm lab</Mono>.
        </p>
      </div>

      <Findings />

      {/* One filter row; it scopes every chart and table below. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="text-sm sm:w-72">
          Scenario
          <select className={`${inputClass} mt-1`} value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {results.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:w-80">
          Over-time metric
          <select className={`${inputClass} mt-1`} value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
            {Object.entries(METRICS)
              .filter(([k]) => k !== 'exposure' || hasIncident)
              .map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{sc.description}</p>

      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card title={bar.title}>
          <BarChart rows={barRows} format={bar.format} max={bar.max} ariaLabel={`${bar.title}, by strategy`} />
          <p className="mt-2 text-xs text-slate-500">Whiskers: 95% confidence interval across seeds. Hybrid (the production default) highlighted.</p>
        </Card>

        <Card title={METRICS[metric].label}>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Strategies shown">
            {ordered.map((s) => {
              const on = visible.includes(s.strategy);
              return (
                <button
                  key={s.strategy}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(s.strategy)}
                  className={cx(
                    'viz-root inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                    on ? 'border-slate-300 text-slate-800 dark:border-slate-600 dark:text-slate-100' : 'border-slate-200 text-slate-400 dark:border-slate-800 dark:text-slate-500',
                  )}
                >
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: on ? color(s.strategy) : 'currentColor' }} />
                  {meta(s.strategy).label}
                </button>
              );
            })}
          </div>
          {series.length > 0 ? (
            <LineChart
              series={series}
              x={x}
              xLabel="Simulated minute"
              yFormat={METRICS[metric].format}
              yDomain={METRICS[metric].domain}
              bands={sc.incidents.map((i) => ({ from: i.startMin, to: i.endMin, label: i.label }))}
              ariaLabel={`${METRICS[metric].label} over time for ${sc.title}`}
            />
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">Select at least one strategy.</p>
          )}
          {hasIncident && <p className="mt-2 text-xs text-slate-500">Shaded: incident window. Hover or focus the chart and use arrow keys to read values.</p>}
        </Card>
      </div>

      <Card title="All metrics (table view)">
        <DataList
          rows={ordered}
          rowKey={(s) => s.strategy}
          columns={[
            {
              header: 'Strategy',
              mobile: 'title',
              cell: (s) => (
                <span className="viz-root inline-flex items-center gap-2" title={meta(s.strategy).blurb}>
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: color(s.strategy) }} />
                  {meta(s.strategy).label}
                </span>
              ),
            },
            { header: 'Success (all)', cell: (s) => statPct(s.stats.successRate, 2), align: 'right', mobile: 'badge' },
            ...(hasIncident ? [{ header: 'Success (affected, during)', cell: (s: StrategyResult) => statPct(s.stats.incidentSuccessRate), align: 'right' as const }] : []),
            { header: 'Attempts/payment', cell: (s) => s.stats.avgAttempts?.mean.toFixed(3) ?? '-', align: 'right' },
            { header: 'p95 latency', cell: (s) => statMs(s.stats.p95LatencyMs), align: 'right' },
            { header: 'Fee rate', cell: (s) => (s.stats.feeRateBps ? `${(s.stats.feeRateBps.mean / 100).toFixed(3)}%` : '-'), align: 'right' },
            ...(hasIncident
              ? [
                  { header: 'Adapt', cell: (s: StrategyResult) => statMin(s.stats.adaptMin, results.seeds), align: 'right' as const },
                  { header: 'Recover', cell: (s: StrategyResult) => statMin(s.stats.recoverMin, results.seeds), align: 'right' as const },
                ]
              : []),
          ]}
        />
        <p className="mt-3 text-xs text-slate-500">
          Adapt: minutes until traffic to the failing route fell to 25% of normal. Recover: minutes after the incident until it returned to 50%. Full method and
          discussion: <Mono>docs/ROUTING-LAB.md</Mono>.
        </p>
      </Card>
    </div>
  );
}
