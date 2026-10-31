// The adapter interface every payment gateway implements.
//
// The rest of the system only talks to this interface, never to Paystack or the
// mock directly (the "adapter pattern", like a travel plug adapter: the laptop
// doesn't care which country's socket it is plugged into). Adding Flutterwave
// or Monnify later means writing one new adapter, nothing else changes.
import type { PaymentMethod, SettlementRow } from '@po/shared';
import type { IncomingHttpHeaders } from 'node:http';

export interface InitializeInput {
  /** Our globally unique payment reference (sent to the gateway). */
  reference: string;
  amountKobo: number;
  email: string;
  method: PaymentMethod;
}

export interface InitializeResult {
  gatewayReference: string;
  /** Where the customer completes payment (hosted checkout), if the gateway uses one. */
  checkoutUrl: string | null;
}

export type VerifiedStatus = 'pending' | 'succeeded' | 'failed';

export interface VerifyResult {
  status: VerifiedStatus;
  amountKobo: number;
  feeKobo: number;
  gatewayReference: string | null;
}

export interface ParsedWebhook {
  /** Stable id used to detect resends of the same event. */
  eventId: string;
  eventType: string;
  /** Our payment reference the event is about. */
  reference: string;
}

export interface GatewayAdapter {
  readonly name: string;
  readonly supportedMethods: readonly PaymentMethod[];
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
  /** Must be computed over the RAW request bytes, before any JSON parsing. */
  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  parseWebhook(rawBody: Buffer): ParsedWebhook;
  /** Settlement report for reconciliation. Gateways without an API return null (use CSV upload). */
  fetchSettlements(): Promise<SettlementRow[] | null>;
}

/**
 * Why a gateway call failed. The distinction drives routing:
 *  - unavailable / timeout: the gateway is unhealthy -> count against its health, try the next one
 *  - rejected: the gateway is fine but refused THIS request (4xx) -> don't fail over, don't blame its health
 */
export type GatewayErrorKind = 'unavailable' | 'timeout' | 'rejected';

export class GatewayError extends Error {
  constructor(
    public readonly gateway: string,
    public readonly kind: GatewayErrorKind,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Wraps fetch with a timeout and converts failures into GatewayError. */
export async function gatewayFetch(gateway: string, url: string, init: RequestInit, timeoutMs: number) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new GatewayError(gateway, 'timeout', `${gateway} did not answer within ${timeoutMs}ms`);
    }
    throw new GatewayError(gateway, 'unavailable', `${gateway} unreachable: ${(err as Error).message}`);
  }
  if (res.status >= 500 || res.status === 429) {
    throw new GatewayError(gateway, 'unavailable', `${gateway} answered HTTP ${res.status}`, res.status);
  }
  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    throw new GatewayError(gateway, 'rejected', `${gateway} rejected the request (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  return res;
}
