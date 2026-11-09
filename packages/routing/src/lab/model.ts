// The simulated world for the routing lab.
//
// IMPORTANT: every number here is an ILLUSTRATIVE ASSUMPTION chosen to be
// plausible, not measured data from any real gateway, bank or NIBSS. The lab
// compares routing strategies under the SAME assumptions; it does not predict
// real-world success rates.
import type { PaymentMethod } from '@po/shared';
import { sampleExponential, sampleNormal, type Rng } from '../random';

export interface GatewaySpec {
  name: string;
  /** Percentage fee in basis points, plus a cap (kobo). */
  feeBps: number;
  feeCapKobo: number;
  /** Normal-day success probability of the gateway itself, per method. */
  base: Record<PaymentMethod, number>;
  /** Typical response time when things work. */
  latencyMs: number;
}

export const GATEWAYS: GatewaySpec[] = [
  { name: 'gw-a', feeBps: 150, feeCapKobo: 200_000, base: { card: 0.97, bank_transfer: 0.96 }, latencyMs: 350 },
  { name: 'gw-b', feeBps: 140, feeCapKobo: 200_000, base: { card: 0.965, bank_transfer: 0.955 }, latencyMs: 400 },
  { name: 'gw-c', feeBps: 100, feeCapKobo: 150_000, base: { card: 0.95, bank_transfer: 0.94 }, latencyMs: 450 },
];

export interface BankSpec {
  code: string;
  /** Share of customers. */
  share: number;
}

export const BANKS: BankSpec[] = [
  { code: '058', share: 0.22 },
  { code: '044', share: 0.2 },
  { code: '057', share: 0.18 },
  { code: '011', share: 0.15 },
  { code: '033', share: 0.15 },
  { code: '035', share: 0.1 },
];

/** Normal-day probability that the customer's bank side works. */
export const BANK_BASE_SUCCESS = 0.995;
/** How long a timed-out call wastes before we give up. */
export const TIMEOUT_MS = 5_000;
/** How long a fast error (e.g. HTTP 503) takes. */
export const FAST_ERROR_MS = 250;
/** Gateways tried at most per payment (failover). */
export const MAX_ATTEMPTS = 3;
/** When bank transfer is refused up front, chance the customer switches to card. */
export const SWITCH_TO_CARD_PROB = 0.5;

export function feeKobo(g: GatewaySpec, amountKobo: number): number {
  return Math.min(g.feeCapKobo, Math.floor((amountKobo * g.feeBps + 5_000) / 10_000));
}

// ---------- traffic ----------

export interface SimPayment {
  /** Arrival time (ms from start). */
  t: number;
  method: PaymentMethod;
  bank: string;
  amountKobo: number;
}

export interface TrafficSpec {
  durationMs: number;
  /** Payments per second (Poisson arrivals). */
  ratePerSec: number;
  cardShare: number;
  /** Median amount in kobo (amounts are log-normal). */
  medianAmountKobo: number;
}

export const DEFAULT_TRAFFIC: TrafficSpec = {
  durationMs: 120 * 60_000,
  ratePerSec: 2,
  cardShare: 0.6,
  medianAmountKobo: 800_000, // NGN 8,000
};

export function generateTraffic(rng: Rng, spec: TrafficSpec = DEFAULT_TRAFFIC): SimPayment[] {
  const out: SimPayment[] = [];
  let t = 0;
  for (;;) {
    t += sampleExponential(rng, 1_000 / spec.ratePerSec);
    if (t >= spec.durationMs) return out;
    let u = rng();
    let bank = BANKS[BANKS.length - 1]!.code;
    for (const b of BANKS) {
      if (u < b.share) {
        bank = b.code;
        break;
      }
      u -= b.share;
    }
    const amount = Math.round(spec.medianAmountKobo * Math.exp(0.9 * sampleNormal(rng)));
    out.push({
      t,
      method: rng() < spec.cardShare ? 'card' : 'bank_transfer',
      bank,
      amountKobo: Math.min(50_000_000, Math.max(10_000, amount)),
    });
  }
}

// ---------- incidents ----------

export interface Incident {
  label: string;
  startMs: number;
  endMs: number;
  /** 'gateway': the gateway/rail fails for everyone. 'bank': only that bank's customers fail. */
  level: 'gateway' | 'bank';
  gateway?: string;
  method?: PaymentMethod;
  bank?: string;
  /** Success probability while active (may vary with time, e.g. a slow degradation). */
  successAt: (tMs: number) => number;
  /** How failures look: a fast error, or a timeout that wastes TIMEOUT_MS. */
  mode: 'error' | 'timeout';
}

const matches = (i: Incident, gateway: string, method: PaymentMethod, bank: string) =>
  (!i.gateway || i.gateway === gateway) && (!i.method || i.method === method) && (!i.bank || i.bank === bank);

export interface AttemptResult {
  ok: boolean;
  /** Who failed (what a real gateway's error code would tell us). */
  scope: 'gateway' | 'bank';
  latencyMs: number;
}

/** Plays one gateway call in the simulated world. */
export function attempt(rng: Rng, incidents: Incident[], g: GatewaySpec, p: SimPayment, tMs: number): AttemptResult {
  let pGateway = g.base[p.method];
  let gatewayMode: Incident['mode'] = 'error';
  let pBank = BANK_BASE_SUCCESS;
  for (const i of incidents) {
    if (tMs < i.startMs || tMs >= i.endMs || !matches(i, g.name, p.method, p.bank)) continue;
    const s = i.successAt(tMs);
    if (i.level === 'gateway' && s < pGateway) {
      pGateway = s;
      gatewayMode = i.mode;
    }
    if (i.level === 'bank') pBank = Math.min(pBank, s);
  }
  const okLatency = Math.max(50, g.latencyMs * Math.exp(0.3 * sampleNormal(rng)));
  if (rng() >= pGateway) {
    return { ok: false, scope: 'gateway', latencyMs: gatewayMode === 'timeout' ? TIMEOUT_MS : FAST_ERROR_MS };
  }
  if (rng() >= pBank) return { ok: false, scope: 'bank', latencyMs: FAST_ERROR_MS };
  return { ok: true, scope: 'gateway', latencyMs: okLatency };
}
