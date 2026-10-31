import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorNote, inputClass, Mono, Table, td } from '../components/ui';
import { api, getAdminKey, post, type Discrepancy, type ReconRun } from '../lib/api';
import { dateTime, naira, shortRef } from '../lib/format';

const TYPE_HELP: Record<Discrepancy['type'], string> = {
  missing_in_ledger: 'Gateway settled money we have no payment for',
  missing_in_gateway: 'We recorded a success the gateway did not settle',
  amount_mismatch: 'Both sides have it, amounts or fees differ',
  status_mismatch: 'Gateway settled it; our payment is not succeeded',
};

export function ReconciliationPage() {
  const qc = useQueryClient();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
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
      const res = await fetch('/api/admin/reconciliation/settlements/upload', {
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
        <Table head={['Type', 'Gateway', 'Reference', 'Ledger', 'Gateway', 'Note', '']} empty={open.data?.discrepancies.length === 0}>
          {open.data?.discrepancies.map((d) => (
            <tr key={d.id}>
              <td className={td} title={TYPE_HELP[d.type]}><Badge value="failed">{d.type.replaceAll('_', ' ')}</Badge></td>
              <td className={td}>{d.gateway}</td>
              <td className={td}><Mono>{shortRef(d.gatewayReference, 18)}</Mono></td>
              <td className={`${td} tabular text-right`}>{naira(d.ledgerAmount)}</td>
              <td className={`${td} tabular text-right`}>{naira(d.gatewayAmount)}</td>
              <td className="px-4 py-2 text-xs text-slate-500">{d.note}</td>
              <td className={td}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const note = window.prompt('Resolution note (what did you find?)');
                    if (note && note.length >= 3) resolve.mutate({ id: d.id, note });
                  }}
                >
                  Resolve
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Runs">
        <Table head={['Started', 'Status', 'Settlements', 'Payments', 'Matched', 'Discrepancies']} empty={runs.data?.runs.length === 0}>
          {runs.data?.runs.map((r) => (
            <tr key={r.id} onClick={() => setSelectedRun(r.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className={td}>{dateTime(r.startedAt)}</td>
              <td className={td}><Badge value={r.status} /></td>
              <td className={`${td} tabular`}>{r.totals?.settlementsChecked ?? '-'}</td>
              <td className={`${td} tabular`}>{r.totals?.paymentsChecked ?? '-'}</td>
              <td className={`${td} tabular`}>{r.totals?.matched ?? '-'}</td>
              <td className={`${td} tabular`}>{r.totals ? (r.totals.discrepancies > 0 ? <Badge value="failed">{r.totals.discrepancies}</Badge> : <Badge value="succeeded">0</Badge>) : '-'}</td>
            </tr>
          ))}
        </Table>
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
          <Table head={['Type', 'Gateway', 'Reference', 'Ledger', 'Gateway', 'Resolved']} empty={run.data.run.discrepancies?.length === 0}>
            {run.data.run.discrepancies?.map((d) => (
              <tr key={d.id}>
                <td className={td}>{d.type.replaceAll('_', ' ')}</td>
                <td className={td}>{d.gateway}</td>
                <td className={td}><Mono>{shortRef(d.gatewayReference, 18)}</Mono></td>
                <td className={`${td} tabular text-right`}>{naira(d.ledgerAmount)}</td>
                <td className={`${td} tabular text-right`}>{naira(d.gatewayAmount)}</td>
                <td className={td}>{d.resolved ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Upload a settlement CSV (for gateways without a settlement API)">
        <p className="mb-2 text-xs text-slate-500">
          Header: <Mono>gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id</Mono>
        </p>
        <textarea className={`${inputClass} h-28 font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id" />
        <div className="mt-2 flex items-center gap-3">
          <Button variant="secondary" onClick={() => upload.mutate()} disabled={!csv.trim() || upload.isPending}>Upload</Button>
          {csvResult && <span className="text-sm text-emerald-600">{csvResult}</span>}
        </div>
        <div className="mt-2"><ErrorNote error={upload.error} /></div>
      </Card>
    </div>
  );
}
