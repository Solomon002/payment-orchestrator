import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMerchantAccounts, ensureSystemAccounts } from '../src/modules/ledger/accounts';
import {
  accountBalance,
  assertBalanced,
  ledgerTotal,
  postJournalEntry,
  UnbalancedEntryError,
} from '../src/modules/ledger/ledger.service';
import { createMerchant } from '../src/modules/merchants/merchant.service';
import { resetDatabase, teardown, testContext } from './helpers';

const ctx = testContext();

async function twoAccounts() {
  const { merchant } = await createMerchant(ctx.prisma, 'Ledger Test');
  const system = await ensureSystemAccounts(ctx.prisma);
  const accounts = await ensureMerchantAccounts(ctx.prisma, merchant.id);
  return { equity: system.openingBalance, merchantBalance: accounts.balance };
}

describe('ledger', () => {
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => teardown(ctx));

  it('rejects an unbalanced entry in application code', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amountKobo: 100n },
        { accountId: 'b', amountKobo: -90n },
      ]),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects single-posting and zero-amount entries', () => {
    expect(() => assertBalanced([{ accountId: 'a', amountKobo: 100n }])).toThrow(UnbalancedEntryError);
    expect(() =>
      assertBalanced([
        { accountId: 'a', amountKobo: 0n },
        { accountId: 'b', amountKobo: 0n },
      ]),
    ).toThrow(UnbalancedEntryError);
  });

  it('posts a balanced entry and derives balances from postings', async () => {
    const { equity, merchantBalance } = await twoAccounts();
    await ctx.prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        reference: 'test:1',
        description: 'credit merchant',
        postings: [
          { accountId: equity, amountKobo: 5_000n },
          { accountId: merchantBalance, amountKobo: -5_000n },
        ],
      }),
    );
    expect(await accountBalance(ctx.prisma, merchantBalance)).toBe(5_000n);
    expect(await ledgerTotal(ctx.prisma)).toBe(0n);
  });

  it('the DATABASE rejects an unbalanced entry even if application checks are bypassed', async () => {
    const { equity, merchantBalance } = await twoAccounts();
    const attempt = ctx.prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({ data: { reference: 'raw:bad', description: 'bypass' } });
      await tx.posting.createMany({
        data: [
          { journalEntryId: entry.id, accountId: equity, amountKobo: 100n },
          { journalEntryId: entry.id, accountId: merchantBalance, amountKobo: -1n },
        ],
      });
    });
    await expect(attempt).rejects.toThrow(/LEDGER_UNBALANCED/);
    expect(await ctx.prisma.journalEntry.count()).toBe(0);
  });

  it('the DATABASE forbids editing or deleting postings (append-only)', async () => {
    const { equity, merchantBalance } = await twoAccounts();
    await ctx.prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        reference: 'test:2',
        description: 'x',
        postings: [
          { accountId: equity, amountKobo: 10n },
          { accountId: merchantBalance, amountKobo: -10n },
        ],
      }),
    );
    await expect(ctx.prisma.posting.updateMany({ data: { amountKobo: 999n } })).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(ctx.prisma.posting.deleteMany({})).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  });

  it('the same business reference can never be posted twice', async () => {
    const { equity, merchantBalance } = await twoAccounts();
    const post = () =>
      ctx.prisma.$transaction((tx) =>
        postJournalEntry(tx, {
          reference: 'payment:abc:succeeded',
          description: 'x',
          postings: [
            { accountId: equity, amountKobo: 10n },
            { accountId: merchantBalance, amountKobo: -10n },
          ],
        }),
      );
    await post();
    await expect(post()).rejects.toThrow();
    expect(await ctx.prisma.journalEntry.count()).toBe(1);
  });
});
