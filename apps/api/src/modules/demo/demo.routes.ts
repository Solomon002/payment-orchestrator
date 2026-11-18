import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { createDemoSession, DEMO_MAX_PAYMENTS_PER_REQUEST, nextResetAt } from './demo.service';

/** Public (no auth) endpoints under /demo. */
export function demoRoutes(ctx: AppContext): Router {
  const router = Router();

  // The dashboard asks this to decide whether to show "Try the live demo".
  router.get('/info', async (_req, res) => {
    if (!ctx.config.PUBLIC_DEMO) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      enabled: true,
      resetIntervalMinutes: ctx.config.DEMO_RESET_INTERVAL_MS / 60_000,
      nextResetAt: await nextResetAt(ctx),
      sessionMinutes: ctx.config.DEMO_SESSION_TTL_MS / 60_000,
      limits: {
        paymentsPerClick: DEMO_MAX_PAYMENTS_PER_REQUEST,
        paymentsPerHour: ctx.config.DEMO_PAYMENTS_PER_SESSION_PER_HOUR,
      },
    });
  });

  // Limits how many sessions one IP can create (stops scripted session farming).
  const sessionLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: ctx.config.DEMO_SESSIONS_PER_IP_PER_HOUR,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many demo sessions from this address; try again later' } },
  });

  router.post('/session', sessionLimiter, async (_req, res) => {
    if (!ctx.config.PUBLIC_DEMO) throw notFound('Route');
    const session = await createDemoSession(ctx);
    res.status(201).json({ ...session, role: 'demo' });
  });

  return router;
}
