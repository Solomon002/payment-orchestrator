// The payment STATE MACHINE: the only legal ways a payment's status may change.
//
//   created ──> pending ──> succeeded
//      │           ├──────> failed
//      │           └──────> expired
//      └──────> failed            (no gateway would take it)
//
// succeeded / failed / expired are TERMINAL: nothing moves a payment out of them.
// Without this, a late "failed" webhook could flip an already-succeeded
// payment, and the money already credited to the merchant would no longer match.
import type { PaymentStatus, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';

export const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['pending', 'failed'],
  pending: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  expired: [],
};

export const isTerminal = (s: PaymentStatus) => TRANSITIONS[s].length === 0;

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends AppError {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(409, 'ILLEGAL_TRANSITION', `A payment cannot move from ${from} to ${to}`);
  }
}

export class ConcurrentUpdateError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} changed status concurrently`);
    this.name = 'ConcurrentUpdateError';
  }
}

/**
 * Changes status only if the transition is legal AND the row is still in the
 * status we think it is ("compare-and-set"). If someone else changed it in the
 * meantime, zero rows match and we throw instead of overwriting their change.
 */
export async function transition(
  tx: Prisma.TransactionClient,
  paymentId: string,
  from: PaymentStatus,
  to: PaymentStatus,
  data: Prisma.PaymentUpdateManyMutationInput = {},
): Promise<void> {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  const { count } = await tx.payment.updateMany({
    where: { id: paymentId, status: from },
    data: { ...data, status: to },
  });
  if (count !== 1) throw new ConcurrentUpdateError(paymentId);
}
