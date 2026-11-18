// A fake payment gateway we can break on purpose.
//
// It behaves like a simplified real gateway (initialize a charge, verify it,
// send a signed webhook when it completes, export settlements) but every
// failure mode is controllable at runtime through /control endpoints:
// latency, error rate, per-method outages, and webhook misbehaviour
// (duplicate, delayed, dropped, wrong signature).
import {
  bankCodeSchema,
  mockControlPatchSchema,
  paymentMethodSchema,
  type MockControl,
  type MockWebhook,
  type PaymentMethod,
  type SettlementRow,
} from '@po/shared';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface MockGatewayOptions {
  name: string;
  /** Used for Bearer auth on the charge API and to sign webhooks (like a gateway secret key). */
  secret: string;
  /** Required on /control endpoints. */
  controlKey: string;
  /** Where to POST webhooks, e.g. http://localhost:4000/webhooks/mockpay-a */
  webhookUrl: string;
  /** Public base URL of this mock (used for the fake checkout URL). */
  publicUrl: string;
  feeBps: number;
  feeCapKobo: number;
  /** Delivery retries when the receiver does not answer 2xx (real gateways retry too). */
  webhookRetries?: number;
  webhookRetryBaseMs?: number;
  log?: (msg: string) => void;
}

export interface Charge {
  reference: string;
  gatewayReference: string;
  amountKobo: number;
  feeKobo: number;
  email: string;
  method: PaymentMethod;
  bankCode: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: string;
  paidAt: string | null;
}

export interface Delivery {
  eventId: string;
  reference: string;
  mode: MockControl['webhookMode'];
  attempts: number;
  lastStatus: number | string | null;
  at: string;
}

export const DEFAULT_CONTROL: MockControl = {
  latencyMs: 50,
  failureRate: 0,
  declineRate: 0,
  methodOutages: { card: false, bank_transfer: false },
  bankOutages: [],
  webhookMode: 'normal',
  webhookDelayMs: 5_000,
  completionDelayMs: 300,
};

