import type { PrismaClient } from '@prisma/client';
import { generateApiKey, sha256Hex } from '../../lib/crypto';
import { accountCode, ensureMerchantAccounts, ensureSystemAccounts } from '../ledger/accounts';
import { postJournalEntry } from '../ledger/ledger.service';

/**
 * Creates a merchant with its ledger accounts. If `apiKey` is omitted a new
 * random key is generated. The plaintext key is returned once and only its
 * hash is stored.
 */
export async function createMerchant(prisma: PrismaClient, name: string, apiKey?: string) {
  const generated = generateApiKey();
  const key = apiKey ?? generated.key;
  const merchant = await prisma.merchant.create({
    data: { name, apiKeyHash: sha256Hex(key), apiKeyPrefix: key.slice(0, 12) },
  });
  await ensureMerchantAccounts(prisma, merchant.id);
  return { merchant, apiKey: key };
}

/**
 * Demo/test helper: credits a merchant's balance from the opening_balance
 * (equity) account. In production money only arrives through real payments.
 */
export async function topUpMerchant(prisma: PrismaClient, merchantId: string, amountKobo: bigint, reference: string) {
  const system = await ensureSystemAccounts(prisma);
  const { balance } = await ensureMerchantAccounts(prisma, merchantId);
  return prisma.$transaction((tx) =>
    postJournalEntry(tx, {
      reference,
      description: `Opening balance top-up for ${accountCode.merchantBalance(merchantId)}`,
      postings: [
        { accountId: system.openingBalance, amountKobo: amountKobo }, // debit equity
        { accountId: balance, amountKobo: -amountKobo }, // credit merchant (we owe them more)
      ],
    }),
  );
}
