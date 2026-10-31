import { Router } from 'express';
import type { AppContext } from '../../context';
import { HealthAwareRouter } from './health.router';

/** Mounted under /admin (admin key required). */
export function routingRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/routing/health', async (_req, res) => {
    if (!(ctx.router instanceof HealthAwareRouter)) {
      res.json({ mode: 'static', routes: [] });
      return;
    }
    res.json({
      mode: 'health-aware',
      thresholds: {
        windowSize: ctx.config.ROUTING_WINDOW_SIZE,
        minSamples: ctx.config.ROUTING_MIN_SAMPLES,
        minSuccessRate: ctx.config.ROUTING_MIN_SUCCESS_RATE,
        cooldownMs: ctx.config.ROUTING_COOLDOWN_MS,
        probeSuccesses: ctx.config.ROUTING_PROBE_SUCCESSES,
      },
      routes: await ctx.router.snapshot(),
    });
  });

  router.post('/routing/reset', async (_req, res) => {
    if (ctx.router instanceof HealthAwareRouter) await ctx.router.tracker.reset();
    res.json({ ok: true });
  });

  return router;
}
