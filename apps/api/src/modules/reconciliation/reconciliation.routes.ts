import express, { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { runReconciliation } from './reconciliation.service';
import { importSettlementCsv, importSettlementsFromGateways } from './settlement.importer';

const runSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    importFirst: z.boolean().default(true),
  })
  .strict();

/** Mounted under /admin (admin key required). */
export function reconciliationRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/reconciliation/run', async (req, res) => {
    const input = runSchema.parse(req.body ?? {});
    const run = await runReconciliation(ctx, input);
    res.status(201).json({ run });
  });

  router.post('/reconciliation/import', async (_req, res) => {
    res.json({ imported: await importSettlementsFromGateways(ctx) });
  });

  router.post(
    '/reconciliation/settlements/upload',
    express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
    async (req, res) => {
      const text = typeof req.body === 'string' ? req.body : '';
      res.status(201).json({ imported: await importSettlementCsv(ctx, text) });
    },
  );

  router.get('/reconciliation/runs', async (_req, res) => {
    const runs = await ctx.prisma.reconciliationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
    res.json({ runs });
  });

  router.get('/reconciliation/runs/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Run');
    const run = await ctx.prisma.reconciliationRun.findUnique({
      where: { id: id.data },
      include: { discrepancies: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw notFound('Run');
    res.json({ run });
  });

  router.get('/reconciliation/discrepancies', async (req, res) => {
    const resolved = req.query.resolved === 'true' ? true : req.query.resolved === 'false' ? false : undefined;
    const discrepancies = await ctx.prisma.discrepancy.findMany({
      where: resolved === undefined ? {} : { resolved },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ discrepancies });
  });

  router.post('/reconciliation/discrepancies/:id/resolve', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Discrepancy');
    const { note } = z.object({ note: z.string().min(3).max(500) }).strict().parse(req.body);
    const updated = await ctx.prisma.discrepancy.updateMany({
      where: { id: id.data },
      data: { resolved: true, resolvedNote: note },
    });
    if (updated.count === 0) throw notFound('Discrepancy');
    res.json({ ok: true });
  });

  return router;
}
