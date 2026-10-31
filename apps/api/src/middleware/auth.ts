import type { RequestHandler, Response } from 'express';
import type { AppContext } from '../context';
import { safeEqual, sha256Hex } from '../lib/crypto';
import { unauthorized } from '../lib/errors';

export interface AuthedMerchant {
  id: string;
  name: string;
}

/**
 * Merchant authentication: `Authorization: Bearer sk_test_...`.
 * We store only SHA-256(key), so a database leak does not leak usable keys.
 * Lookup is by hash, which also means we never compare plaintext keys.
 */
export function merchantAuth(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (\S{20,200})$/.exec(header);
    if (!match?.[1]) throw unauthorized();

    const merchant = await ctx.prisma.merchant.findUnique({
      where: { apiKeyHash: sha256Hex(match[1]) },
      select: { id: true, name: true },
    });
    if (!merchant) throw unauthorized();

    res.locals.merchant = merchant satisfies AuthedMerchant;
    next();
  };
}

export function getMerchant(res: Response): AuthedMerchant {
  const merchant = res.locals.merchant as AuthedMerchant | undefined;
  if (!merchant) throw unauthorized();
  return merchant;
}

/**
 * Admin (dashboard) authentication: `X-Admin-Key: <ADMIN_API_KEY>`.
 * A single shared key is a deliberate simplification for a local demo;
 * see docs/DECISIONS.md for what a production system would use instead.
 */
export function adminAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const provided = req.get('x-admin-key') ?? '';
    if (!provided || !safeEqual(provided, ctx.config.ADMIN_API_KEY)) throw unauthorized('Invalid admin key');
    next();
  };
}
