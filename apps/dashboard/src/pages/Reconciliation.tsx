import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataList } from '../components/DataList';
import { Badge, Button, Card, ErrorNote, inputClass, Mono } from '../components/ui';
import { api, API_BASE, getAdminKey, post, type Discrepancy, type ReconRun } from '../lib/api';
import { dateTime, naira, shortRef } from '../lib/format';
import { useMe } from '../lib/useMe';

const TYPE_HELP: Record<Discrepancy['type'], string> = {
  missing_in_ledger: 'Gateway settled money we have no payment for',
  missing_in_gateway: 'We recorded a success the gateway did not settle',
  amount_mismatch: 'Both sides have it, amounts or fees differ',
  status_mismatch: 'Gateway settled it; our payment is not succeeded',
};

export function ReconciliationPage() {
  const qc = useQueryClient();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const { isDemo } = useMe();
  const [csv, setCsv] = useState('');
  const [csvResult, setCsvResult] = useState<string | null>(null);

  const runs = useQuery({ queryKey: ['recon-runs'], queryFn: () => api<{ runs: ReconRun[] }>('/admin/reconciliation/runs'), refetchInterval: 5_000 });
  const open = useQuery({
    queryKey: ['discrepancies'],
    queryFn: () => api<{ discrepancies: Discrepancy[] }>('/admin/reconciliation/discrepancies?resolved=false'),
    refetchInterval: 5_000,
  });
  const run = useQuery({
    queryKey: ['recon-run', selectedRun],
    queryFn: () => api<{ run: ReconRun }>(`/admin/reconciliation/runs/${selectedRun}`),
    enabled: !!selectedRun,
  });

  const runNow = useMutation({
    mutationFn: () => post<{ run: ReconRun }>('/admin/reconciliation/run', {}),
    onSuccess: (data) => {
      setSelectedRun(data.run.id);
      void qc.invalidateQueries({ queryKey: ['recon-runs'] });
      void qc.invalidateQueries({ queryKey: ['discrepancies'] });
    },
  });
  const resolve = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => post(`/admin/reconciliation/discrepancies/${id}/resolve`, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discrepancies'] }),
  });
  const upload = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/admin/reconciliation/settlements/upload`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-admin-key': getAdminKey() ?? '' },
        body: csv,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed');
      return body;
    },
    onSuccess: (body) => setCsvResult(`Imported: ${JSON.stringify(body.imported)}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reconciliation</h1>
          <p className="text-sm text-slate-500">Our ledger vs gateway settlement reports. Runs nightly at 02:00 (Africa/Lagos) and on demand.</p>
        </div>
        <Button onClick={() => runNow.mutate()} disabled={runNow.isPending}>{runNow.isPending ? 'Running…' : 'Import settlements & run now'}</Button>
      </div>
      <ErrorNote error={runNow.error ?? runs.error} />

      <Card title={`Open discrepancies (${open.data?.discrepancies.length ?? 0})`}>
        <DataList
          rows={open.data?.discrepancies ?? []}
          rowKey={(d) => d.id}
          empty={open.data?.discrepancies.length === 0}
          columns={[
            { header: 'Type', cell: (d) => <span title={TYPE_HELP[d.type]}><Badge value="failed">{d.type.replaceAll('_', ' ')}</Badge></span>, mobile: 'title' },
            { header: 'Gateway', cell: (d) => d.gateway },
            { header: 'Reference', cell: (d) => <Mono>{shortRef(d.gatewayReference, 18)}</Mono> },
            { header: 'Ledger', cell: (d) => naira(d.ledgerAmount), align: 'right' },
            { header: 'Gateway amount', cell: (d) => naira(d.gatewayAmount), align: 'right' },
            { header: 'Note', cell: (d) => <span className="whitespace-normal text-xs text-slate-500">{d.note}</span> },
            {
              header: 'Action',
              mobile: 'badge',
              cell: (d) =>
                isDemo ? (
                  <span className="text-xs text-slate-400" title="Resolving is not available in the public demo">Owner only</span>
                ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const note = window.prompt('Resolution note (what did you find?)');
                    if (note && note.length >= 3) resolve.mutate({ id: d.id, note });
                  }}
                >
                  Resolve
                </Button>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Runs">
        <DataList
          rows={runs.data?.runs ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedRun(r.id)}
          empty={runs.data?.runs.length === 0}
          columns={[
            { header: 'Started', cell: (r) => dateTime(r.startedAt), mobile: 'title' },
            { header: 'Status', cell: (r) => <Badge value={r.status} />, mobile: 'badge' },
            { header: 'Settlements', cell: (r) => <span className="tabular">{r.totals?.settlementsChecked ?? '-'}</span> },
            { header: 'Payments', cell: (r) => <span className="tabular">{r.totals?.paymentsChecked ?? '-'}</span> },
            { header: 'Matched', cell: (r) => <span className="tabular">{r.totals?.matched ?? '-'}</span> },
            {
              header: 'Discrepancies',
              cell: (r) => (r.totals ? (r.totals.discrepancies > 0 ? <Badge value="failed">{r.totals.discrepancies}</Badge> : <Badge value="succeeded">0</Badge>) : '-'),
            },
          ]}
        />
      </Card>

      {run.data && (
        <Card title={`Run ${run.data.run.id.slice(0, 8)} · ${run.data.run.discrepancies?.length ?? 0} discrepancies`}>
          {run.data.run.totals && (
            <div className="mb-3 flex flex-wrap gap-2">
              {Object.entries(run.data.run.totals.byType).map(([type, n]) => (
                <Badge key={type} value={n > 0 ? 'failed' : 'succeeded'}>{type.replaceAll('_', ' ')}: {n}</Badge>
              ))}
            </div>
          )}
          <DataList
            rows={run.data.run.discrepancies ?? []}
            rowKey={(d) => d.id}
            empty={run.data.run.discrepancies?.length === 0}
            columns={[
              { header: 'Type', cell: (d) => d.type.replaceAll('_', ' '), mobile: 'title' },
              { header: 'Gateway', cell: (d) => d.gateway },
              { header: 'Reference', cell: (d) => <Mono>{shortRef(d.gatewayReference, 18)}</Mono> },
              { header: 'Ledger', cell: (d) => naira(d.ledgerAmount), align: 'right' },
              { header: 'Gateway amount', cell: (d) => naira(d.gatewayAmount), align: 'right' },
              { header: 'Resolved', cell: (d) => (d.resolved ? 'yes' : 'no'), mobile: 'badge' },
            ]}
          />
        </Card>
      )}

      {isDemo ? (
        <Card title="Upload a settlement CSV">
          <p className="text-sm text-slate-500">Uploading settlement files is turned off in the public demo. The owner uses it for gateways without a settlement API (e.g. Paystack).</p>
        </Card>
      ) : (
      <Card title="Upload a settlement CSV (for gateways without a settlement API)">
        <p className="mb-2 break-all text-xs text-slate-500">
          Header: <Mono>gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id</Mono>
        </p>
        <textarea className={`${inputClass} h-28 font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id" />
        <div className="mt-2 flex items-center gap-3">
          <Button variant="secondary" onClick={() => upload.mutate()} disabled={!csv.trim() || upload.isPending}>Upload</Button>
          {csvResult && <span className="text-sm text-emerald-600">{csvResult}</span>}
        </div>
        <div className="mt-2"><ErrorNote error={upload.error} /></div>
      </Card>
      )}
    </div>
  );
}
