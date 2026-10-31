// Runs before every test file: point the app at the TEST database and Redis DB
// and use fast timings, before any app module reads the environment.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env for tests`);
  return value;
};

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: required('DATABASE_URL_TEST'),
  REDIS_URL: required('REDIS_URL_TEST'),
  RATE_LIMIT_GLOBAL_PER_MIN: '100000',
  RATE_LIMIT_MONEY_PER_MIN: '100000',
  ENABLE_NAIVE_ENDPOINTS: 'true',
  RACE_WINDOW_MS: '20',
  ROUTING_MIN_SAMPLES: '3',
  ROUTING_COOLDOWN_MS: '300',
  ROUTING_PROBE_SUCCESSES: '2',
  GATEWAY_TIMEOUT_MS: '1500',
  PENDING_POLL_AFTER_MS: '0',
});
