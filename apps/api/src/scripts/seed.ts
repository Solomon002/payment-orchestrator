// Seeds the dev database: system ledger accounts and a demo merchant whose API
// key comes from DEMO_MERCHANT_API_KEY in .env. Safe to run repeatedly.
import { closeContext, createContext } from '../context';
import { sha256Hex } from '../lib/crypto';
import { ensureSystemAccounts } from '../modules/ledger/accounts';
import { createMerchant, topUpMerchant } from '../modules/merchants/merchant.service';

const ctx = createContext();

try {
  await ensureSystemAccounts(ctx.prisma);

  const apiKey = ctx.config.DEMO_MERCHANT_API_KEY;
  let merchant = await ctx.prisma.merchant.findUnique({ where: { apiKeyHash: sha256Hex(apiKey) } });
  if (!merchant) {
    merchant = (await createMerchant(ctx.prisma, 'Demo Merchant Ltd', apiKey)).merchant;
    console.log(`Created demo merchant ${merchant.id}`);
  } else {
    console.log(`Demo merchant already exists (${merchant.id})`);
  }

  const already = await ctx.prisma.journalEntry.findUnique({ where: { reference: `seed:opening:${merchant.id}` } });
  if (!already) {
    await topUpMerchant(ctx.prisma, merchant.id, 10_000_000n, `seed:opening:${merchant.id}`);
    console.log('Credited demo merchant with an opening balance of NGN 100,000.00');
  }

  console.log('');
  console.log('Demo merchant API key (also in .env as DEMO_MERCHANT_API_KEY):');
  console.log(`  ${apiKey.slice(0, 12)}... (see .env for the full key)`);
  console.log('Seed complete.');
} finally {
  await closeContext(ctx);
}
