import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bankName } from '@po/shared';
import { DataList } from '../components/DataList';
import { Badge, Button, Card, cx, ErrorNote } from '../components/ui';
import { api, post, type RouteHealth, type RoutingHealth } from '../lib/api';
import { ago, percent } from '../lib/format';

function RouteCard({ route }: { route: RouteHealth }) {
  const rate = route.successRate ?? 1;
  const remaining = route.degradedUntil ? Math.max(0, Math.ceil((Date.parse(route.degradedUntil) - Date.now()) / 1000)) : null;
  return (
    <div
      className={cx(
        'rounded-xl border p-4 transition-colors',
        route.state === 'healthy' && 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30',
        route.state === 'probing' && 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30',
        route.state === 'degraded' && 'border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{route.gateway}</div>
          <div className="text-xs text-slate-500">{route.method.replace('_', ' ')}</div>
        </div>
        <Badge value={route.state} />
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={cx('h-full rounded-full transition-all', rate >= 0.8 ? 'bg-emerald-500' : rate >= 0.5 ? 'bg-amber-500' : 'bg-rose-500')}
          style={{ width: `${Math.round(rate * 100)}%` }}
        />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div><dt className="text-slate-500">Success</dt><dd className="tabular font-medium">{percent(route.successRate)}</dd></div>
        <div><dt className="text-slate-500">Samples</dt><dd className="tabular font-medium">{route.samples}</dd></div>
        <div><dt className="text-slate-500">Latency</dt><dd className="tabular font-medium">{route.avgLatencyMs ?? '-'} ms</dd></div>
        <div title="Thompson sampling's current estimate of this route's success rate (posterior mean)"><dt className="text-slate-500">Belief</dt><dd className="tabular font-medium">{percent(route.expectedSuccess)}</dd></div>
      </dl>
      <div className="mt-3 text-xs text-slate-500">
        {route.state === 'degraded' && remaining !== null && <div className="font-medium text-rose-600 dark:text-rose-400">Excluded from routing · probing in {remaining}s</div>}
        {route.state === 'probing' && <div className="font-medium text-amber-600 dark:text-amber-400">Probe successes: {route.probeSuccesses}</div>}
        {route.reason && <div>{route.reason}{route.lastChange ? ` · ${ago(route.lastChange)}` : ''}</div>}
      </div>
    </div>
  );
}

export function RouteGrid({ compact = false }: { compact?: boolean }) {
  const { data, error } = useQuery({ queryKey: ['routing-health'], queryFn: () => api<RoutingHealth>('/admin/routing/health'), refetchInterval: 1_000 });
  return (
    <>
      <ErrorNote error={error} />
      <div className={cx('grid gap-4', compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4')}>
        {data?.routes.map((r) => <RouteCard key={`${r.gateway}:${r.method}`} route={r} />)}
      </div>
    </>
  );
}

const STRATEGY_TEXT: Record<string, string> = {
  hybrid: 'Hybrid: the circuit breaker decides which routes are alive; Thompson sampling orders the healthy ones by expected net revenue.',
  breaker: 'Circuit breaker: degraded routes are excluded; healthy routes ordered by success rate.',
  thompson: 'Thompson sampling (maximise success) with bounded exploration.',
  thompson_cost: 'Thompson sampling (maximise expected net revenue) with bounded exploration.',
};

function BankRoutes({ routes }: { routes: RouteHealth[] }) {
  return (
    <Card title={`Bank-level routes (${routes.length})`}>
      <p className="mb-3 text-xs text-slate-500">
        Each gateway + method + customer bank is tracked separately. Bank-caused failures count only here, so one bank's outage never trips a gateway for everyone else.
      </p>
      <DataList
        rows={routes}
        rowKey={(r) => `${r.gateway}:${r.method}:${r.bankCode}`}
        empty={routes.length === 0}
        columns={[
          { header: 'Bank', cell: (r) => `${bankName(r.bankCode)} (${r.bankCode})`, mobile: 'title' },
          { header: 'Gateway', cell: (r) => r.gateway },
          { header: 'Method', cell: (r) => r.method.replace('_', ' ') },
          { header: 'State', cell: (r) => <Badge value={r.state} />, mobile: 'badge' },
          { header: 'Success', cell: (r) => percent(r.successRate), align: 'right' },
          { header: 'Samples', cell: (r) => r.samples, align: 'right' },
          { header: 'Belief', cell: (r) => percent(r.expectedSuccess), align: 'right' },
          { header: 'Reason', cell: (r) => <span className="text-xs text-slate-500">{r.reason ?? ''}</span>, mobile: 'hide' },
        ]}
      />
      {routes.length === 0 && <p className="text-xs text-slate-500">Appears once payments include a <code>bankCode</code>. Try the Simulator's bank options.</p>}
    </Card>
  );
}

export function GatewayHealthPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['routing-health'], queryFn: () => api<RoutingHealth>('/admin/routing/health'), refetchInterval: 1_000 });
  const reset = useMutation({ mutationFn: () => post('/admin/routing/reset'), onSuccess: () => qc.invalidateQueries({ queryKey: ['routing-health'] }) });
  const t = data?.thresholds;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Gateway Health</h1>
          <p className="text-sm text-slate-500">Health per gateway <em>and</em> payment method (and per bank, below). Live, refreshed every second.</p>
          {data?.strategy && (
            <p className="mt-1 text-sm">
              <span className="font-medium">Strategy: <code>{data.strategy}</code></span>{' '}
              <span className="text-slate-500">{STRATEGY_TEXT[data.strategy]}</span>
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={() => reset.mutate()}>Reset health data</Button>
      </div>
      <RouteGrid />
      {data && <BankRoutes routes={data.bankRoutes ?? []} />}
      {t && (
        <Card title="Rules">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>A route is <Badge value="degraded" /> when its success rate drops below <b>{percent(t.minSuccessRate)}</b> over at least <b>{t.minSamples}</b> of the last <b>{t.windowSize}</b> calls.</li>
            <li>Degraded routes get no traffic for <b>{t.cooldownMs / 1000}s</b>, then become <Badge value="probing" /> and receive a small share of payments.</li>
            <li><b>{t.probeSuccesses}</b> successful probes in a row make it <Badge value="healthy" /> again; one failed probe restarts the cooldown.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
