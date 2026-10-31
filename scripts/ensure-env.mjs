// Creates .env from .env.example if it does not exist yet, replacing every
// __GENERATE__ placeholder with a fresh random secret. Cross-platform (no bash).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (existsSync(envPath)) {
  console.log('.env already exists, leaving it untouched.');
  process.exit(0);
}

const content = readFileSync(examplePath, 'utf8')
  .replaceAll('__GENERATE_SK__', () => `sk_test_${randomBytes(24).toString('hex')}`)
  .replaceAll('__GENERATE__', () => randomBytes(32).toString('hex'));

writeFileSync(envPath, content, 'utf8');
console.log('Created .env with freshly generated secrets.');
