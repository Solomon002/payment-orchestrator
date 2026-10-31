import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { Button, cx, inputClass } from './components/ui';
import { api, getAdminKey, setAdminKey } from './lib/api';
import { GatewayHealthPage } from './pages/GatewayHealth';
import { OverviewPage } from './pages/Overview';
import { PaymentDetailPage } from './pages/PaymentDetail';
import { PaymentsPage } from './pages/Payments';
import { ReconciliationPage } from './pages/Reconciliation';
import { SimulatorPage } from './pages/Simulator';
import { WebhooksPage } from './pages/Webhooks';

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/payments', label: 'Payments' },
  { to: '/health', label: 'Gateway Health' },
  { to: '/webhooks', label: 'Webhooks' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/simulator', label: 'Simulator' },
];

function useAdminKey() {
  const [key, setKey] = useState(getAdminKey);
  useEffect(() => {
    const onChange = () => setKey(getAdminKey());
    window.addEventListener('po-auth-changed', onChange);
    return () => window.removeEventListener('po-auth-changed', onChange);
  }, []);
  return key;
}

function Login() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAdminKey(value.trim());
    try {
      await api('/admin/overview');
    } catch (err) {
      setAdminKey(null);
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-semibold">Payment Orchestrator</h1>
          <p className="mt-1 text-sm text-slate-500">Admin dashboard. Enter the <code className="font-mono">ADMIN_API_KEY</code> from your <code className="font-mono">.env</code>.</p>
        </div>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Admin key" className={inputClass} />
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <Button type="submit" disabled={busy || value.length < 8} className="w-full">
          {busy ? 'Checking…' : 'Sign in'}
        </Button>
        <p className="text-xs text-slate-500">The key is kept in this tab's session storage only. Portfolio demo, test mode, no real money.</p>
      </form>
    </div>
  );
}

export function App() {
  const key = useAdminKey();
  const queryClient = useQueryClient();
  if (!key) return <Login />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-indigo-500" />
            Payment Orchestrator
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-300">test mode</span>
          </div>
          <nav className="-mx-1 flex flex-1 gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium',
                    isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <Button
            variant="secondary"
            onClick={() => {
              setAdminKey(null);
              queryClient.clear();
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/payments/:id" element={<PaymentDetailPage />} />
          <Route path="/health" element={<GatewayHealthPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/simulator" element={<SimulatorPage />} />
          <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
