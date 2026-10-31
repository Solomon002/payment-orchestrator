import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { bigintReplacer } from './lib/money';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp(ctx: AppContext): Express {
  const app = express();

  app.disable('x-powered-by');
  // JSON has no BigInt; convert kobo amounts to numbers (safely) on the way out.
  app.set('json replacer', bigintReplacer);

  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: ctx.config.DASHBOARD_ORIGIN,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Admin-Key'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
    }),
  );

  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    const checks = { database: 'ok', redis: 'ok' };
    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.database = 'down';
    }
    try {
      await ctx.redis.ping();
    } catch {
      checks.redis = 'down';
    }
    const ok = checks.database === 'ok' && checks.redis === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
  });

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.config.NODE_ENV === 'production'));
  return app;
}
