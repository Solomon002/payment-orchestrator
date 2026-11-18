import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { Button, cx, inputClass } from './components/ui';
import { api, getAdminKey, getDemoInfo, setAdminKey, startDemoSession } from './lib/api';
import { useMe } from './lib/useMe';
import { GatewayHealthPage } from './pages/GatewayHealth';
import { OverviewPage } from './pages/Overview';
import { PaymentDetailPage } from './pages/PaymentDetail';
import { PaymentsPage } from './pages/Payments';
import { ReconciliationPage } from './pages/Reconciliation';
import { RoutingLabPage } from './pages/RoutingLab';
import { SimulatorPage } from './pages/Simulator';
import { WebhooksPage } from './pages/Webhooks';

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/payments', label: 'Payments' },
  { to: '/health', label: 'Gateway Health' },
  { to: '/lab', label: 'Routing Lab' },
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
  const { data: demo, isLoading: connecting } = useQuery({ queryKey: ['demo-info'], queryFn: getDemoInfo });
  // On free hosting the server sleeps when idle; the first request can take a while.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2_000);
    return () => clearTimeout(t);
  }, []);

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

  async function tryDemo() {
    setBusy(true);
    setError(null);
    try {
      await startDemoSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the demo');
    } finally {
      setBusy(false);
    }
  }

  const ownerForm = (
    <form onSubmit={submit} className="space-y-3">
      <input type="password" autoFocus={!demo?.enabled} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Admin key" aria-label="Admin key" className={inputClass} />
      <Button type="submit" variant={demo?.enabled ? 'secondary' : 'primary'} disabled={busy || value.length < 8} className="w-full">
        {busy ? 'Checking…' : 'Sign in'}
      </Button>
    </form>
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-semibold">Payment Orchestrator</h1>
          <p className="mt-1 text-sm text-slate-500">
            A portfolio payment layer: multi-gateway routing, a double-entry ledger, safe webhooks and reconciliation. Test mode, mock gateways, no real money.
          </p>
        </div>

        {connecting && slow && (
          <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Waking up the server… It runs on a free tier that sleeps when idle, so the first visit can take up to a minute.
          </div>
        )}
        {demo?.enabled ? (
          <>
            <Button onClick={tryDemo} disabled={busy} className="w-full py-2.5 text-base">
              {busy ? 'Starting…' : 'Try the live demo'}
            </Button>
            <p className="text-xs text-slate-500">
              No sign-up. A shared sandbox: break the fake gateways, send test payments, watch routing react. Resets every {demo.resetIntervalMinutes} minutes.
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500">Owner sign-in</summary>
              <div className="mt-3">{ownerForm}</div>
            </details>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-500">
              Enter the <code className="font-mono">ADMIN_API_KEY</code> from your <code className="font-mono">.env</code>.
            </p>
            {ownerForm}
          </>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <p className="text-xs text-slate-500">Your session is kept in this browser tab only.</p>
      </div>
    </div>
  );
}

/** Renders the demo banner only for demo visitors (a component so the hook runs only when signed in). */
function RoleBanner() {
  const { me, isDemo } = useMe();
  return isDemo ? <DemoBanner nextResetAt={me?.nextResetAt ?? null} /> : null;
}

/** Shown to public demo visitors on every page. */
function DemoBanner({ nextResetAt }: { nextResetAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const minutes = nextResetAt ? Math.max(0, Math.ceil((Date.parse(nextResetAt) - now) / 60_000)) : null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <strong>Public demo</strong> · test mode, fake money · shared with other visitors
      {minutes !== null && <> · resets in {minutes} min</>}
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    'whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium xl:py-1.5',
    isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  );

export function App() {
  const key = useAdminKey();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]); // close the phone menu after navigating
  if (!key) return <Login />;

  const signOut = () => {
    setAdminKey(null);
    queryClient.clear();
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center gap-x-6 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 font-semibold xl:flex-none">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-500" />
            <span className="truncate">Payment Orchestrator</span>
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-300">test mode</span>
          </div>
          {/* Wide screens: inline nav (7 links need ~1280px) */}
          <nav className="hidden flex-1 gap-1 xl:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navLinkClass}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="hidden xl:block">
            <Button variant="secondary" onClick={signOut}>
              Sign out
            </Button>
          </div>
          {/* Phone: menu button */}
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="-mr-2 rounded-lg p-2 text-slate-600 hover:bg-slate-100 xl:hidden dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" className="flex flex-col gap-1 border-t border-slate-200 px-4 py-3 xl:hidden dark:border-slate-800">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navLinkClass}>
                {n.label}
              </NavLink>
            ))}
            <Button variant="secondary" onClick={signOut} className="mt-2">
              Sign out
            </Button>
          </nav>
        )}
        <RoleBanner />
      </header>
      <main className="mx-auto max-w-7xl px-4 py-4 sm:py-6">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/payments/:id" element={<PaymentDetailPage />} />
          <Route path="/health" element={<GatewayHealthPage />} />
          <Route path="/lab" element={<RoutingLabPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/simulator" element={<SimulatorPage />} />
          <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
