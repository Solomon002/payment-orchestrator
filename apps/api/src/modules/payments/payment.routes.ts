import { createPaymentSchema } from '@po/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { getMerchant } from '../../middleware/auth';
import { idempotency } from '../../middleware/idempotency';
import { moneyLimiter } from '../../middleware/rateLimit';
import { createPayment, presentPayment } from './payment.service';

export function paymentRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/payments', moneyLimiter(ctx.config.RATE_LIMIT_MONEY_PER_MIN), idempotency(ctx), async (req, res) => {
    const input = createPaymentSchema.parse(req.body);
    const result = await createPayment(ctx, getMerchant(res).id, input);
    res.status(result.status).json({ payment: result.payment });
  });

  router.get('/payments/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Payment');
    // Scoped to the authenticated merchant: one merchant can never read another's payment.
    const payment = await ctx.prisma.payment.findFirst({ where: { id: id.data, merchantId: getMerchant(res).id } });
    if (!payment) throw notFound('Payment');
    res.json({ payment: presentPayment(payment) });
  });

  return router;
}
