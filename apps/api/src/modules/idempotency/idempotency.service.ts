// Idempotency: "doing it twice has the same effect as doing it once".
//
// Analogy: a coat-check ticket. The first time you hand over ticket #42 the
// attendant does the work and pins the result to the ticket. Show #42 again
// and you get the same result back; nothing is done twice. Show #42 with a
// different coat and the attendant refuses: that ticket is already used.
//
// The UNIQUE (merchant_id, key) index is what makes this safe under concurrency:
// if two identical requests arrive at the same instant, only one INSERT can win.
import { Prisma, type PrismaClient } from '@prisma/client';
import { toJsonValue } from '../../lib/money';

/** An in-progress claim older than this is assumed to belong to a crashed request. */
export const STALE_LOCK_SECONDS = 60;

export type Claim =
  | { kind: 'new'; id: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

export async function claimIdempotencyKey(
  prisma: PrismaClient,
  merchantId: string,
  key: string,
  requestHash: string,
): Promise<Claim> {
  const inserted = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO idempotency_keys (id, merchant_id, key, request_hash, status, locked_at, created_at)
    VALUES (gen_random_uuid(), ${merchantId}::uuid, ${key}, ${requestHash}, 'in_progress', now(), now())
    ON CONFLICT (merchant_id, key) DO NOTHING
    RETURNING id`;
  if (inserted[0]) return { kind: 'new', id: inserted[0].id };

  const existing = await prisma.idempotencyKey.findUnique({
    where: { merchantId_key: { merchantId, key } },
  });
  if (!existing) {
    // The other request released its claim between our INSERT and SELECT; try once more.
    return claimIdempotencyKey(prisma, merchantId, key, requestHash);
  }
  if (existing.requestHash !== requestHash) return { kind: 'mismatch' };
  if (existing.status === 'completed') {
    return { kind: 'replay', status: existing.responseStatus ?? 200, body: existing.responseBody };
  }

  // Still in progress. If the owner looks crashed, take over the claim atomically.
  const reclaimed = await prisma.$executeRaw`
    UPDATE idempotency_keys SET locked_at = now()
    WHERE id = ${existing.id}::uuid AND status = 'in_progress'
      AND locked_at < now() - make_interval(secs => ${STALE_LOCK_SECONDS})`;
  return reclaimed === 1 ? { kind: 'new', id: existing.id } : { kind: 'in_progress' };
}

export async function completeIdempotencyKey(prisma: PrismaClient, id: string, status: number, body: unknown) {
  await prisma.idempotencyKey.update({
    where: { id },
    data: {
      status: 'completed',
      responseStatus: status,
      responseBody: (toJsonValue(body) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

/** Server errors are not stored, so the client may safely retry with the same key. */
export async function releaseIdempotencyKey(prisma: PrismaClient, id: string) {
  await prisma.idempotencyKey.deleteMany({ where: { id, status: 'in_progress' } });
}
