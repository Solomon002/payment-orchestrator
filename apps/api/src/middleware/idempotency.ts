import { idempotencyKeySchema } from '@po/shared';
import type { RequestHandler } from 'express';
import type { AppContext } from '../context';
import { sha256Hex, stableStringify } from '../lib/crypto';
import { AppError } from '../lib/errors';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
} from '../modules/idempotency/idempotency.service';
import { getMerchant } from './auth';

/**
 * Requires an `Idempotency-Key` header on money-moving requests.
 *  - same key + same body      -> the stored response is replayed (header Idempotent-Replayed: true)
 *  - same key + different body -> 422 IDEMPOTENCY_KEY_REUSED
 *  - same key still running    -> 409 IDEMPOTENCY_IN_PROGRESS
 * Must run after merchantAuth (keys are scoped per merchant).
 */
export function idempotency(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const merchant = getMerchant(res);
    const parsedKey = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!parsedKey.success) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header (8-255 chars of A-Z a-z 0-9 . _ : -) is required for this endpoint',
      );
    }
    const key = parsedKey.data;
    // The fingerprint covers method, path and the canonicalised body.
    const requestHash = sha256Hex(`${req.method} ${req.baseUrl}${req.path}\n${stableStringify(req.body ?? null)}`);

    const claim = await claimIdempotencyKey(ctx.prisma, merchant.id, key, requestHash);
    if (claim.kind === 'replay') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(claim.status).json(claim.body);
      return;
    }
    if (claim.kind === 'mismatch') {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body',
      );
    }
    if (claim.kind === 'in_progress') {
      throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    }

    // We own the key. Intercept the response so it is saved BEFORE it is sent:
    // a client that retries the instant it gets a reply must see the stored result.
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const persist =
        status >= 500
          ? releaseIdempotencyKey(ctx.prisma, claim.id)
          : completeIdempotencyKey(ctx.prisma, claim.id, status, body);
      persist
        .then(() => sendJson(body))
        .catch((err: unknown) => {
          req.log.error({ err }, 'failed to persist idempotency result');
          res.json = sendJson;
          res.status(500);
          sendJson({ error: { code: 'INTERNAL_ERROR', message: 'Failed to record request outcome' } });
        });
      return res;
    };
    next();
  };
}
