import { useQuery } from '@tanstack/react-query';
import { api, type Me } from './api';

/** Who is signed in: the owner, or a public demo visitor. */
export function useMe() {
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/admin/me'), refetchInterval: 60_000 });
  return { me: q.data, isDemo: q.data?.role === 'demo' };
}
