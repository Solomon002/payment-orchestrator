// Environment validation. The process refuses to start with a missing or unsafe
// setting, instead of failing later in the middle of moving money.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// One .env at the repo root is shared by every app.
loadDotenv({ path: resolve(import.meta.dirname, '../../../../.env'), quiet: true });

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((v) => !v.includes('__GENERATE'), `${name} still has a placeholder; run "pnpm run setup"`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    API_PORT: z.coerce.number().int().positive().default(4000),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    DASHBOARD_ORIGIN: z.string().url().default('http://localhost:5173'),
    ADMIN_API_KEY: secret('ADMIN_API_KEY'),

    DATABASE_URL: z.string().startsWith('postgresql://'),
    REDIS_URL: z.string().startsWith('redis://'),

    DEMO_MERCHANT_API_KEY: z.string().startsWith('sk_test_').min(32),

    MOCKPAY_A_URL: z.string().url(),
    MOCKPAY_A_SECRET: secret('MOCKPAY_A_SECRET'),
    MOCKPAY_B_URL: z.string().url(),
    MOCKPAY_B_SECRET: secret('MOCKPAY_B_SECRET'),
    MOCK_CONTROL_KEY: secret('MOCK_CONTROL_KEY'),

    PAYSTACK_SECRET_KEY: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine((v) => v === undefined || v.startsWith('sk_test_'), {
        message: 'PAYSTACK_SECRET_KEY must be a TEST key (sk_test_...). Live keys are refused.',
      }),
    PAYSTACK_CALLBACK_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.string().url().optional()),

    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(150),
    PLATFORM_FEE_CAP_KOBO: z.coerce.number().int().min(0).default(200_000),

    ROUTING_WINDOW_SIZE: z.coerce.number().int().min(2).max(1000).default(20),
    ROUTING_MIN_SAMPLES: z.coerce.number().int().min(1).default(5),
    ROUTING_MIN_SUCCESS_RATE: z.coerce.number().min(0).max(1).default(0.8),
    ROUTING_COOLDOWN_MS: z.coerce.number().int().min(0).default(30_000),
    ROUTING_PROBE_SUCCESSES: z.coerce.number().int().min(1).default(3),
    GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    PENDING_POLL_AFTER_MS: z.coerce.number().int().min(0).default(30_000),
    PAYMENT_EXPIRY_MS: z.coerce.number().int().min(1_000).default(1_800_000),
    RECONCILIATION_CRON: z.string().default('0 2 * * *'),
    RECONCILIATION_TZ: z.string().default('Africa/Lagos'),

    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_MONEY_PER_MIN: z.coerce.number().int().positive().default(300),

    ENABLE_NAIVE_ENDPOINTS: bool,
    RACE_WINDOW_MS: z.coerce.number().int().min(0).max(5_000).default(50),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.ENABLE_NAIVE_ENDPOINTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENABLE_NAIVE_ENDPOINTS'],
        message: 'The deliberately unsafe naive endpoints can never be enabled in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Only names and messages are printed, never values (they may be secrets).
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Validated environment, parsed once on first use. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Tests and scripts override settings via process.env, then call this. */
export function resetEnvCache(): void {
  cached = undefined;
}
