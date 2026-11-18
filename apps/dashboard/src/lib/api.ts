// Tiny fetch wrapper for the admin API. The admin key lives in sessionStorage
// (cleared when the tab closes) and is sent as X-Admin-Key. All requests go to
// /api on the dashboard's own origin; Vite proxies them to the API.
import type { MockControl, PaymentMethod, RouteState } from '@po/shared';

const STORAGE_KEY = 'po-admin-key';

/**
 * Where the API lives. Locally the Vite dev server proxies /api to it. In
 * production (dashboard on Vercel, API on Railway) set VITE_API_URL at build
 * time to the API's public URL; the API allows this origin via CORS.
 */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '/api';

export function getAdminKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminKey(key: string | null) {
  try {
    if (key) sessionStorage.setItem(STORAGE_KEY, key);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: key lives only for this page load */
  }
  window.dispatchEvent(new Event('po-auth-changed'));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const key = getAdminKey();
  if (key) headers.set('x-admin-key', key);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (res.status === 401) setAdminKey(null);
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `HTTP ${res.status}`, err.details);
  }
  return body as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

// ---------- Response types (mirror the admin API) ----------

export interface Payment {
  id: string;
  reference: string;
  merchantReference: string;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired';
  amountKobo: number;
  feeKobo: number | null;
  method: PaymentMethod;
  customerEmail: string;
  gateway: string | null;
  checkoutUrl: string | null;
  failureReason: string | null;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Overview {
  payments: { counts: Record<string, number>; total: number; succeededVolumeKobo: number; successRate: number | null };
  byGateway: { gateway: string | null; status: string; count: number }[];
  webhooks: { counts: Record<string, number>; duplicatesIgnored: number };
  reconciliation: { openDiscrepancies: number; lastRun: ReconRun | null };
  ledgerCheck: { totalKobo: number; balanced: boolean };
}

export interface RouteHealth {
  gateway: string;
  method: PaymentMethod;
  bankCode: string | null;
  state: RouteState;
  samples: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  degradedUntil: string | null;
  probeSuccesses: number;
  lastChange: string | null;
  reason: string | null;
  /** Thompson posterior-mean success probability. */
  expectedSuccess: number;
  decayed: { successes: number; failures: number };
}

export interface RoutingHealth {
  mode: string;
  strategy?: 'hybrid' | 'breaker' | 'thompson' | 'thompson_cost';
  thresholds?: { windowSize: number; minSamples: number; minSuccessRate: number; cooldownMs: number; probeSuccesses: number };
  routes: RouteHealth[];
  bankRoutes?: RouteHealth[];
}

export interface WebhookEvent {
  id: string;
  gateway: string;
  eventId: string;
  eventType: string | null;
  reference: string | null;
  signatureValid: boolean;
  status: string;
  attempts: number;
  duplicateCount: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
  rawBody?: string;
}

export interface Discrepancy {
  id: string;
  runId: string;
  type: 'missing_in_ledger' | 'missing_in_gateway' | 'amount_mismatch' | 'status_mismatch';
  gateway: string;
  paymentId: string | null;
  gatewayReference: string | null;
  ledgerAmount: number | null;
  gatewayAmount: number | null;
  note: string | null;
  resolved: boolean;
  resolvedNote: string | null;
  createdAt: string;
}

export interface ReconRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  windowFrom: string;
  windowTo: string;
  totals: { settlementsChecked: number; paymentsChecked: number; matched: number; discrepancies: number; byType: Record<string, number> } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  discrepancies?: Discrepancy[];
}

export interface Delivery {
  eventId: string;
  reference: string;
  mode: string;
  attempts: number;
  lastStatus: number | string | null;
  at: string;
}

export interface MockGatewayState {
  name: string;
  online: boolean;
  control?: MockControl;
  stats?: { charges: number; succeeded: number; failed: number; pending: number };
  recentDeliveries?: Delivery[];
}

// ---------- Public demo ----------

export interface DemoInfo {
  enabled: boolean;
  resetIntervalMinutes?: number;
  nextResetAt?: string | null;
  sessionMinutes?: number;
  limits?: { paymentsPerClick: number; paymentsPerHour: number };
}

export interface Me {
  role: 'owner' | 'demo';
  expiresAt: string | null;
  nextResetAt: string | null;
}

/** Unauthenticated: is the public demo on? */
export async function getDemoInfo(): Promise<DemoInfo> {
  const res = await fetch(`${API_BASE}/demo/info`);
  if (!res.ok) return { enabled: false };
  return (await res.json()) as DemoInfo;
}

/** Starts a temporary demo session and signs in with it. */
export async function startDemoSession(): Promise<void> {
  const res = await fetch(`${API_BASE}/demo/session`, { method: 'POST' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? 'Could not start the demo');
  setAdminKey(body.token as string);
}
