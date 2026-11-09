// Payments: create a payment, send it to a gateway (with failover), and
// later settle it when the gateway confirms the outcome.
//
// Ledger story for one NGN 5,000 card payment (A = 500,000 kobo), gateway fee F,
// our platform fee P:
//   1. created  -> "pending" entry:   Dr payments_pending A   / Cr merchant_pending A
//   2. succeeded -> "succeeded" entry: reverse the pending pair, then
//        Dr gateway_clearing (A - F)   the gateway owes us A minus its fee
//        Dr gateway_fees      F        our cost
//        Cr merchant_balance (A - P)   the merchant can now withdraw this
//        Cr platform_revenue  P        our income
//   2'. failed/expired -> reverse the pending pair only.
// Every entry sums to zero, and each has a unique reference so it can never post twice.
import { bankName, type CreatePaymentInput, type PaymentMethod } from '@po/shared';
import { Prisma, type Payment, type PaymentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { AppError, RetryableError } from '../../lib/errors';
import { feeFromBps, koboToNumber } from '../../lib/money';
import { ensureGatewayAccounts, ensureMerchantAccounts, ensureSystemAccounts } from '../ledger/accounts';
import { postJournalEntry, type PostingInput } from '../ledger/ledger.service';
import { GatewayError } from '../gateways/gateway.types';
import type { RouteOutcome } from '../routing/router.types';
import { isTerminal, transition } from './payment.state';

export class MethodUnavailableError extends AppError {
  constructor(method: PaymentMethod, alternatives: PaymentMethod[], bankCode?: string) {
    const what = bankCode ? `${method} from ${bankName(bankCode)} (${bankCode})` : method;
    super(
      503,
      'METHOD_UNAVAILABLE',
      alternatives.length
        ? `${what} is temporarily unavailable on every gateway. Ask the customer to try: ${alternatives.join(', ')}.`
        : `${what} is temporarily unavailable on every gateway, and no alternative method is available right now.`,
      { method, bankCode: bankCode ?? null, alternatives },
    );
  }
}

/** Public view of a payment (what the API returns). */
export function presentPayment(p: Payment) {
  return {
    id: p.id,
    reference: p.reference,
    merchantReference: p.merchantReference,
    status: p.status,
    amountKobo: p.amountKobo,
    feeKobo: p.feeKobo,
    currency: p.currency,
    method: p.method,
    customerEmail: p.customerEmail,
    gateway: p.selectedGateway,
    checkoutUrl: p.checkoutUrl,
    failureReason: p.failureReason,
    succeededAt: p.succeededAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function alternativesFor(ctx: AppContext, method: PaymentMethod, bankCode?: string): Promise<PaymentMethod[]> {
  const others: PaymentMethod[] = method === 'card' ? ['bank_transfer'] : ['card'];
  const available: PaymentMethod[] = [];
  for (const m of others) if ((await ctx.router.candidates(m, { bankCode })).length > 0) available.push(m);
  return available;
}

/** Health bookkeeping is best-effort: a Redis problem must never fail (or re-route) a payment. */
async function recordRouteResult(ctx: AppContext, outcome: RouteOutcome) {
  try {
    await ctx.router.recordResult(outcome);
  } catch (err) {
    ctx.log.error({ err, gateway: outcome.gateway }, 'failed to record routing health');
  }
}

/** Retries transient database errors (e.g. "unable to start a transaction in the given time"). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || err instanceof AppError) throw err;
      await new Promise((r) => setTimeout(r, 100 * i));
    }
  }
}

function pendingReversal(paymentsPending: string, merchantPending: string, amount: bigint): PostingInput[] {
  return [
    { accountId: paymentsPending, amountKobo: -amount },
    { accountId: merchantPending, amountKobo: amount },
  ];
}

/**
 * Creates a payment and initializes it on the best available gateway, failing
 * over to the next candidate when a gateway is down or times out.
 * The gateway HTTP call happens OUTSIDE any database transaction: holding a
 * transaction (and its locks) open while waiting on the network would let one
 * slow gateway block everything else.
 */
export async function createPayment(ctx: AppContext, merchantId: string, input: CreatePaymentInput) {
  const candidates = await ctx.router.candidates(input.method, { bankCode: input.bankCode, amountKobo: input.amountKobo });
  if (candidates.length === 0) {
    throw new MethodUnavailableError(input.method, await alternativesFor(ctx, input.method, input.bankCode), input.bankCode);
  }

  const amount = BigInt(input.amountKobo);
  const system = await ensureSystemAccounts(ctx.prisma);
  const merchantAccounts = await ensureMerchantAccounts(ctx.prisma, merchantId);

  // 1. Record the payment and the "pending" ledger entry atomically.
  let payment: Payment;
  try {
    payment = await ctx.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          merchantId,
          merchantReference: input.reference,
          reference: `pay_${randomUUID().replaceAll('-', '')}`,
          amountKobo: amount,
          currency: input.currency,
          method: input.method,
          customerEmail: input.customerEmail,
          status: 'created',
        },
      });
      await postJournalEntry(tx, {
        reference: `payment:${created.id}:pending`,
        description: `Payment ${created.reference} initiated`,
        paymentId: created.id,
        postings: [
          { accountId: system.paymentsPending, amountKobo: amount },
          { accountId: merchantAccounts.pending, amountKobo: -amount },
        ],
      });
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'DUPLICATE_REFERENCE', `A payment with reference "${input.reference}" already exists`);
    }
    throw err;
  }

  // 2. Try gateways in order until one accepts the charge.
  const errors: string[] = [];
  for (const gatewayName of candidates) {
    const adapter = ctx.gateways.require(gatewayName);
    const attempt = await ctx.prisma.paymentAttempt.create({
      data: { paymentId: payment.id, gateway: gatewayName, method: input.method, status: 'initiated' },
    });
    const started = Date.now();

    // ONLY the gateway call is inside this try. Anything that goes wrong after the
    // gateway has accepted the charge (our database, Redis...) must NOT cause a
    // failover: that would charge the customer a second time on another gateway.
    let result: Awaited<ReturnType<typeof adapter.initialize>>;
    try {
      result = await adapter.initialize({
        reference: payment.reference,
        amountKobo: koboToNumber(amount),
        email: input.customerEmail,
        method: input.method,
        bankCode: input.bankCode,
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${gatewayName}: ${message}`);
      await ctx.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'error', error: message.slice(0, 500), latencyMs, finishedAt: new Date() },
      });
      if (err instanceof GatewayError && err.kind === 'rejected') {
        break; // the request itself was refused; another gateway won't help
      }
      // Unhealthy or unreachable: count it against the route (the gateway, or the
      // customer's bank behind it, depending on the error) and fail over.
      const scope = err instanceof GatewayError ? err.scope : 'gateway';
      await recordRouteResult(ctx, { gateway: gatewayName, method: input.method, bankCode: input.bankCode, ok: false, latencyMs, scope });
      ctx.log.warn({ gateway: gatewayName, method: input.method, err: message }, 'gateway failed, failing over');
      continue;
    }

    // The gateway accepted the charge: this payment is now committed to this gateway.
    const latencyMs = Date.now() - started;
    await recordRouteResult(ctx, { gateway: gatewayName, method: input.method, bankCode: input.bankCode, ok: true, latencyMs });
    await withRetry(() =>
      ctx.prisma.$transaction(
        async (tx) => {
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: { gatewayReference: result.gatewayReference, latencyMs, finishedAt: new Date() },
          });
          await transition(tx, payment.id, 'created', 'pending', {
            selectedGateway: gatewayName,
            checkoutUrl: result.checkoutUrl,
          });
        },
        { maxWait: 10_000, timeout: 10_000 },
      ),
    );
    const fresh = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { status: 201, payment: presentPayment(fresh), attempts: errors.length + 1 };
  }

  // 3. Every candidate failed: fail the payment and release the pending amount.
  await ctx.prisma.$transaction(async (tx) => {
    await transition(tx, payment.id, 'created', 'failed', { failureReason: 'all_gateways_failed' });
    await postJournalEntry(tx, {
      reference: `payment:${payment.id}:failed`,
      description: `Payment ${payment.reference} failed: no gateway accepted it`,
      paymentId: payment.id,
      postings: pendingReversal(system.paymentsPending, merchantAccounts.pending, amount),
    });
  });
  const failed = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  throw new AppError(402, 'PAYMENT_FAILED', 'No gateway could process this payment', {
    payment: presentPayment(failed),
    alternatives: await alternativesFor(ctx, input.method, input.bankCode),
    gatewayErrors: errors,
  });
}

export interface GatewayOutcome {
  status: 'succeeded' | 'failed' | 'expired';
  gateway: string;
  amountKobo?: number;
  feeKobo?: number;
  reason?: string;
}

export class AmountMismatchError extends AppError {
  constructor(expected: bigint, actual: number) {
    super(409, 'AMOUNT_MISMATCH', `Gateway reported ${actual} kobo but the payment is for ${expected} kobo`);
  }
}

/**
 * Moves a pending payment to its final state and posts the matching ledger entry.
 * Safe to call many times for the same payment (webhook, duplicate webhook,
 * poller, all racing): the payment row is locked FOR UPDATE, a payment already
 * in a final state is left alone, and journal references are unique.
 */
export async function settlePayment(ctx: AppContext, paymentId: string, outcome: GatewayOutcome) {
  return ctx.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: PaymentStatus }[]>`
      SELECT status FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const current = rows[0]?.status;
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    if (isTerminal(current)) return { changed: false, status: current };
    if (current === 'created') {
      // The API is still waiting for the gateway's initialize response. Try again shortly.
      throw new RetryableError(`Payment ${paymentId} is not pending yet`);
    }

    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const amount = payment.amountKobo;
    const system = await ensureSystemAccounts(tx);
    const merchant = await ensureMerchantAccounts(tx, payment.merchantId);

    if (outcome.status === 'succeeded') {
      if (outcome.amountKobo !== undefined && BigInt(outcome.amountKobo) !== amount) {
        throw new AmountMismatchError(amount, outcome.amountKobo);
      }
      const gatewayAccounts = await ensureGatewayAccounts(tx, outcome.gateway);
      const gatewayFee = BigInt(outcome.feeKobo ?? 0);
      const platformFee = feeFromBps(amount, ctx.config.PLATFORM_FEE_BPS, ctx.config.PLATFORM_FEE_CAP_KOBO);
      const postings: PostingInput[] = [
        ...pendingReversal(system.paymentsPending, merchant.pending, amount),
        { accountId: gatewayAccounts.clearing, amountKobo: amount - gatewayFee },
        { accountId: gatewayAccounts.fees, amountKobo: gatewayFee },
        { accountId: merchant.balance, amountKobo: -(amount - platformFee) },
        { accountId: system.platformRevenue, amountKobo: -platformFee },
      ].filter((p) => p.amountKobo !== 0n);

      await transition(tx, paymentId, 'pending', 'succeeded', {
        feeKobo: gatewayFee,
        succeededAt: new Date(),
        selectedGateway: outcome.gateway,
      });
      await postJournalEntry(tx, {
        reference: `payment:${paymentId}:succeeded`,
        description: `Payment ${payment.reference} succeeded on ${outcome.gateway}`,
        paymentId,
        postings,
      });
      await tx.paymentAttempt.updateMany({
        where: { paymentId, gateway: outcome.gateway, status: 'initiated' },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      return { changed: true, status: 'succeeded' as const };
    }

    await transition(tx, paymentId, 'pending', outcome.status, { failureReason: outcome.reason ?? outcome.status });
    await postJournalEntry(tx, {
      reference: `payment:${paymentId}:${outcome.status}`,
      description: `Payment ${payment.reference} ${outcome.status}`,
      paymentId,
      postings: pendingReversal(system.paymentsPending, merchant.pending, amount),
    });
    await tx.paymentAttempt.updateMany({
      where: { paymentId, status: 'initiated' },
      data: { status: 'failed', finishedAt: new Date() },
    });
    return { changed: true, status: outcome.status };
  });
}
