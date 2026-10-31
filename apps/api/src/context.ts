// The AppContext is every long-lived dependency (database, Redis, gateways,
// queues...) built in one place and passed explicitly to routes and workers.
// Tests and the demo build their own context with different settings, instead
// of the code reaching for hidden global singletons.
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { env, type Env } from './lib/env';
import { logger } from './lib/logger';

export interface AppContext {
  config: Env;
  log: Logger;
  prisma: PrismaClient;
  redis: Redis;
}

export interface ContextOptions {
  config?: Env;
  log?: Logger;
}

export function createContext(options: ContextOptions = {}): AppContext {
  const config = options.config ?? env();
  const log = options.log ?? logger();
  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));

  return { config, log, prisma, redis };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.prisma.$disconnect();
  ctx.redis.disconnect();
}
