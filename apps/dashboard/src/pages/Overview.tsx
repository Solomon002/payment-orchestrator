import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { DataList } from '../components/DataList';
import { Badge, Card, ErrorNote, Stat } from '../components/ui';
import { api, type Overview } from '../lib/api';
import { ago, naira, percent } from '../lib/format';

export function OverviewPage() {
  const { data, error } = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/admin/overview'), refetchInterval: 3_000 });

  const gateways = new Map<string, Record<string, number>>();
  for (const row of data?.byGateway ?? []) {
    const name = row.gateway ?? '(none)';
    gateways.set(name, { ...(gateways.get(name) ?? {}), [row.status]: row.count });
  }
  const successTone = data?.payments.successRate == null ? 'default' : data.payments.successRate >= 0.9 ? 'good' : data.payments.successRate >= 0.7 ? 'warn' : 'bad';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-slate-500">Live numbers, refreshed every 3 seconds.</p>
      </div>
      <ErrorNote error={error} />
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat label="Payments" value={data.payments.total} hint={`${data.payments.counts.pending ?? 0} pending`} />
            <Stat label="Success rate" value={percent(data.payments.successRate, 1)} tone={successTone} hint="succeeded / finished" />
            <Stat label="Succeeded volume" value={naira(data.payments.succeededVolumeKobo)} />
            <Stat
              label="Ledger check"
              value={data.ledgerCheck.balanced ? 'Balanced' : 'UNBALANCED'}
              tone={data.ledgerCheck.balanced ? 'good' : 'bad'}
              hint={`Sum of all postings: ${data.ledgerCheck.totalKobo} kobo`}
            />
            <Stat label="Webhooks processed" value={data.webhooks.counts.processed ?? 0} hint={`${data.webhooks.counts.queued ?? 0} queued · ${data.webhooks.counts.failed ?? 0} failed`} />
            <Stat label="Duplicates ignored" value={data.webhooks.duplicatesIgnored} hint="resent webhooks safely dropped" />
            <Stat label="Bad signatures" value={data.webhooks.counts.rejected ?? 0} tone={(data.webhooks.counts.rejected ?? 0) > 0 ? 'warn' : 'default'} />
            <Stat
              label="Open discrepancies"
              value={data.reconciliation.openDiscrepancies}
              tone={data.reconciliation.openDiscrepancies > 0 ? 'warn' : 'good'}
              hint={data.reconciliation.lastRun ? `last run ${ago(data.reconciliation.lastRun.startedAt)}` : 'never run'}
            />
          </div>

          <Card title="Payments by gateway" actions={<Link to="/payments" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">All payments →</Link>}>
            <DataList
              rows={[...gateways.entries()]}
              rowKey={([name]) => name}
              empty={gateways.size === 0}
              columns={[
                { header: 'Gateway', cell: ([name]) => name, mobile: 'title' },
                { header: 'Succeeded', cell: ([, c]) => <Badge value="succeeded">{c.succeeded ?? 0}</Badge> },
                { header: 'Pending', cell: ([, c]) => <Badge value="pending">{c.pending ?? 0}</Badge> },
                { header: 'Failed', cell: ([, c]) => <Badge value="failed">{c.failed ?? 0}</Badge> },
                { header: 'Expired', cell: ([, c]) => <Badge value="expired">{c.expired ?? 0}</Badge> },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
