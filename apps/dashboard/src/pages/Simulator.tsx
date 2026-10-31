import { WEBHOOK_MODES, type MockControlPatch, type PaymentMethod } from '@po/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, cx, ErrorNote, inputClass, Mono } from '../components/ui';
import { api, post, put, type MockGatewayState } from '../lib/api';
import { naira, shortRef, time } from '../lib/format';
import { RouteGrid } from './GatewayHealth';

type GatewayName = 'mockpay-a' | 'mockpay-b';

function useSimulator() {
  const qc = useQueryClient();
  const gateways = useQuery({
    queryKey: ['sim-gateways'],
    queryFn: () => api<{ gateways: MockGatewayState[] }>('/admin/simulator/gateways'),
    refetchInterval: 2_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sim-gateways'] });
    void qc.invalidateQueries({ queryKey: ['routing-health'] });
  };
  const control = useMutation({
    mutationFn: ({ name, patch }: { name: GatewayName; patch: MockControlPatch }) => put(`/admin/simulator/gateways/${name}/control`, patch),
    onSuccess: refresh,
  });
  return { gateways, control, refresh };
}

function GatewayControls({ gw, onPatch }: { gw: MockGatewayState; onPatch: (patch: MockControlPatch) => void }) {
  const c = gw.control;
  if (!gw.online || !c) {
    return (
      <Card title={gw.name}>
        <p className="text-sm text-rose-600">Offline. Is <Mono>pnpm dev</Mono> running?</p>
      </Card>
    );
  }
  const slider = (label: string, key: 'latencyMs' | 'failureRate' | 'declineRate', max: number, unit: string, step = 1) => (
    <label className="block text-sm">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="tabular font-medium">{c[key]}{unit}</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        defaultValue={c[key]}
        key={`${key}-${c[key]}`}
        onPointerUp={(e) => onPatch({ [key]: Number((e.target as HTMLInputElement).value) })}
        onKeyUp={(e) => onPatch({ [key]: Number((e.target as HTMLInputElement).value) })}
        className="w-full accent-indigo-600"
      />
    </label>
  );

  return (
    <Card title={<span className="flex items-center gap-2">{gw.name} <Badge value="succeeded">online</Badge></span>}>
      <div className="space-y-4">
        {slider('Gateway error rate (HTTP 503)', 'failureRate', 100, '%', 5)}
        {slider('Customer decline rate', 'declineRate', 100, '%', 5)}
        {slider('Latency', 'latencyMs', 3_000, ' ms', 50)}

        <div>
          <div className="mb-1 text-sm">Method outages</div>
          <div className="flex gap-2">
            {(['card', 'bank_transfer'] as PaymentMethod[]).map((m) => {
              const down = c.methodOutages[m];
              return (
                <button
                  key={m}
                  onClick={() => onPatch({ methodOutages: { [m]: !down } })}
                  className={cx(
                    'flex-1 rounded-lg border px-3 py-2 text-sm font-medium',
                    down ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300' : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
                  )}
                >
                  {m.replace('_', ' ')}: {down ? 'DOWN' : 'up'}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            Webhook behaviour
            <select className={`${inputClass} mt-1`} value={c.webhookMode} onChange={(e) => onPatch({ webhookMode: e.target.value as MockControlPatch['webhookMode'] })}>
              {WEBHOOK_MODES.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
            </select>
          </label>
          <label className="text-sm">
            Delay (delayed mode)
            <select className={`${inputClass} mt-1`} value={c.webhookDelayMs} onChange={(e) => onPatch({ webhookDelayMs: Number(e.target.value) })}>
              {[2_000, 5_000, 15_000, 30_000, 60_000].map((ms) => <option key={ms} value={ms}>{ms / 1000}s</option>)}
            </select>
          </label>
        </div>

        {gw.stats && (
          <div className="text-xs text-slate-500">
            Charges: {gw.stats.charges} · succeeded {gw.stats.succeeded} · failed {gw.stats.failed} · pending {gw.stats.pending}
          </div>
        )}

        {gw.recentDeliveries && gw.recentDeliveries.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Recent webhook deliveries</div>
            <ul className="max-h-36 space-y-1 overflow-auto text-xs">
              {gw.recentDeliveries.slice(0, 8).map((d) => (
                <li key={d.eventId + d.at} className="flex justify-between gap-2">
                  <span>{time(d.at)} <Mono>{shortRef(d.reference, 12)}</Mono></span>
                  <span>
                    <Badge value={d.mode === 'normal' ? 'processed' : d.mode === 'drop' ? 'expired' : 'pending'}>{d.mode}</Badge>{' '}
                    <span className="tabular text-slate-500">×{d.attempts} → {String(d.lastStatus ?? '…')}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

const SCENARIOS: { label: string; description: string; patches: Partial<Record<GatewayName, MockControlPatch>> }[] = [
  {
    label: 'NIBSS outage',
    description: 'bank_transfer down on BOTH gateways; cards unaffected',
    patches: { 'mockpay-a': { methodOutages: { bank_transfer: true } }, 'mockpay-b': { methodOutages: { bank_transfer: true } } },
  },
  { label: 'mockpay-a down', description: '100% errors on mockpay-a, watch traffic fail over to mockpay-b', patches: { 'mockpay-a': { failureRate: 100 } } },
  { label: 'Flaky mockpay-a', description: '40% errors: degrades, then probes', patches: { 'mockpay-a': { failureRate: 40 } } },
  { label: 'Duplicate webhooks', description: 'Every webhook sent 3x with the same event id', patches: { 'mockpay-a': { webhookMode: 'duplicate' }, 'mockpay-b': { webhookMode: 'duplicate' } } },
  { label: 'Drop webhooks', description: 'Webhooks never sent; the poller must recover', patches: { 'mockpay-a': { webhookMode: 'drop' }, 'mockpay-b': { webhookMode: 'drop' } } },
  { label: 'Forged signatures', description: 'Webhooks signed with the wrong secret', patches: { 'mockpay-a': { webhookMode: 'bad_signature' }, 'mockpay-b': { webhookMode: 'bad_signature' } } },
];

export function SimulatorPage() {
  const { gateways, control, refresh } = useSimulator();
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [count, setCount] = useState(10);
  const [amount, setAmount] = useState(500_000);
  const [lastFire, setLastFire] = useState<string | null>(null);

  const fire = useMutation({
    mutationFn: () => post<{ requested: number; accepted: number; byGateway: Record<string, number>; errors: Record<string, number> }>('/admin/simulator/payments', { count, method, amountKobo: amount }),
    onSuccess: (r) => {
      const routed = Object.entries(r.byGateway).map(([g, n]) => `${g}: ${n}`).join(', ') || 'none';
      const errs = Object.entries(r.errors).map(([c, n]) => `${c} ×${n}`).join(', ');
      setLastFire(`${r.accepted}/${r.requested} accepted · routed ${routed}${errs ? ` · errors: ${errs}` : ''}`);
      refresh();
    },
  });
  const resetAll = useMutation({
    mutationFn: async () => {
      await Promise.all((['mockpay-a', 'mockpay-b'] as const).map((g) => post(`/admin/simulator/gateways/${g}/reset`)));
      await post('/admin/routing/reset');
    },
    onSuccess: refresh,
  });
  const poll = useMutation({ mutationFn: () => post<{ summary: Record<string, number> }>('/admin/simulator/poll') });
  const inject = useMutation({
    mutationFn: ({ action, body }: { action: 'phantom' | 'tamper' | 'omit'; body: object }) => post(`/admin/simulator/gateways/mockpay-a/settlements/${action}`, body),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Simulator</h1>
          <p className="text-sm text-slate-500">Break the mock gateways on purpose, fire test payments, and watch routing react.</p>
        </div>
        <Button variant="secondary" onClick={() => resetAll.mutate()}>Reset everything</Button>
      </div>
      <ErrorNote error={gateways.error ?? control.error ?? fire.error} />

      <Card title="Scenarios">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              onClick={() => {
                for (const [name, patch] of Object.entries(s.patches)) control.mutate({ name: name as GatewayName, patch: patch! });
              }}
              className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-400 hover:bg-indigo-50/50 dark:border-slate-800 dark:hover:bg-indigo-950/30"
            >
              <div className="text-sm font-semibold">{s.label}</div>
              <div className="text-xs text-slate-500">{s.description}</div>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title="Fire test payments (demo merchant)">
          <div className="grid grid-cols-3 gap-3">
            <label className="text-sm">
              Method
              <select className={`${inputClass} mt-1`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                <option value="card">card</option>
                <option value="bank_transfer">bank transfer</option>
              </select>
            </label>
            <label className="text-sm">
              Count
              <input type="number" min={1} max={50} className={`${inputClass} mt-1`} value={count} onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value))))} />
            </label>
            <label className="text-sm">
              Amount
              <select className={`${inputClass} mt-1`} value={amount} onChange={(e) => setAmount(Number(e.target.value))}>
                {[100_000, 500_000, 2_500_000, 10_000_000].map((k) => <option key={k} value={k}>{naira(k)}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => fire.mutate()} disabled={fire.isPending}>{fire.isPending ? 'Sending…' : `Send ${count} payments`}</Button>
            <Button variant="secondary" onClick={() => poll.mutate()} disabled={poll.isPending}>Run poller now</Button>
          </div>
          {lastFire && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{lastFire}</p>}
          {poll.data && <p className="mt-1 text-xs text-slate-500">Poller: {JSON.stringify(poll.data.summary)}</p>}
        </Card>
        <Card title="Live routing health">
          <RouteGrid compact />
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(gateways.data?.gateways ?? []).map((gw) => (
          <GatewayControls key={gw.name} gw={gw} onPatch={(patch) => control.mutate({ name: gw.name as GatewayName, patch })} />
        ))}
      </div>

      <Card title="Reconciliation fault injection (mockpay-a settlement report)">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => inject.mutate({ action: 'phantom', body: { amountKobo: 1_234_500 } })}>
            Add phantom settlement (missing in ledger)
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Then open Reconciliation and press "Import settlements &amp; run now". Use "Drop webhooks" without running the poller to produce a status mismatch.
        </p>
        {inject.isSuccess && <p className="mt-1 text-sm text-emerald-600">Injected.</p>}
        <div className="mt-2"><ErrorNote error={inject.error} /></div>
      </Card>
    </div>
  );
}
