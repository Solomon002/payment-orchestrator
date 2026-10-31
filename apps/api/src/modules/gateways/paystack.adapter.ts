// Paystack adapter, TEST MODE ONLY.
//
// Implemented only from behaviour I'm confident about:
//  - POST /transaction/initialize with { email, amount (in kobo), reference } returns
//    { status, message, data: { authorization_url, access_code, reference } }
//  - GET /transaction/verify/:reference returns { data: { status, amount, fees, ... } }
//  - Webhooks are signed with HMAC-SHA512 of the raw body using the secret key,
//    sent in the `x-paystack-signature` header.
// Anything less certain is marked "VERIFY AGAINST OFFICIAL DOCS".
// Docs: https://paystack.com/docs/api/
//
// This adapter has NOT been exercised against Paystack in this project (no keys
// were available). The app runs fully without it using the mock gateways.
import type { PaymentMethod, SettlementRow } from '@po/shared';
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

const BASE_URL = 'https://api.paystack.co';

const initializeResponse = z.object({
  status: z.boolean(),
  message: z.string().optional(),
  data: z.object({ authorization_url: z.string(), reference: z.string() }),
});

const verifyResponse = z.object({
  status: z.boolean(),
  data: z.object({
    id: z.union([z.number(), z.string()]).optional(),
    status: z.string(),
    amount: z.number().int(),
    // VERIFY AGAINST OFFICIAL DOCS: `fees` may be null for unpaid transactions.
    fees: z.number().int().nullable().optional(),
    reference: z.string(),
  }),
});

const webhookSchema = z.object({
  event: z.string(),
  data: z.object({
    id: z.union([z.number(), z.string()]),
    reference: z.string(),
  }),
});

export class PaystackAdapter implements GatewayAdapter {
  readonly name = 'paystack';
  readonly supportedMethods: readonly PaymentMethod[] = ['card', 'bank_transfer'];

  constructor(
    private readonly secretKey: string,
    private readonly timeoutMs: number,
    private readonly callbackUrl?: string,
  ) {
    if (!secretKey.startsWith('sk_test_')) {
      throw new Error('PaystackAdapter refuses non-test keys');
    }
  }

  private headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.secretKey}` };
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const res = await gatewayFetch(
      this.name,
      `${BASE_URL}/transaction/initialize`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          email: input.email,
          amount: input.amountKobo, // Paystack amounts are in the subunit (kobo) for NGN
          reference: input.reference,
          // VERIFY AGAINST OFFICIAL DOCS: `channels` restricts the checkout to one method.
          channels: [input.method === 'card' ? 'card' : 'bank_transfer'],
          ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
        }),
      },
      this.timeoutMs,
    );
    const body = initializeResponse.parse(await res.json());
    if (!body.status) throw new GatewayError(this.name, 'rejected', body.message ?? 'initialize failed');
    return { gatewayReference: body.data.reference, checkoutUrl: body.data.authorization_url };
  }

  async verify(reference: string): Promise<VerifyResult> {
    const res = await gatewayFetch(
      this.name,
      `${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: this.headers() },
      this.timeoutMs,
    );
    const body = verifyResponse.parse(await res.json());
    // VERIFY AGAINST OFFICIAL DOCS: the full list of transaction statuses.
    // Only "success" and "failed" are treated as final here; anything else
    // (e.g. abandoned/ongoing) stays pending until our own expiry timer fires.
    const status = body.data.status === 'success' ? 'succeeded' : body.data.status === 'failed' ? 'failed' : 'pending';
    return {
      status,
      amountKobo: body.data.amount,
      feeKobo: body.data.fees ?? 0,
      gatewayReference: body.data.id !== undefined ? String(body.data.id) : null,
    };
  }

  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const provided = headers['x-paystack-signature'];
    if (typeof provided !== 'string' || provided.length === 0) return false;
    return safeEqual(provided, hmacSha512Hex(this.secretKey, rawBody));
  }

  parseWebhook(rawBody: Buffer): ParsedWebhook {
    const event = webhookSchema.parse(JSON.parse(rawBody.toString('utf8')));
    // VERIFY AGAINST OFFICIAL DOCS: Paystack's payload has no top-level event id that I
    // can confirm, so the dedupe key is event name + transaction id.
    return { eventId: `${event.event}:${event.data.id}`, eventType: event.event, reference: event.data.reference };
  }

  async fetchSettlements(): Promise<SettlementRow[] | null> {
    // Not implemented: I am not confident enough in Paystack's settlement API shape.
    // Reconcile Paystack by exporting settlements from the dashboard and using the CSV upload.
    return null;
  }
}
