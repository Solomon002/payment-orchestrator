// Prints fresh secrets for a deployment, ready to paste into the host's
// environment variables. Never reuse your laptop's .env in production.
//   node scripts/gen-secrets.mjs
import { randomBytes } from 'node:crypto';

const hex = () => randomBytes(32).toString('hex');
console.log(`ADMIN_API_KEY=${hex()}`);
console.log(`DEMO_MERCHANT_API_KEY=sk_test_${randomBytes(24).toString('hex')}`);
console.log(`MOCKPAY_A_SECRET=${hex()}`);
console.log(`MOCKPAY_B_SECRET=${hex()}`);
console.log(`MOCK_CONTROL_KEY=${hex()}`);
