// The double-entry ledger.
//
// Every movement of money is a JOURNAL ENTRY made of two or more POSTINGS.
// Postings are signed kobo amounts (debit = +, credit = -) and the postings of
// one entry always sum to zero: money is never created or destroyed, only moved.
//
// The ledger is APPEND-ONLY. We never run "UPDATE balance = balance + x".
// A balance is always computed as the sum of an account's postings, so the
// history explains every kobo. Mistakes are corrected with new reversing entries.
import { NormalSide, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { NORMAL_SIDE, type Db } from './accounts';

export interface PostingInput {
  accountId: string;
  /** Signed kobo: positive = debit, negative = credit. */
  amountKobo: bigint;
}

export interface JournalEntryInput {
  /** Unique business key for this event, e.g. "payment:<id>:succeeded". Posting it twice is impossible. */
  reference: string;
  description: string;
  paymentId?: string;
  postings: PostingInput[];
}

export class UnbalancedEntryError extends AppError {
  constructor(message: string) {
    super(500, 'LEDGER_UNBALANCED', message);
  }
}

/** The application-level check. The database enforces the same rule again at COMMIT. */
export function assertBalanced(postings: PostingInput[]): void {
  if (postings.length < 2) {
    throw new UnbalancedEntryError('A journal entry needs at least two postings');
  }
  let sum = 0n;
  for (const p of postings) {
    if (p.amountKobo === 0n) throw new UnbalancedEntryError('Postings must not be zero');
    sum += p.amountKobo;
  }
  if (sum !== 0n) {
    throw new UnbalancedEntryError(`Postings sum to ${sum} kobo; a journal entry must sum to zero`);
  }
}

/**
 * Writes one journal entry with its postings. Must run inside a transaction
 * (`tx`) so the entry and its postings are committed together or not at all.
 */
export async function postJournalEntry(tx: Prisma.TransactionClient, input: JournalEntryInput) {
  assertBalanced(input.postings);
  const entry = await tx.journalEntry.create({
    data: {
      reference: input.reference,
      description: input.description,
      paymentId: input.paymentId ?? null,
    },
  });
  await tx.posting.createMany({
    data: input.postings.map((p) => ({
      journalEntryId: entry.id,
      accountId: p.accountId,
      amountKobo: p.amountKobo,
    })),
  });
  return entry;
}

/** Raw sum of postings (debit-positive). */
export async function postingSum(db: Db, accountId: string): Promise<bigint> {
  const rows = await db.$queryRaw<{ sum: bigint | null }[]>`
    SELECT SUM(amount_kobo)::bigint AS sum FROM postings WHERE account_id = ${accountId}::uuid`;
  return rows[0]?.sum ?? 0n;
}

/** Balance as a human reads it, given the account's normal side. */
export function naturalBalance(sum: bigint, side: NormalSide): bigint {
  return side === NormalSide.debit ? sum : -sum;
}

export async function accountBalance(db: Db, accountId: string): Promise<bigint> {
  const account = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { type: true } });
  return naturalBalance(await postingSum(db, accountId), NORMAL_SIDE[account.type]);
}

/** Sum of every posting in the whole ledger. Must always be exactly zero. */
export async function ledgerTotal(db: Db): Promise<bigint> {
  const rows = await db.$queryRaw<{ sum: bigint | null }[]>`SELECT SUM(amount_kobo)::bigint AS sum FROM postings`;
  return rows[0]?.sum ?? 0n;
}
