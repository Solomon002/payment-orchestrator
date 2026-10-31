// Shared vocabulary between the API, the mock gateway and the dashboard.
// Keeping the Zod schemas in one place means the three apps cannot drift apart
// on what a payment, a method or a gateway control setting looks like.
import { z } from 'zod';

// ---------- Enums ----------

export const PAYMENT_METHODS = ['card', 'bank_transfer'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const PAYMENT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const WEBHOOK_STATUSES = ['received', 'queued', 'processed', 'failed', 'rejected'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const DISCREPANCY_TYPES = [
  'missing_in_ledger',
  'missing_in_gateway',
  'amount_mismatch',
  'status_mismatch',
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];

export const ROUTE_STATES = ['healthy', 'degraded', 'probing'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

// ---------- Money ----------

// Amounts are integer kobo (100 kobo = 1 naira). Never floats.
// Upper bound: NGN 100,000,000 per payment, far below Number.MAX_SAFE_INTEGER.
export const MAX_AMOUNT_KOBO = 10_000_000_000;
export const amountKoboSchema = z
  .number()
  .int('amountKobo must be an integer number of kobo')
  .positive()
  .max(MAX_AMOUNT_KOBO);

export function formatNaira(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const k = abs % 100;
  return `${sign}NGN ${naira.toLocaleString('en-NG')}.${k.toString().padStart(2, '0')}`;
}

// ---------- Merchant API inputs ----------

// Merchant-chosen reference: letters, digits, dash, underscore, dot.
export const referenceSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'reference may only contain letters, digits, ".", "_" and "-"');

export const createPaymentSchema = z
  .object({
    amountKobo: amountKoboSchema,
    currency: z.literal('NGN').default('NGN'),
    method: paymentMethodSchema,
    reference: referenceSchema,
    customerEmail: z.string().email().max(254),
  })
  .strict();
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const createWithdrawalSchema = z
  .object({
    amountKobo: amountKoboSchema,
  })
  .strict();
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key has invalid characters');

// ---------- Mock gateway control ----------

export const WEBHOOK_MODES = ['normal', 'duplicate', 'delayed', 'drop', 'bad_signature'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const mockControlSchema = z
  .object({
    latencyMs: z.number().int().min(0).max(30_000),
    // Percentage of initialize calls that fail with HTTP 503 (a gateway error).
    failureRate: z.number().min(0).max(100),
    // Percentage of charges the "customer" declines (a business failure, not a gateway error).
    declineRate: z.number().min(0).max(100),
    methodOutages: z.object({ card: z.boolean(), bank_transfer: z.boolean() }).strict(),
    webhookMode: z.enum(WEBHOOK_MODES),
    webhookDelayMs: z.number().int().min(0).max(300_000),
    // How long after initialize the mock "customer" completes the charge.
    completionDelayMs: z.number().int().min(0).max(60_000),
  })
  .strict();
export type MockControl = z.infer<typeof mockControlSchema>;
export const mockControlPatchSchema = mockControlSchema.partial().extend({
  methodOutages: mockControlSchema.shape.methodOutages.partial().optional(),
});
export type MockControlPatch = z.infer<typeof mockControlPatchSchema>;

// Webhook body the mock gateway sends. Signed with HMAC-SHA512 in `x-mock-signature`.
export const mockWebhookSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['charge.succeeded', 'charge.failed']),
  data: z.object({
    reference: z.string().min(1).max(100),
    gatewayReference: z.string().min(1).max(100),
    amountKobo: z.number().int().nonnegative(),
    feeKobo: z.number().int().nonnegative(),
    method: paymentMethodSchema,
    status: z.enum(['succeeded', 'failed']),
    paidAt: z.string().nullable(),
  }),
});
export type MockWebhook = z.infer<typeof mockWebhookSchema>;

export const settlementRowSchema = z.object({
  reference: z.string().min(1).max(100),
  amountKobo: z.number().int().nonnegative(),
  feeKobo: z.number().int().nonnegative(),
  settledAt: z.string(),
  batchId: z.string().min(1).max(100),
});
export type SettlementRow = z.infer<typeof settlementRowSchema>;
