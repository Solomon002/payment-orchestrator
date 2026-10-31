import express, { Router } from 'express';
import type { AppContext } from '../../context';
import { ingestWebhook } from './webhook.service';

/**
 * POST /webhooks/:gateway
 * Uses express.raw() so the handler gets the exact bytes the gateway signed.
 * This router is mounted BEFORE the global JSON parser for that reason.
 */
export function webhookRoutes(ctx: AppContext): Router {
  const router = Router();
  router.post('/:gateway', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await ingestWebhook(ctx, String(req.params.gateway), raw, req.headers);
    res.status(result.status).json(result.body);
  });
  return router;
}
