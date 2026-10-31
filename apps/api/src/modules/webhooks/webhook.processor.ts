// Processing webhooks: the slow path, run by the worker.
//
// "Trust, but verify": the webhook only tells us SOMETHING happened. Before
// moving money in our ledger we ask the gateway's verify API for the
// authoritative status and amount. A webhook body could be stale, replayed,
// or (if a secret ever leaked) forged; the verify call comes from our side.
import { UnrecoverableError } from 'bullmq';
import type { AppContext } from '../../context';
import { RetryableError } from '../../lib/errors';
import { AmountMismatchError, settlePayment } from '../payments/payment.service';

export type ProcessOutcome = 'processed' | 'already_processed' | 'ignored';

export async function processWebhookEvent(ctx: AppContext, webhookEventId: string): Promise<ProcessOutcome> {
  const event = await ctx.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event || !event.signatureValid) return 'ignored';
  if (event.status === 'processed') return 'already_processed';

  await ctx.prisma.webhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });

  const fail = async (message: string) => {
    await ctx.prisma.webhookEvent.update({ where: { id: event.id }, data: { status: 'failed', lastError: message } });
    // UnrecoverableError tells BullMQ not to retry: retrying can't fix these.
    throw new UnrecoverableError(message);
  };

  const adapter = ctx.gateways.get(event.gateway);
  if (!adapter) return fail(`unknown gateway ${event.gateway}`);

  const parsed = adapter.parseWebhook(Buffer.from(event.rawBody, 'utf8'));
  const payment = await ctx.prisma.payment.findUnique({ where: { reference: parsed.reference } });
  if (!payment) return fail(`no payment with reference ${parsed.reference}`);

  const verified = await adapter.verify(parsed.reference); // network errors throw -> BullMQ retries
  if (verified.status === 'pending') {
    throw new RetryableError('gateway still reports the charge as pending');
  }

  try {
    await settlePayment(ctx, payment.id, {
      status: verified.status,
      gateway: event.gateway,
      amountKobo: verified.amountKobo,
      feeKobo: verified.feeKobo,
      reason: verified.status === 'failed' ? 'declined_by_gateway' : undefined,
    });
  } catch (err) {
    if (err instanceof AmountMismatchError) return fail(err.message); // left pending; reconciliation will flag it
    throw err;
  }

  await ctx.prisma.webhookEvent.update({
    where: { id: event.id },
    data: { status: 'processed', processedAt: new Date(), lastError: null },
  });
  return 'processed';
}

/** Called by the worker when a job has used up all its retries (dead-letter). */
export async function markWebhookDeadLettered(ctx: AppContext, webhookEventId: string, error: string) {
  await ctx.prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, status: { not: 'processed' } },
    data: { status: 'failed', lastError: `dead-lettered: ${error}`.slice(0, 1000) },
  });
  await ctx.queues.deadLetter.add('dead', { webhookEventId, error }, { removeOnComplete: false });
}
