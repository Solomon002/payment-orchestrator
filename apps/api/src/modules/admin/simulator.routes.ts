// Simulator endpoints: let the dashboard break the mock gateways on purpose and
// fire test payments, so a viewer can watch failover happen live.
// The browser never talks to the mock gateways directly; the API forwards
// requests using the control key, which never leaves the server.
// Not mounted in production (there are no mock gateways there).
import { mockControlPatchSchema, paymentMethodSchema } from '@po/shared';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { AppError, notFound } from '../../lib/errors';
import { sha256Hex } from '../../lib/crypto';
import { MockGatewayAdapter } from '../gateways/mock.adapter';
import { createPayment } from '../payments/payment.service';
import { pollPendingPayments } from '../../queues/poller';

const firePaymentsSchema = z
  .object({
    count: z.number().int().min(1).max(50),
    method: paymentMethodSchema,
    amountKobo: z.number().int().min(100).max(100_000_000).default(500_000),
  })
  .strict();

export function simulatorRoutes(ctx: AppContext): Router {
  const router = Router();

  const mock = (name: string) => {
    const adapter = ctx.gateways.get(name);
    if (!(adapter instanceof MockGatewayAdapter)) throw notFound('Mock gateway');
    return adapter;
  };

  const forward = async (name: string, path: string, method: 'GET' | 'PUT' | 'POST', body?: unknown) => {
    const adapter = mock(name);
    let res: Response;
    try {
      res = await fetch(`${adapter.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-control-key': ctx.config.MOCK_CONTROL_KEY },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new AppError(502, 'MOCK_UNREACHABLE', `${name} is not running`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AppError(502, 'MOCK_ERROR', `${name} answered HTTP ${res.status}`, json);
    return json;
  };

  router.get('/simulator/gateways', async (_req, res) => {
    const names = ctx.gateways.list().filter((g) => g instanceof MockGatewayAdapter).map((g) => g.name);
    const gateways = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, online: true, ...(await forward(name, '/control', 'GET')) };
        } catch {
          return { name, online: false };
        }
      }),
    );
    res.json({ gateways });
  });

  router.put('/simulator/gateways/:name/control', async (req, res) => {
    const patch = mockControlPatchSchema.parse(req.body);
    res.json(await forward(String(req.params.name), '/control', 'PUT', patch));
  });

  router.post('/simulator/gateways/:name/reset', async (req, res) => {
    res.json(await forward(String(req.params.name), '/control/reset', 'POST', {}));
  });

  router.post('/simulator/gateways/:name/settlements/:action', async (req, res) => {
    const action = z.enum(['tamper', 'omit', 'phantom']).parse(req.params.action);
    const body = z.object({ reference: z.string().max(100).optional(), amountKobo: z.number().int().min(0).optional() }).strict().parse(req.body);
    res.json(await forward(String(req.params.name), `/control/settlements/${action}`, 'POST', body));
  });

  /** Creates test payments for the seeded demo merchant, one after another. */
  router.post('/simulator/payments', async (req, res) => {
    const input = firePaymentsSchema.parse(req.body);
    const merchant = await ctx.prisma.merchant.findUnique({ where: { apiKeyHash: sha256Hex(ctx.config.DEMO_MERCHANT_API_KEY) } });
    if (!merchant) throw new AppError(409, 'NO_DEMO_MERCHANT', 'Run "pnpm --filter @po/api db:seed" first');

    const results: { status: string; gateway?: string | null; code?: string }[] = [];
    for (let i = 0; i < input.count; i++) {
      try {
        const r = await createPayment(ctx, merchant.id, {
          amountKobo: input.amountKobo,
          currency: 'NGN',
          method: input.method,
          reference: `sim-${randomUUID().slice(0, 13)}`,
          customerEmail: 'customer@example.com',
        });
        results.push({ status: r.payment.status, gateway: r.payment.gateway });
      } catch (err) {
        results.push({ status: 'error', code: err instanceof AppError ? err.code : 'INTERNAL_ERROR' });
      }
    }
    const byGateway: Record<string, number> = {};
    for (const r of results) if (r.gateway) byGateway[r.gateway] = (byGateway[r.gateway] ?? 0) + 1;
    const errors: Record<string, number> = {};
    for (const r of results) if (r.code) errors[r.code] = (errors[r.code] ?? 0) + 1;
    res.json({ requested: input.count, accepted: results.filter((r) => r.status === 'pending').length, byGateway, errors });
  });

  router.post('/simulator/poll', async (_req, res) => {
    res.json({ summary: await pollPendingPayments(ctx) });
  });

  return router;
}
