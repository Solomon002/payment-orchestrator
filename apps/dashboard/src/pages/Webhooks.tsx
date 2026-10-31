import { WEBHOOK_STATUSES } from '@po/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataList } from '../components/DataList';
import { Badge, Card, ErrorNote, inputClass, Mono } from '../components/ui';
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
        <select className={`${inputClass} sm:w-48`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {WEBHOOK_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ErrorNote error={list.error} />
      <Card>
        <DataList
          rows={list.data?.events ?? []}
          rowKey={(e) => e.id}
          onRowClick={(e) => setOpenId(openId === e.id ? null : e.id)}
          empty={list.data?.events.length === 0}
          columns={[
            { header: 'Received', cell: (e) => dateTime(e.receivedAt) },
            { header: 'Gateway', cell: (e) => e.gateway },
            { header: 'Event', cell: (e) => e.eventType ?? '-', mobile: 'title' },
            { header: 'Payment ref', cell: (e) => <Mono>{shortRef(e.reference, 16)}</Mono> },
            { header: 'Signature', cell: (e) => (e.signatureValid ? <Badge value="succeeded">valid</Badge> : <Badge value="rejected">invalid</Badge>) },
            { header: 'Status', cell: (e) => <Badge value={e.status} />, mobile: 'badge' },
            { header: 'Attempts', cell: (e) => <span className="tabular">{e.attempts}</span> },
            { header: 'Duplicates', cell: (e) => (e.duplicateCount > 0 ? <Badge value="pending">{e.duplicateCount} ignored</Badge> : 0) },
            { header: 'Last error', cell: (e) => <span className="block max-w-xs truncate text-xs text-rose-600">{e.lastError ?? ''}</span>, mobile: 'hide' },
          ]}
        />
      </Card>
      {openId && detail.data && (
        <Card title={`Raw body · ${detail.data.event.eventId}`}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-100 p-3 font-mono text-xs dark:bg-slate-950">
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
