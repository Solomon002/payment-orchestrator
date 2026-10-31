import { PAYMENT_METHODS, PAYMENT_STATUSES } from '@po/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, Button, Card, ErrorNote, inputClass, Mono, Table, td } from '../components/ui';
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
        <Table head={['Created', 'Reference', 'Merchant ref', 'Amount', 'Method', 'Gateway', 'Status']} empty={!query.isLoading && rows.length === 0}>
          {rows.map((p) => (
            <tr key={p.id} onClick={() => navigate(`/payments/${p.id}`)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className={td}>{dateTime(p.createdAt)}</td>
              <td className={td}><Mono>{shortRef(p.reference, 16)}</Mono></td>
              <td className={td}><Mono>{shortRef(p.merchantReference, 18)}</Mono></td>
              <td className={`${td} tabular text-right`}>{naira(p.amountKobo)}</td>
              <td className={td}>{p.method.replace('_', ' ')}</td>
              <td className={td}>{p.gateway ?? '-'}</td>
              <td className={td}><Badge value={p.status} /></td>
            </tr>
          ))}
        </Table>
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
