import type { PaymentMethod } from '@po/shared';
import type { FailureScope } from '../gateways/gateway.types';

export interface CandidateRequest {
  /** Customer's bank, if known: enables bank-level health. */
  bankCode?: string | null;
  /** Payment amount, used by cost-aware routing. */
  amountKobo?: number;
}

export interface RouteOutcome {
  gateway: string;
  method: PaymentMethod;
  bankCode?: string | null;
  ok: boolean;
  latencyMs: number;
  /** Who failed (from the gateway's error). Ignored when ok is true. */
  scope?: FailureScope;
}

/** Chooses which gateways to try for a payment, and learns from the outcomes. */
export interface GatewayRouter {
  /** Gateway names to try for this method (and bank), best first. Empty = unavailable everywhere. */
  candidates(method: PaymentMethod, request?: CandidateRequest): Promise<string[]>;
  /** Feed back the outcome of a gateway call so future routing can adapt. */
  recordResult(outcome: RouteOutcome): Promise<void>;
}
