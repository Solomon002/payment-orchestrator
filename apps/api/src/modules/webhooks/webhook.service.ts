// Receiving webhooks: the fast path.
//
// A webhook is the gateway calling US to say "payment X succeeded". Gateways
// retry when we're slow or return an error, and may send the same event more
// than once, so the receiver must be:
//   1. AUTHENTIC  - verify the HMAC signature over the raw bytes. Anyone on the
//                   internet can POST to our URL; only the gateway knows the secret.
//   2. DURABLE    - store the raw event before doing anything else.
//   3. DEDUPLICATED - UNIQUE (gateway, event_id): a resend can't create a second row.
//   4. FAST       - enqueue the real work and answer 200 immediately, so the
//                   gateway doesn't time out and retry while we're still busy.
import type { IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { WEBHOOK_JOB_OPTIONS } from '../../queues/queues';

export type IngestResult =
  | { status: 200; body: { received: true; duplicate?: true; queued?: boolean } }
  | { status: 400 | 401 | 404; body: { error: { code: string; message: string } } };

const MAX_STORED_INVALID_BODY = 10_000;

export async function ingestWebhook(
  ctx: AppContext,
  gatewayName: string,
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
): Promise<IngestResult> {
  const adapter = ctx.gateways.get(gatewayName);
  if (!adapter) return { status: 404, body: { error: { code: 'UNKNOWN_GATEWAY', message: 'Unknown gateway' } } };

  // 1. Signature over the exact bytes received. Re-serialising parsed JSON could
  //    change spacing or key order and break the HMAC, which is why this route uses express.raw().
  if (!adapter.verifySignature(rawBody, headers)) {
    await ctx.prisma.webhookEvent.create({
      data: {
        gateway: gatewayName,
        eventId: `rejected:${randomUUID()}`,
        rawBody: rawBody.toString('utf8').slice(0, MAX_STORED_INVALID_BODY),
        signatureValid: false,
        status: 'rejected',
        lastError: 'invalid signature',
      },
    });
    ctx.log.warn({ gateway: gatewayName }, 'webhook rejected: invalid signature');
    return { status: 401, body: { error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } } };
  }

  let parsed;
  try {
    parsed = adapter.parseWebhook(rawBody);
  } catch {
    return { status: 400, body: { error: { code: 'INVALID_PAYLOAD', message: 'Unrecognised webhook payload' } } };
  }

  // 2 + 3. Store, deduplicating on (gateway, event_id) in one atomic statement.
  const inserted = await ctx.prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_events (id, gateway, event_id, event_type, reference, raw_body, signature_valid, status, received_at)
    VALUES (gen_random_uuid(), ${gatewayName}, ${parsed.eventId}, ${parsed.eventType}, ${parsed.reference},
            ${rawBody.toString('utf8')}, true, 'received', now())
    ON CONFLICT (gateway, event_id) DO NOTHING
    RETURNING id`;

  const row = inserted[0];
  if (!row) {
    await ctx.prisma.webhookEvent.update({
      where: { gateway_eventId: { gateway: gatewayName, eventId: parsed.eventId } },
      data: { duplicateCount: { increment: 1 } },
    });
    ctx.log.info({ gateway: gatewayName, eventId: parsed.eventId }, 'duplicate webhook ignored');
    // Still 200: the gateway did nothing wrong, and a non-2xx would make it retry forever.
    return { status: 200, body: { received: true, duplicate: true } };
  }

  // 4. Enqueue. jobId = row id, so BullMQ itself also refuses a duplicate job.
  //    If Redis is down the event is still safely stored as "received", and the
  //    poller sweeps it into the queue later. We answer 200 either way.
  try {
    await ctx.queues.webhooks.add('process', { webhookEventId: row.id }, { ...WEBHOOK_JOB_OPTIONS, jobId: row.id });
    await ctx.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'queued' } });
    return { status: 200, body: { received: true, queued: true } };
  } catch (err) {
    ctx.log.error({ err, webhookEventId: row.id }, 'failed to enqueue webhook; poller will retry');
    return { status: 200, body: { received: true, queued: false } };
  }
}
