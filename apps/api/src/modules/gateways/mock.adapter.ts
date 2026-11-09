import { mockWebhookSchema, PAYMENT_METHODS, settlementRowSchema, type SettlementRow } from '@po/shared';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { hmacSha512Hex, safeEqual } from '../../lib/crypto';
import {
  gatewayFetch,
  GatewayError,
  type GatewayAdapter,
  type InitializeInput,
  type InitializeResult,
  type ParsedWebhook,
  type VerifyResult,
} from './gateway.types';

const initializeResponse = z.object({
  gatewayReference: z.string(),
  checkoutUrl: z.string().nullable().optional(),
});
const chargeResponse = z.object({
  status: z.enum(['pending', 'succeeded', 'failed']),
  amountKobo: z.number().int(),
  feeKobo: z.number().int(),
  gatewayReference: z.string(),
});

/** Adapter for our own mock gateway (apps/mock-gateway). */
export class MockGatewayAdapter implements GatewayAdapter {
  readonly supportedMethods = PAYMENT_METHODS;

  constructor(
    readonly name: string,
    readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
    private readonly feeBps = 150,
    private readonly feeCapKobo = 200_000,
  ) {}

  estimateFeeKobo(amountKobo: number): number {
    return Math.min(this.feeCapKobo, Math.floor((amountKobo * this.feeBps + 5_000) / 10_000));
  }

  private headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` };
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const res = await gatewayFetch(
      this.name,
      `${this.baseUrl}/charges`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          reference: input.reference,
          amountKobo: input.amountKobo,
          email: input.email,
          method: input.method,
          ...(input.bankCode ? { bankCode: input.bankCode } : {}),
        }),
      },
      this.timeoutMs,
    );
    const body = initializeResponse.parse(await res.json());
    return { gatewayReference: body.gatewayReference, checkoutUrl: body.checkoutUrl ?? null };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const res = await gatewayFetch(
      this.name,
      `${this.baseUrl}/charges/${encodeURIComponent(reference)}`,
      { headers: this.headers() },
      this.timeoutMs,
    );
    const body = chargeResponse.parse(await res.json());
    return {
      status: body.status,
      amountKobo: body.amountKobo,
      feeKobo: body.feeKobo,
      gatewayReference: body.gatewayReference,
    };
  }

  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const provided = headers['x-mock-signature'];
    if (typeof provided !== 'string' || provided.length === 0) return false;
    return safeEqual(provided, hmacSha512Hex(this.secret, rawBody));
  }

  parseWebhook(rawBody: Buffer): ParsedWebhook {
    const event = mockWebhookSchema.parse(JSON.parse(rawBody.toString('utf8')));
    return { eventId: event.id, eventType: event.type, reference: event.data.reference };
  }

  async fetchSettlements(): Promise<SettlementRow[]> {
    const res = await gatewayFetch(this.name, `${this.baseUrl}/settlements`, { headers: this.headers() }, this.timeoutMs);
    const body = z.object({ settlements: z.array(settlementRowSchema) }).parse(await res.json());
    return body.settlements;
  }
}

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}
