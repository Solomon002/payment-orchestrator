import type { Response } from 'express';
import { rateLimit } from 'express-rate-limit';

const rateLimitedBody = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down and retry later' },
};

/** Per-IP limit for every route: blunts brute-force and accidental floods. */
export function globalLimiter(perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: rateLimitedBody,
  });
}

/**
 * Per-merchant limit on money-moving endpoints (runs after auth).
 * Note: the in-memory store is per process. With several API instances you
 * would use a shared Redis store so the limit is global.
 */
export function moneyLimiter(perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: rateLimitedBody,
    keyGenerator: (_req, res: Response) => `merchant:${(res.locals.merchant as { id: string }).id}`,
  });
}
