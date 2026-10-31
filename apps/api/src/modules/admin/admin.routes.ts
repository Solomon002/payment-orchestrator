// Read-only admin endpoints that power the dashboard. Mounted under /admin
// behind the admin key. Amounts are integer kobo; the dashboard formats them.
import { PAYMENT_STATUSES, WEBHOOK_STATUSES, paymentMethodSchema } from '@po/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { NORMAL_SIDE } from '../ledger/accounts';
import { ledgerTotal, naturalBalance } from '../ledger/ledger.service';
import { presentPayment } from '../payments/payment.service';

const listPaymentsQuery = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: paymentMethodSchema.optional(),
  gateway: z.string().max(50).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

const listWebhooksQuery = z.object({
  status: z.enum(WEBHOOK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/overview', async (_req, res) => {
    const [byStatus, volume, byGateway, webhooksByStatus, duplicates, openDiscrepancies, lastRun, total] = await Promise.all([
      ctx.prisma.payment.groupBy({ by: ['status'], _count: true }),
      ctx.prisma.payment.aggregate({ where: { status: 'succeeded' }, _sum: { amountKobo: true } }),
      ctx.prisma.payment.groupBy({ by: ['selectedGateway', 'status'], _count: true }),
      ctx.prisma.webhookEvent.groupBy({ by: ['status'], _count: true }),
      ctx.prisma.webhookEvent.aggregate({ _sum: { duplicateCount: true } }),
      ctx.prisma.discrepancy.count({ where: { resolved: false } }),
      ctx.prisma.reconciliationRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      ledgerTotal(ctx.prisma),
    ]);
    const counts = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const row of byStatus) counts[row.status] = row._count;
    const finished = (counts.succeeded ?? 0) + (counts.failed ?? 0) + (counts.expired ?? 0);

    res.json({
      payments: {
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        succeededVolumeKobo: volume._sum.amountKobo ?? 0n,
        successRate: finished ? (counts.succeeded ?? 0) / finished : null,
      },
      byGateway: byGateway.map((r) => ({ gateway: r.selectedGateway, status: r.status, count: r._count })),
      webhooks: {
        counts: Object.fromEntries(webhooksByStatus.map((r) => [r.status, r._count])),
        duplicatesIgnored: duplicates._sum.duplicateCount ?? 0,
      },
      reconciliation: { openDiscrepancies, lastRun },
      // Sum of every posting ever written. Double-entry means this is ALWAYS zero.
      ledgerCheck: { totalKobo: total, balanced: total === 0n },
    });
  });

  router.get('/payments', async (req, res) => {
    const q = listPaymentsQuery.parse(req.query);
    const payments = await ctx.prisma.payment.findMany({
      where: {
        status: q.status,
        method: q.method,
        selectedGateway: q.gateway,
        ...(q.q
          ? { OR: [{ reference: { contains: q.q } }, { merchantReference: { contains: q.q } }, { customerEmail: { contains: q.q } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = payments.length > q.limit;
    const page = payments.slice(0, q.limit);
    res.json({ payments: page.map(presentPayment), nextCursor: hasMore ? page.at(-1)?.id : null });
  });

  router.get('/payments/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Payment');
    const payment = await ctx.prisma.payment.findUnique({
      where: { id: id.data },
      include: {
        merchant: { select: { id: true, name: true } },
        attempts: { orderBy: { startedAt: 'asc' } },
        journalEntries: {
          orderBy: { createdAt: 'asc' },
          include: { postings: { include: { account: { select: { code: true, type: true } } } } },
        },
      },
    });
    if (!payment) throw notFound('Payment');
    const webhooks = await ctx.prisma.webhookEvent.findMany({
      where: { reference: payment.reference },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, gateway: true, eventId: true, eventType: true, status: true, attempts: true, duplicateCount: true, lastError: true, receivedAt: true, processedAt: true },
    });
    res.json({
      payment: presentPayment(payment),
      merchant: payment.merchant,
      attempts: payment.attempts,
      journalEntries: payment.journalEntries.map((je) => ({
        id: je.id,
        reference: je.reference,
        description: je.description,
        createdAt: je.createdAt,
        postings: je.postings.map((p) => ({ account: p.account.code, type: p.account.type, amountKobo: p.amountKobo })),
      })),
      webhooks,
    });
  });

  router.get('/webhooks', async (req, res) => {
    const q = listWebhooksQuery.parse(req.query);
    const events = await ctx.prisma.webhookEvent.findMany({
      where: { status: q.status },
      orderBy: { receivedAt: 'desc' },
      take: q.limit,
      select: { id: true, gateway: true, eventId: true, eventType: true, reference: true, signatureValid: true, status: true, attempts: true, duplicateCount: true, lastError: true, receivedAt: true, processedAt: true },
    });
    res.json({ events });
  });

  router.get('/webhooks/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Webhook event');
    const event = await ctx.prisma.webhookEvent.findUnique({ where: { id: id.data } });
    if (!event) throw notFound('Webhook event');
    res.json({ event });
  });

  router.get('/ledger/accounts', async (_req, res) => {
    const rows = await ctx.prisma.$queryRaw<{ id: string; code: string; type: keyof typeof NORMAL_SIDE; sum: bigint | null; postings: bigint }[]>`
      SELECT a.id, a.code, a.type::text AS type, SUM(p.amount_kobo)::bigint AS sum, COUNT(p.id) AS postings
      FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
      GROUP BY a.id ORDER BY a.type, a.code`;
    res.json({
      accounts: rows.map((r) => ({
        id: r.id,
        code: r.code,
        type: r.type,
        normalSide: NORMAL_SIDE[r.type],
        balanceKobo: naturalBalance(r.sum ?? 0n, NORMAL_SIDE[r.type]),
        postings: Number(r.postings),
      })),
      totalKobo: await ledgerTotal(ctx.prisma),
    });
  });

  return router;
}
