import type { RequestHandler, Response } from 'express';
import type { AppContext } from '../context';
import { safeEqual, sha256Hex } from '../lib/crypto';
import { unauthorized } from '../lib/errors';
import { getDemoSession } from '../modules/demo/demo.service';

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

export type AdminRole = 'owner' | 'demo';

/**
 * Dashboard authentication via `X-Admin-Key`. Two kinds of credential:
 *  - the owner's ADMIN_API_KEY (full access), compared in constant time;
 *  - when PUBLIC_DEMO=true, a temporary demo session token (limited access,
 *    enforced by demoPolicy).
 * A single shared owner key is a deliberate simplification; see docs/DECISIONS.md.
 */
export function adminAuth(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const provided = req.get('x-admin-key') ?? '';
    if (provided && safeEqual(provided, ctx.config.ADMIN_API_KEY)) {
      res.locals.role = 'owner' satisfies AdminRole;
      return next();
    }
    const session = provided ? await getDemoSession(ctx, provided) : null;
    if (session) {
      res.locals.role = 'demo' satisfies AdminRole;
      res.locals.demoSession = session;
      return next();
    }
    throw unauthorized('Invalid admin key');
  };
}

export const roleOf = (res: Response): AdminRole => (res.locals.role as AdminRole | undefined) ?? 'owner';
