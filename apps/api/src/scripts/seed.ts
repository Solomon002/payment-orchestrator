// Seeds the dev database: system ledger accounts and a demo merchant whose API
// key comes from DEMO_MERCHANT_API_KEY in .env. Safe to run repeatedly.
import { closeContext, createContext } from '../context';
import { seedDemoMerchant } from '../modules/merchants/merchant.service';

const ctx = createContext();

try {
  const apiKey = ctx.config.DEMO_MERCHANT_API_KEY;
  const { merchant, created } = await seedDemoMerchant(ctx.prisma, apiKey);
  console.log(created ? `Created demo merchant ${merchant.id}` : `Demo merchant already exists (${merchant.id})`);
  console.log('Demo merchant has an opening balance of NGN 100,000.00');
  console.log('');
  console.log('Demo merchant API key (also in .env as DEMO_MERCHANT_API_KEY):');
  console.log(`  ${apiKey.slice(0, 12)}... (see .env for the full key)`);
  console.log('Seed complete.');
} finally {
  await closeContext(ctx);
}