const chargeInputSchema = z.object({
  reference: z.string().min(1).max(100),
  amountKobo: z.number().int().positive(),
  email: z.string().email(),
  method: paymentMethodSchema,
  bankCode: bankCodeSchema.optional(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function signWebhook(secret: string, rawBody: string) {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export function createMockGateway(opts: MockGatewayOptions) {
  const log = opts.log ?? (() => {});
  const control: MockControl = structuredClone(DEFAULT_CONTROL);
  const charges = new Map<string, Charge>();
  const deliveries: Delivery[] = [];
  const timers = new Set<NodeJS.Timeout>();
  // Reconciliation fault injection
  const settlementOverrides = new Map<string, number>(); // reference -> reported amount
  const omittedSettlements = new Set<string>();
  const phantomSettlements: SettlementRow[] = [];
  let closed = false;

  const later = (ms: number, fn: () => void) => {
    if (closed) return;
    const t = setTimeout(() => {
      timers.delete(t);
      if (!closed) fn();
    }, ms);
    timers.add(t);
  };

  const fee = (amount: number) =>
    Math.min(opts.feeCapKobo, Math.floor((amount * opts.feeBps + 5_000) / 10_000));

  // ---------------- webhooks ----------------

  async function post(rawBody: string, signature: string): Promise<number | string> {
    try {
      const res = await fetch(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
        body: rawBody,
        signal: AbortSignal.timeout(5_000),
      });
      return res.status;
    } catch (err) {
      return (err as Error).name;
    }
  }

  async function deliverWithRetry(delivery: Delivery, rawBody: string, signature: string) {
    const retries = opts.webhookRetries ?? 3;
    const base = opts.webhookRetryBaseMs ?? 1_000;
    for (let attempt = 0; attempt <= retries && !closed; attempt++) {
      delivery.attempts++;
      const status = await post(rawBody, signature);
      delivery.lastStatus = status;
      if (typeof status === 'number' && status >= 200 && status < 300) return;
      if (attempt < retries) await sleep(base * 2 ** attempt);
    }
  }

  function sendWebhook(charge: Charge) {
    const event: MockWebhook = {
      id: `evt_${randomUUID()}`,
      type: charge.status === 'succeeded' ? 'charge.succeeded' : 'charge.failed',
      data: {
        reference: charge.reference,
        gatewayReference: charge.gatewayReference,
        amountKobo: charge.amountKobo,
        feeKobo: charge.feeKobo,
        method: charge.method,
        status: charge.status === 'succeeded' ? 'succeeded' : 'failed',
        paidAt: charge.paidAt,
      },
    };
    const rawBody = JSON.stringify(event);
    const mode = control.webhookMode;
    const signature = signWebhook(mode === 'bad_signature' ? `${opts.secret}-WRONG` : opts.secret, rawBody);
    const delivery: Delivery = {
      eventId: event.id,
      reference: charge.reference,
      mode,
      attempts: 0,
      lastStatus: null,
      at: new Date().toISOString(),
    };
    deliveries.unshift(delivery);
    deliveries.length = Math.min(deliveries.length, 200);
    log(`webhook ${event.type} ${charge.reference} mode=${mode}`);

    switch (mode) {
      case 'drop':
        delivery.lastStatus = 'dropped';
        return;
      case 'delayed':
        later(control.webhookDelayMs, () => void deliverWithRetry(delivery, rawBody, signature));
        return;
      case 'duplicate':
        // Identical body and event id, three times: exactly what a retrying gateway does.
        void deliverWithRetry(delivery, rawBody, signature);
        later(100, () => void deliverWithRetry(delivery, rawBody, signature));
        later(400, () => void deliverWithRetry(delivery, rawBody, signature));
        return;
      default:
        void deliverWithRetry(delivery, rawBody, signature);
    }
  }

  function complete(charge: Charge) {
    const declined = Math.random() * 100 < control.declineRate;
    charge.status = declined ? 'failed' : 'succeeded';
    charge.feeKobo = declined ? 0 : fee(charge.amountKobo);
    charge.paidAt = declined ? null : new Date().toISOString();
    sendWebhook(charge);
  }

  // ---------------- HTTP app ----------------

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const requireSecret = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), opts.secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
  const requireControlKey = (req: Request, res: Response, next: NextFunction) => {
    if (!safeEqual(req.get('x-control-key') ?? '', opts.controlKey)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.get('/health', (_req, res) => {
    res.json({ name: opts.name, status: 'ok' });
  });

  app.post('/charges', requireSecret, async (req, res) => {
    const parsed = chargeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const input = parsed.data;
    await sleep(control.latencyMs);

    if (control.methodOutages[input.method]) {
      res.status(503).json({ error: 'method_unavailable', message: `${input.method} is currently unavailable` });
      return;
    }
    // A specific bank's TRANSFERS failing on this gateway (its cards may still work).
    // The distinct error code lets the orchestrator blame the BANK, not the gateway.
    if (input.method === 'bank_transfer' && input.bankCode && control.bankOutages.includes(input.bankCode)) {
      res.status(503).json({ error: 'bank_unavailable', bankCode: input.bankCode, message: `Bank ${input.bankCode} is currently unavailable` });
      return;
    }
    if (Math.random() * 100 < control.failureRate) {
      res.status(503).json({ error: 'gateway_error', message: 'Simulated gateway failure' });
      return;
    }

    // Initializing the same reference twice returns the same charge (gateways dedupe on reference too).
    const existing = charges.get(input.reference);
    if (existing) {
      res.json({ gatewayReference: existing.gatewayReference, status: existing.status, checkoutUrl: `${opts.publicUrl}/checkout/${existing.reference}` });
      return;
    }

    const charge: Charge = {
      reference: input.reference,
      gatewayReference: `${opts.name}_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      amountKobo: input.amountKobo,
      feeKobo: 0,
      email: input.email,
      method: input.method,
      bankCode: input.bankCode ?? null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      paidAt: null,
    };
    charges.set(charge.reference, charge);
    // The simulated customer completes payment shortly after.
    later(control.completionDelayMs, () => complete(charge));

    res.json({ gatewayReference: charge.gatewayReference, status: charge.status, checkoutUrl: `${opts.publicUrl}/checkout/${charge.reference}` });
  });

  app.get('/charges/:reference', requireSecret, async (req, res) => {
    await sleep(control.latencyMs);
    const charge = charges.get(String(req.params.reference));
    if (!charge) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(charge);
  });

  function settlementRows(): SettlementRow[] {
    const rows: SettlementRow[] = [];
    for (const c of charges.values()) {
      if (c.status !== 'succeeded' || !c.paidAt || omittedSettlements.has(c.reference)) continue;
      rows.push({
        reference: c.reference,
        amountKobo: settlementOverrides.get(c.reference) ?? c.amountKobo,
        feeKobo: c.feeKobo,
        settledAt: c.paidAt,
        batchId: `${opts.name}-${c.paidAt.slice(0, 10).replaceAll('-', '')}`,
      });
    }
    return [...rows, ...phantomSettlements];
  }

  app.get('/settlements', requireSecret, (_req, res) => {
    res.json({ gateway: opts.name, settlements: settlementRows() });
  });

  app.get('/settlements.csv', requireSecret, (_req, res) => {
    const lines = ['gateway,reference,amount_kobo,fee_kobo,settled_at,batch_id'];
    for (const r of settlementRows()) {
      lines.push([opts.name, r.reference, r.amountKobo, r.feeKobo, r.settledAt, r.batchId].join(','));
    }
    res.type('text/csv').send(`${lines.join('\n')}\n`);
  });

  // ---------------- control (simulator) ----------------

  app.get('/control', requireControlKey, (_req, res) => {
    const all = [...charges.values()];
    res.json({
      name: opts.name,
      control,
      stats: {
        charges: all.length,
        succeeded: all.filter((c) => c.status === 'succeeded').length,
        failed: all.filter((c) => c.status === 'failed').length,
        pending: all.filter((c) => c.status === 'pending').length,
      },
      recentDeliveries: deliveries.slice(0, 20),
    });
  });

  app.put('/control', requireControlKey, (req, res) => {
    const parsed = mockControlPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_control', issues: parsed.error.issues });
      return;
    }
    const { methodOutages, ...rest } = parsed.data;
    Object.assign(control, rest);
    if (methodOutages) Object.assign(control.methodOutages, methodOutages);
    log(`control updated ${JSON.stringify(control)}`);
    res.json({ control });
  });

  app.post('/control/reset', requireControlKey, (_req, res) => {
    Object.assign(control, structuredClone(DEFAULT_CONTROL));
    settlementOverrides.clear();
    omittedSettlements.clear();
    phantomSettlements.length = 0;
    res.json({ control });
  });

  // Forget every charge and delivery (used by the public demo's hourly reset, so
  // old charges don't reappear in settlement reports after the database is wiped).
  app.post('/control/clear', requireControlKey, (_req, res) => {
    charges.clear();
    deliveries.length = 0;
    settlementOverrides.clear();
    omittedSettlements.clear();
    phantomSettlements.length = 0;
    res.json({ ok: true });
  });

  const tamperSchema = z.object({ reference: z.string().min(1), amountKobo: z.number().int().nonnegative() });
  app.post('/control/settlements/tamper', requireControlKey, (req, res) => {
    const input = tamperSchema.parse(req.body);
    settlementOverrides.set(input.reference, input.amountKobo);
    res.json({ ok: true });
  });

  app.post('/control/settlements/omit', requireControlKey, (req, res) => {
    const input = z.object({ reference: z.string().min(1) }).parse(req.body);
    omittedSettlements.add(input.reference);
    res.json({ ok: true });
  });

  app.post('/control/settlements/phantom', requireControlKey, (req, res) => {
    const input = z.object({ amountKobo: z.number().int().positive() }).parse(req.body);
    const now = new Date().toISOString();
    const row: SettlementRow = {
      reference: `phantom_${randomUUID().slice(0, 8)}`,
      amountKobo: input.amountKobo,
      feeKobo: fee(input.amountKobo),
      settledAt: now,
      batchId: `${opts.name}-${now.slice(0, 10).replaceAll('-', '')}`,
    };
    phantomSettlements.push(row);
    res.json({ ok: true, settlement: row });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'invalid_request', issues: err.issues });
      return;
    }
    const type = (err as { type?: string }).type;
    res.status(type === 'entity.parse.failed' ? 400 : 500).json({ error: type ?? 'internal_error' });
  });

  return {
    app,
    control,
    charges,
    deliveries,
    close() {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export type MockGateway = ReturnType<typeof createMockGateway>;
