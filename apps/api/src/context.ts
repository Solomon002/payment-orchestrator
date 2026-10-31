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
import { StaticRouter } from './modules/routing/static.router';
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
  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on('error', (err) => log.error({ err: err.message }, 'redis error'));
  const gateways = options.gateways ?? registryFromEnv(config);
  const queues = createQueues(config.REDIS_URL);

  const base = { config, log, prisma, redis, gateways, queues };
  const router = options.router ? options.router(base) : new StaticRouter(gateways);
  return { ...base, router };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.queues.close();
  await ctx.prisma.$disconnect();
  ctx.redis.disconnect();
}
