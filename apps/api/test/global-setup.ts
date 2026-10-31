// Runs once before the whole suite: apply migrations to the test database.
import { execSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

export default function setup() {
  loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST must be set in .env');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
