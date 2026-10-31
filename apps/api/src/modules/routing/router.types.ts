import type { PaymentMethod } from '@po/shared';

/** Chooses which gateways to try for a payment, and learns from the outcomes. */
export interface GatewayRouter {
  /** Gateway names to try for this method, best first. Empty = method unavailable everywhere. */
  candidates(method: PaymentMethod): Promise<string[]>;
  /** Feed back the outcome of a gateway call so future routing can adapt. */
  recordResult(gateway: string, method: PaymentMethod, ok: boolean, latencyMs: number): Promise<void>;
}
