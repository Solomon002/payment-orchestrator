import { WEBHOOK_STATUSES } from '@po/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, ErrorNote, inputClass, Mono, Table, td } from '../components/ui';
import { api, type WebhookEvent } from '../lib/api';
import { dateTime, shortRef } from '../lib/format';

export function WebhooksPage() {
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['webhooks', status],
    queryFn: () => api<{ events: WebhookEvent[] }>(`/admin/webhooks${status ? `?status=${status}` : ''}`),
    refetchInterval: 3_000,
  });
  const detail = useQuery({
    queryKey: ['webhook', openId],
    queryFn: () => api<{ event: WebhookEvent }>(`/admin/webhooks/${openId}`),
    enabled: !!openId,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Webhook Events</h1>
          <p className="text-sm text-slate-500">Every webhook is stored raw, deduplicated by event id, and processed by the worker.</p>
        </div>
        <select className={`${inputClass} w-48`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {WEBHOOK_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ErrorNote error={list.error} />
      <Card>
        <Table head={['Received', 'Gateway', 'Event', 'Payment ref', 'Signature', 'Status', 'Attempts', 'Duplicates', 'Last error']} empty={list.data?.events.length === 0}>
          {list.data?.events.map((e) => (
            <tr key={e.id} onClick={() => setOpenId(openId === e.id ? null : e.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className={td}>{dateTime(e.receivedAt)}</td>
              <td className={td}>{e.gateway}</td>
              <td className={td}>{e.eventType ?? '-'}</td>
              <td className={td}><Mono>{shortRef(e.reference, 16)}</Mono></td>
              <td className={td}>{e.signatureValid ? <Badge value="succeeded">valid</Badge> : <Badge value="rejected">invalid</Badge>}</td>
              <td className={td}><Badge value={e.status} /></td>
              <td className={`${td} tabular`}>{e.attempts}</td>
              <td className={`${td} tabular`}>{e.duplicateCount > 0 ? <Badge value="pending">{e.duplicateCount} ignored</Badge> : 0}</td>
              <td className="max-w-xs truncate px-4 py-2 text-xs text-rose-600">{e.lastError ?? ''}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {openId && detail.data && (
        <Card title={`Raw body · ${detail.data.event.eventId}`}>
          <pre className="max-h-80 overflow-auto rounded-lg bg-slate-100 p-3 font-mono text-xs dark:bg-slate-950">
            {(() => {
              try {
                return JSON.stringify(JSON.parse(detail.data.event.rawBody ?? ''), null, 2);
              } catch {
                return detail.data.event.rawBody;
              }
            })()}
          </pre>
        </Card>
      )}
    </div>
  );
}
