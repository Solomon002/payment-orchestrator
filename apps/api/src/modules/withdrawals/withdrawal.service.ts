// Withdrawals: a merchant moves money out of their balance.
// This module exists to demonstrate the classic DOUBLE-SPEND race and its fix.
//
// The race ("check-then-act"):
//   Request A reads balance = 10,000      Request B reads balance = 10,000
//   A: 10,000 >= 8,000, OK                B: 10,000 >= 8,000, OK
//   A writes -8,000                       B writes -8,000      => balance = -6,000
// Both checks passed because both read the balance before either wrote.
//
// The fix: make "read balance, check, write" happen one-at-a-time per merchant
// by locking the merchant's balance account row with SELECT ... FOR UPDATE.
import { NormalSide, Prisma } from '@prisma/client';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { sleep } from '../../lib/sleep';
import { ensureMerchantAccounts, ensureSystemAccounts } from '../ledger/accounts';
import { naturalBalance, postJournalEntry, postingSum } from '../ledger/ledger.service';

export class InsufficientFundsError extends AppError {
  constructor(availableKobo: bigint, requestedKobo: bigint) {
    super(409, 'INSUFFICIENT_FUNDS', 'Insufficient available balance for this withdrawal', {
      availableKobo,
      requestedKobo,
    });
  }
}

function withdrawalPostings(merchantBalanceId: string, payoutsClearingId: string, amount: bigint) {
  return [
    { accountId: merchantBalanceId, amountKobo: amount }, // debit: we owe the merchant less
    { accountId: payoutsClearingId, amountKobo: -amount }, // credit: we now owe the payout
  ];
}

/**
 * DELIBERATELY UNSAFE. Reads the balance outside any lock, waits (standing in for
 * a call to a payout provider), then writes. Concurrent requests all pass the
 * check and the merchant's balance goes negative. Only reachable when
 * ENABLE_NAIVE_ENDPOINTS=true, which env validation forbids in production.
 */
export async function withdrawNaive(ctx: AppContext, merchantId: string, amount: bigint) {
  const accounts = await ensureMerchantAccounts(ctx.prisma, merchantId);
  const system = await ensureSystemAccounts(ctx.prisma);

  const available = naturalBalance(await postingSum(ctx.prisma, accounts.balance), NormalSide.credit);
  if (available < amount) throw new InsufficientFundsError(available, amount);

  await sleep(ctx.config.RACE_WINDOW_MS); // the race window: others read the same stale balance meanwhile

  return ctx.prisma.$transaction(async (tx) => {
    const entry = await postJournalEntry(tx, {
      reference: `withdrawal:naive:${crypto.randomUUID()}`,
      description: 'Merchant withdrawal (naive, unsafe)',
      postings: withdrawalPostings(accounts.balance, system.payoutsClearing, amount),
    });
    return tx.withdrawal.create({
      data: { merchantId, amountKobo: amount, status: 'completed', journalEntryId: entry.id, mode: 'naive' },
    });
  });
}

/**
 * SAFE. Inside one transaction:
 *  1. SELECT ... FOR UPDATE on the merchant's balance account row. Any other
 *     transaction that tries to lock the same row waits here until we commit.
 *     (The account row itself never changes; we use it as a per-merchant mutex.)
 *  2. Read the balance. Under READ COMMITTED every statement takes a fresh
 *     snapshot, so after waiting for the lock we see the postings the previous
 *     holder committed.
 *  3. Check, then post the journal entry, then commit (which releases the lock).
 * Different merchants lock different rows, so they never wait for each other.
 */
export async function withdrawSafe(ctx: AppContext, merchantId: string, amount: bigint, idempotencyKey: string) {
  const accounts = await ensureMerchantAccounts(ctx.prisma, merchantId);
  const system = await ensureSystemAccounts(ctx.prisma);

  return ctx.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accounts.balance}::uuid FOR UPDATE`;

      const available = naturalBalance(await postingSum(tx, accounts.balance), NormalSide.credit);
      if (available < amount) throw new InsufficientFundsError(available, amount);

      await sleep(ctx.config.RACE_WINDOW_MS); // same delay as the naive version: the lock, not luck, keeps us safe

      const entry = await postJournalEntry(tx, {
        reference: `withdrawal:${merchantId}:${idempotencyKey}`,
        description: 'Merchant withdrawal',
        postings: withdrawalPostings(accounts.balance, system.payoutsClearing, amount),
      });
      return tx.withdrawal.create({
        data: {
          merchantId,
          amountKobo: amount,
          status: 'completed',
          idempotencyKey,
          journalEntryId: entry.id,
          mode: 'safe',
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      // Up to 50 requests may queue behind the lock in the demo; give them room.
      maxWait: 30_000,
      timeout: 30_000,
    },
  );
}

export async function merchantBalances(ctx: AppContext, merchantId: string) {
  const accounts = await ensureMerchantAccounts(ctx.prisma, merchantId);
  const [available, pending] = await Promise.all([
    postingSum(ctx.prisma, accounts.balance),
    postingSum(ctx.prisma, accounts.pending),
  ]);
  return {
    availableKobo: naturalBalance(available, NormalSide.credit),
    pendingKobo: naturalBalance(pending, NormalSide.credit),
    currency: 'NGN',
  };
}
