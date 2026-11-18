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
 * Creates (if missing) the system accounts and the demo merchant whose API key
 * comes from DEMO_MERCHANT_API_KEY, with a NGN 100,000 opening balance.
 * Idempotent. Used by `db:seed` and by the public demo's hourly reset.
 */
export async function seedDemoMerchant(prisma: PrismaClient, apiKey: string) {
  await ensureSystemAccounts(prisma);
  let merchant = await prisma.merchant.findUnique({ where: { apiKeyHash: sha256Hex(apiKey) } });
  const created = !merchant;
  if (!merchant) merchant = (await createMerchant(prisma, 'Demo Merchant Ltd', apiKey)).merchant;
  const reference = `seed:opening:${merchant.id}`;
  if (!(await prisma.journalEntry.findUnique({ where: { reference } }))) {
    await topUpMerchant(prisma, merchant.id, 10_000_000n, reference);
  }
  return { merchant, created };
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
