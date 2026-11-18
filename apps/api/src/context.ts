// The AppContext is every long-lived dependency (database, Redis, gateways,
// queues...) built in one place and passed explicitly to routes and workers.
// Tests and the demo build their own context with different settings, instead
// of the code reaching for hidden global singletons.
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { env, type Env } from './lib/env';
import { logger } from './lib/logger';
import { GatewayRegistry, registryFromEnv } from './modules/gateways/registry';
import type { GatewayRouter } from './modules/routing/router.types';
import { HealthAwareRouter } from './modules/routing/health.router';
import { createQueues, type Queues } from './queues/queues';

export interface AppContext {
  config: Env;
  log: Logger;
  prisma: PrismaClient;
  redis: Redis;
  gateways: GatewayRegistry;
  router: GatewayRouter;
  queues: Queues;
}

export interface ContextOptions {
  config?: Env;
  log?: Logger;
  gateways?: GatewayRegistry;
  router?: (ctx: Omit<AppContext, 'router'>) => GatewayRouter;
}

export function createContext(options: ContextOptions = {}): AppContext {
  const config = options.config ?? env();
  const log = options.log ?? logger();
  const prisma = new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
    // Prisma's default is 2s to START an interactive transaction. On a cold
    // connection pool (fresh process, Docker on Windows) opening connections can
    // take longer than that, and the transaction failed before doing anything.
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });
  // Open the pool now rather than on the first payment.
  prisma.$connect().catch((err: unknown) => log.error({ err }, 'initial database connection failed'));
  // family: 0 lets ioredis use IPv4 or IPv6 (Railway's private network is IPv6-only).
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, family: 0 });
  redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));
  const gateways = options.gateways ?? registryFromEnv(config);
  const queues = createQueues(config.REDIS_URL);

  const base = { config, log, prisma, redis, gateways, queues };
  // Default: health-aware routing with per-(gateway, method) circuit breakers.
  const router = options.router ? options.router(base) : new HealthAwareRouter(gateways, redis, config);
  return { ...base, router };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.queues.close();
  await ctx.prisma.$disconnect();
  ctx.redis.disconnect();
}
