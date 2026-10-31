import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { DataList } from '../components/DataList';
import { Badge, Card, ErrorNote, Mono } from '../components/ui';
import { api, type Payment, type WebhookEvent } from '../lib/api';
import { dateTime, naira } from '../lib/format';

interface Detail {
  payment: Payment;
  merchant: { id: string; name: string };
  attempts: { id: string; gateway: string; status: string; error: string | null; latencyMs: number | null; startedAt: string; gatewayReference: string | null }[];
  journalEntries: { id: string; reference: string; description: string; createdAt: string; postings: { account: string; type: string; amountKobo: number }[] }[];
  webhooks: WebhookEvent[];
}

export function PaymentDetailPage() {
  const { id } = useParams();
  const { data, error } = useQuery({ queryKey: ['payment', id], queryFn: () => api<Detail>(`/admin/payments/${id}`), refetchInterval: 3_000 });

  return (
    <div className="space-y-4">
      <Link to="/payments" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">← Payments</Link>
      <ErrorNote error={error} />
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tabular">{naira(data.payment.amountKobo)}</h1>
            <Badge value={data.payment.status} />
            <span className="w-full text-sm text-slate-500 sm:w-auto">{data.payment.method.replace('_', ' ')} via {data.payment.gateway ?? 'no gateway'}</span>
          </div>

          <Card title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[
                ['Our reference', <Mono key="r">{data.payment.reference}</Mono>],
                ['Merchant reference', <Mono key="m">{data.payment.merchantReference}</Mono>],
                ['Merchant', data.merchant.name],
                ['Customer', data.payment.customerEmail],
                ['Gateway fee', naira(data.payment.feeKobo)],
                ['Failure reason', data.payment.failureReason ?? '-'],
                ['Created', dateTime(data.payment.createdAt)],
                ['Succeeded', dateTime(data.payment.succeededAt)],
              ].map(([k, v], i) => (
                // Phones: label above value, so long references wrap instead of overflowing.
                <div key={i} className="flex flex-col gap-0.5 border-b border-slate-100 py-1 sm:flex-row sm:justify-between sm:gap-4 dark:border-slate-800">
                  <dt className="shrink-0 text-slate-500">{k}</dt>
                  <dd className="min-w-0 break-all sm:text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Gateway attempts (failover history)">
            <DataList
              rows={data.attempts.map((a, i) => ({ ...a, n: i + 1 }))}
              rowKey={(a) => a.id}
              empty={data.attempts.length === 0}
              columns={[
                { header: '#', cell: (a) => a.n, mobile: 'hide' },
                { header: 'Gateway', cell: (a) => `${a.n}. ${a.gateway}`, mobile: 'title' },
                { header: 'Result', cell: (a) => <Badge value={a.status} />, mobile: 'badge' },
                { header: 'Latency', cell: (a) => <span className="tabular">{a.latencyMs ?? '-'} ms</span> },
                { header: 'Error', cell: (a) => <span className="whitespace-normal text-xs text-rose-600">{a.error ?? ''}</span> },
              ]}
            />
          </Card>

          <Card title="Ledger entries (each sums to zero)">
            <div className="space-y-5">
              {data.journalEntries.map((je) => {
                const sum = je.postings.reduce((s, p) => s + p.amountKobo, 0);
                return (
                  <div key={je.id}>
                    <div className="mb-1 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
                      <div className="break-words text-sm font-medium">{je.description}</div>
                      <span className="break-all"><Mono>{je.reference}</Mono></span>
                    </div>
                    <DataList
                      rows={je.postings.map((p, i) => ({ ...p, i }))}
                      rowKey={(p) => String(p.i)}
                      columns={[
                        { header: 'Account', cell: (p) => <span className="break-all"><Mono>{p.account}</Mono></span>, mobile: 'title' },
                        { header: 'Debit', cell: (p) => (p.amountKobo > 0 ? naira(p.amountKobo) : ''), align: 'right', mobile: 'hide' },
                        { header: 'Credit', cell: (p) => (p.amountKobo < 0 ? naira(-p.amountKobo) : ''), align: 'right', mobile: 'hide' },
                        {
                          header: 'Dr/Cr',
                          cell: (p) => (
                            <span className="tabular text-sm">
                              {p.amountKobo > 0 ? 'Dr' : 'Cr'} {naira(Math.abs(p.amountKobo))}
                            </span>
                          ),
                          mobile: 'badge',
                          desktopHide: true, // desktop shows separate Debit / Credit columns instead
                        },
                      ]}
                      footer={
                        <div className={`flex justify-between text-sm font-medium ${sum === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          <span>Total</span>
                          <span>{sum === 0 ? 'balanced (0)' : `UNBALANCED ${sum}`}</span>
                        </div>
                      }
                    />
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Webhooks for this payment">
            <DataList
              rows={data.webhooks}
              rowKey={(w) => w.id}
              empty={data.webhooks.length === 0}
              columns={[
                { header: 'Received', cell: (w) => dateTime(w.receivedAt) },
                { header: 'Gateway', cell: (w) => w.gateway },
                { header: 'Event', cell: (w) => w.eventType, mobile: 'title' },
                { header: 'Status', cell: (w) => <Badge value={w.status} />, mobile: 'badge' },
                { header: 'Duplicates ignored', cell: (w) => <span className="tabular">{w.duplicateCount}</span> },
                { header: 'Attempts', cell: (w) => <span className="tabular">{w.attempts}</span> },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
