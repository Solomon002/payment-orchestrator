// The POLLING FALLBACK. Webhook delivery is not guaranteed: a gateway may never
// send one, or every retry may hit us during a deploy. So on a schedule we ask
// the gateways directly about payments that have been pending "too long".
// Analogy: you ordered a parcel and the delivery SMS never came, so after a
// while you check the tracking page yourself.
import type { AppContext } from '../context';
import { WEBHOOK_JOB_OPTIONS } from './queues';
import { failCreatedPayment } from '../modules/payments/payment.recovery';
import { settlePayment } from '../modules/payments/payment.service';

export interface PollSummary {
  checked: number;
  succeeded: number;
  failed: number;
  expired: number;
  stillPending: number;
  errors: number;
  requeuedWebhooks: number;
  abandonedCreated: number;
}

export async function pollPendingPayments(ctx: AppContext, now = new Date()): Promise<PollSummary> {
  const summary: PollSummary = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    expired: 0,
    stillPending: 0,
    errors: 0,
    requeuedWebhooks: 0,
    abandonedCreated: 0,
  };
  const pollBefore = new Date(now.getTime() - ctx.config.PENDING_POLL_AFTER_MS);
  const expireBefore = new Date(now.getTime() - ctx.config.PAYMENT_EXPIRY_MS);

  const pending = await ctx.prisma.payment.findMany({
    where: { status: 'pending', createdAt: { lte: pollBefore }, selectedGateway: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  for (const payment of pending) {
    summary.checked++;
    const adapter = ctx.gateways.get(payment.selectedGateway!);
    if (!adapter) continue;
    try {
      const verified = await adapter.verify(payment.reference);
      if (verified.status === 'pending') {
        if (payment.createdAt <= expireBefore) {
          await settlePayment(ctx, payment.id, { status: 'expired', gateway: adapter.name, reason: 'expired_without_confirmation' });
          summary.expired++;
        } else {
          summary.stillPending++;
        }
        continue;
      }
      const result = await settlePayment(ctx, payment.id, {
        status: verified.status,
        gateway: adapter.name,
        amountKobo: verified.amountKobo,
        feeKobo: verified.feeKobo,
        reason: verified.status === 'failed' ? 'declined_by_gateway' : undefined,
      });
      if (result.changed) summary[verified.status]++;
    } catch (err) {
      summary.errors++;
      ctx.log.warn({ err: (err as Error).message, paymentId: payment.id }, 'poll: verify failed');
    }
  }

  // Payments stuck in "created" mean the API crashed between saving the payment
  // and getting a gateway answer. Fail them so the pending amount is released.
  const stuck = await ctx.prisma.payment.findMany({
    where: { status: 'created', createdAt: { lte: new Date(now.getTime() - 5 * 60_000) } },
    take: 100,
  });
  for (const payment of stuck) {
    try {
      await failCreatedPayment(ctx, payment.id);
      summary.abandonedCreated++;
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, paymentId: payment.id }, 'poll: could not fail stuck payment');
    }
  }

  // Webhook events stored but never enqueued (Redis was down at the time).
  const orphaned = await ctx.prisma.webhookEvent.findMany({
    where: { status: 'received', signatureValid: true, receivedAt: { lte: new Date(now.getTime() - 30_000) } },
    take: 100,
  });
  for (const event of orphaned) {
    await ctx.queues.webhooks.add('process', { webhookEventId: event.id }, { ...WEBHOOK_JOB_OPTIONS, jobId: event.id });
    await ctx.prisma.webhookEvent.update({ where: { id: event.id }, data: { status: 'queued' } });
    summary.requeuedWebhooks++;
  }

  return summary;
}
