import { PAYMENT_METHODS, PAYMENT_STATUSES } from '@po/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { DataList } from '../components/DataList';
import { Badge, Button, Card, ErrorNote, inputClass, Mono } from '../components/ui';
import { api, type Payment } from '../lib/api';
import { dateTime, naira, shortRef } from '../lib/format';

export function PaymentsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ status: '', method: '', gateway: '', q: '' });

  const query = useInfiniteQuery({
    queryKey: ['payments', filters],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      if (pageParam) params.set('cursor', pageParam);
      return api<{ payments: Payment[]; nextCursor: string | null }>(`/admin/payments?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 4_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.payments) ?? [];
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Payments</h1>
      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <select className={inputClass} value={filters.status} onChange={set('status')} aria-label="Status">
            <option value="">All statuses</option>
            {PAYMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className={inputClass} value={filters.method} onChange={set('method')} aria-label="Method">
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select className={inputClass} value={filters.gateway} onChange={set('gateway')} aria-label="Gateway">
            <option value="">All gateways</option>
            <option>mockpay-a</option>
            <option>mockpay-b</option>
            <option>paystack</option>
          </select>
          <input className={inputClass} placeholder="Search reference or email" value={filters.q} onChange={set('q')} />
        </div>
      </Card>
      <ErrorNote error={query.error} />
      <Card>
        <DataList
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/payments/${p.id}`)}
          empty={!query.isLoading && rows.length === 0}
          columns={[
            { header: 'Created', cell: (p) => dateTime(p.createdAt) },
            { header: 'Reference', cell: (p) => <Mono>{shortRef(p.reference, 16)}</Mono> },
            { header: 'Merchant ref', cell: (p) => <Mono>{shortRef(p.merchantReference, 18)}</Mono>, mobile: 'hide' },
            { header: 'Amount', cell: (p) => <span className="tabular">{naira(p.amountKobo)}</span>, align: 'right', mobile: 'title' },
            { header: 'Method', cell: (p) => p.method.replace('_', ' ') },
            { header: 'Gateway', cell: (p) => p.gateway ?? '-' },
            { header: 'Status', cell: (p) => <Badge value={p.status} />, mobile: 'badge' },
          ]}
        />
        {query.hasNextPage && (
          <div className="mt-4 text-center">
            <Button variant="secondary" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
