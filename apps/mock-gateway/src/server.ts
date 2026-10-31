// Starts one mock gateway instance: `tsx src/server.ts mockpay-a` (or mockpay-b).
// Settings come from the shared root .env.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { createMockGateway } from './gateway';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const INSTANCES = {
  'mockpay-a': { urlVar: 'MOCKPAY_A_URL', secretVar: 'MOCKPAY_A_SECRET', feeBps: 150 },
  'mockpay-b': { urlVar: 'MOCKPAY_B_URL', secretVar: 'MOCKPAY_B_SECRET', feeBps: 140 },
} as const;

const name = process.argv[2] as keyof typeof INSTANCES | undefined;
if (!name || !(name in INSTANCES)) {
  console.error(`Usage: tsx src/server.ts <${Object.keys(INSTANCES).join('|')}>`);
  process.exit(1);
}

const instance = INSTANCES[name];
const must = (key: string) => {
  const value = process.env[key];
  if (!value || value.includes('__GENERATE')) {
    console.error(`${key} is missing in .env (run "pnpm run setup")`);
    process.exit(1);
  }
  return value;
};

const publicUrl = must(instance.urlVar);
const port = Number(new URL(publicUrl).port);
const gateway = createMockGateway({
  name,
  secret: must(instance.secretVar),
  controlKey: must('MOCK_CONTROL_KEY'),
  webhookUrl: `${process.env.API_PUBLIC_URL ?? 'http://localhost:4000'}/webhooks/${name}`,
  publicUrl,
  feeBps: instance.feeBps,
  feeCapKobo: 200_000,
  log: (msg) => console.log(`[${name}] ${msg}`),
});

gateway.app.listen(port, '127.0.0.1', () => {
  console.log(`[${name}] mock gateway listening on ${publicUrl}`);
});
