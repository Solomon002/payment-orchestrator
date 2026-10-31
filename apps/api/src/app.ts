import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { bigintReplacer } from './lib/money';
import { adminAuth, merchantAuth } from './middleware/auth';
import { adminRoutes } from './modules/admin/admin.routes';
import { simulatorRoutes } from './modules/admin/simulator.routes';
import { reconciliationRoutes } from './modules/reconciliation/reconciliation.routes';
import { routingRoutes } from './modules/routing/routing.routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalLimiter } from './middleware/rateLimit';
import { paymentRoutes } from './modules/payments/payment.routes';
import { webhookRoutes } from './modules/webhooks/webhook.routes';
import { withdrawalRoutes } from './modules/withdrawals/withdrawal.routes';

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

  app.use(globalLimiter(ctx.config.RATE_LIMIT_GLOBAL_PER_MIN));

  // Webhooks need the RAW body for signature checks, so they are mounted
  // before the JSON parser below gets a chance to consume it.
  app.use('/webhooks', webhookRoutes(ctx));

  app.use(express.json({ limit: '100kb' }));

  // ---- Merchant API (Bearer API key) ----
  const v1 = express.Router();
  v1.use(merchantAuth(ctx));
  v1.use(paymentRoutes(ctx));
  v1.use(withdrawalRoutes(ctx));
  app.use('/v1', v1);

  // ---- Admin API for the dashboard (X-Admin-Key) ----
  const admin = express.Router();
  admin.use(adminAuth(ctx));
  admin.use(routingRoutes(ctx));
  admin.use(reconciliationRoutes(ctx));
  admin.use(adminRoutes(ctx));
  if (ctx.config.NODE_ENV !== 'production') admin.use(simulatorRoutes(ctx));
  app.use('/admin', admin);

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
