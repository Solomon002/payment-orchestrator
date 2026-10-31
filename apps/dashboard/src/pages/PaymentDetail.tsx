import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, Card, ErrorNote, Mono, Table, td } from '../components/ui';
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
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tabular">{naira(data.payment.amountKobo)}</h1>
            <Badge value={data.payment.status} />
            <span className="text-sm text-slate-500">{data.payment.method.replace('_', ' ')} via {data.payment.gateway ?? 'no gateway'}</span>
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
                <div key={i} className="flex justify-between gap-4 border-b border-slate-100 py-1 dark:border-slate-800">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Gateway attempts (failover history)">
            <Table head={['#', 'Gateway', 'Result', 'Latency', 'Error']} empty={data.attempts.length === 0}>
              {data.attempts.map((a, i) => (
                <tr key={a.id}>
                  <td className={td}>{i + 1}</td>
                  <td className={td}>{a.gateway}</td>
                  <td className={td}><Badge value={a.status} /></td>
                  <td className={`${td} tabular`}>{a.latencyMs ?? '-'} ms</td>
                  <td className="px-4 py-2 text-xs text-rose-600">{a.error ?? ''}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Ledger entries (each sums to zero)">
            <div className="space-y-4">
              {data.journalEntries.map((je) => {
                const sum = je.postings.reduce((s, p) => s + p.amountKobo, 0);
                return (
                  <div key={je.id}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                      <div className="text-sm font-medium">{je.description}</div>
                      <Mono>{je.reference}</Mono>
                    </div>
                    <Table head={['Account', 'Debit', 'Credit']}>
                      {je.postings.map((p, i) => (
                        <tr key={i}>
                          <td className={td}><Mono>{p.account}</Mono></td>
                          <td className={`${td} tabular text-right`}>{p.amountKobo > 0 ? naira(p.amountKobo) : ''}</td>
                          <td className={`${td} tabular text-right`}>{p.amountKobo < 0 ? naira(-p.amountKobo) : ''}</td>
                        </tr>
                      ))}
                      <tr className="font-medium">
                        <td className={td}>Total</td>
                        <td colSpan={2} className={`${td} text-right ${sum === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{sum === 0 ? 'balanced (0)' : `UNBALANCED ${sum}`}</td>
                      </tr>
                    </Table>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Webhooks for this payment">
            <Table head={['Received', 'Gateway', 'Event', 'Status', 'Duplicates ignored', 'Attempts']} empty={data.webhooks.length === 0}>
              {data.webhooks.map((w) => (
                <tr key={w.id}>
                  <td className={td}>{dateTime(w.receivedAt)}</td>
                  <td className={td}>{w.gateway}</td>
                  <td className={td}>{w.eventType}</td>
                  <td className={td}><Badge value={w.status} /></td>
                  <td className={`${td} tabular`}>{w.duplicateCount}</td>
                  <td className={`${td} tabular`}>{w.attempts}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
