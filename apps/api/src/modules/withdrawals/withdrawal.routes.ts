import { createWithdrawalSchema } from '@po/shared';
import { Router } from 'express';
import type { AppContext } from '../../context';
import { getMerchant } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { moneyLimiter } from '../../middleware/rateLimit';
import { merchantBalances, withdrawNaive, withdrawSafe } from './withdrawal.service';

export function withdrawalRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = moneyLimiter(ctx.config.RATE_LIMIT_MONEY_PER_MIN);

  router.get('/balance', async (_req, res) => {
    res.json(await merchantBalances(ctx, getMerchant(res).id));
  });

  router.post('/withdrawals', limiter, idempotency(ctx), async (req, res) => {
    const input = createWithdrawalSchema.parse(req.body);
    const merchant = getMerchant(res);
    const withdrawal = await withdrawSafe(ctx, merchant.id, BigInt(input.amountKobo), req.get('idempotency-key')!);
    res.status(201).json({ withdrawal, balance: await merchantBalances(ctx, merchant.id) });
  });

  // Teaching endpoint: no lock, no idempotency. See withdrawal.service.ts.
  if (ctx.config.ENABLE_NAIVE_ENDPOINTS) {
    router.post('/withdrawals/naive', limiter, async (req, res) => {
      const input = createWithdrawalSchema.parse(req.body);
      const merchant = getMerchant(res);
      const withdrawal = await withdrawNaive(ctx, merchant.id, BigInt(input.amountKobo));
      res.status(201).json({ withdrawal });
    });
  }

  return router;
}
