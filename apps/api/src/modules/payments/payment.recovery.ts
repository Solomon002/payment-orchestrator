import type { AppContext } from '../../context';
import { ensureMerchantAccounts, ensureSystemAccounts } from '../ledger/accounts';
import { postJournalEntry } from '../ledger/ledger.service';
import { transition } from './payment.state';

/** Fails a payment stuck in "created" (API crashed mid-request) and releases its pending amount. */
export async function failCreatedPayment(ctx: AppContext, paymentId: string) {
  await ctx.prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const system = await ensureSystemAccounts(tx);
    const merchant = await ensureMerchantAccounts(tx, payment.merchantId);
    await transition(tx, paymentId, 'created', 'failed', { failureReason: 'abandoned_before_gateway_response' });
    await postJournalEntry(tx, {
      reference: `payment:${paymentId}:failed`,
      description: `Payment ${payment.reference} abandoned`,
      paymentId,
      postings: [
        { accountId: system.paymentsPending, amountKobo: -payment.amountKobo },
        { accountId: merchant.pending, amountKobo: payment.amountKobo },
      ],
    });
  });
}
