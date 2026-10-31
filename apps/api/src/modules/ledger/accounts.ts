// Ledger accounts ("buckets" money can sit in) and how to find them.
//
// Each account has a NORMAL SIDE. Postings are stored signed: debit = +, credit = -.
//  - Asset/expense accounts are debit-normal: their balance is sum(postings).
//  - Liability/revenue/equity accounts are credit-normal: their balance is -sum(postings).
// Example: when a merchant is owed NGN 100, merchant_balance gets a -10,000 kobo
// posting (credit), and its natural balance reads +10,000.
import { AccountType, NormalSide, Prisma, type PrismaClient } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export const NORMAL_SIDE: Record<AccountType, NormalSide> = {
  merchant_balance: NormalSide.credit,
  merchant_pending: NormalSide.credit,
  payments_pending: NormalSide.debit,
  gateway_clearing: NormalSide.debit,
  gateway_fees: NormalSide.debit,
  platform_revenue: NormalSide.credit,
  payouts_clearing: NormalSide.credit,
  opening_balance: NormalSide.credit,
};

export const accountCode = {
  merchantBalance: (merchantId: string) => `merchant_balance:${merchantId}`,
  merchantPending: (merchantId: string) => `merchant_pending:${merchantId}`,
  paymentsPending: () => 'payments_pending',
  gatewayClearing: (gateway: string) => `gateway_clearing:${gateway}`,
  gatewayFees: (gateway: string) => `gateway_fees:${gateway}`,
  platformRevenue: () => 'platform_revenue',
  payoutsClearing: () => 'payouts_clearing',
  openingBalance: () => 'opening_balance',
};

interface AccountSpec {
  code: string;
  type: AccountType;
  merchantId?: string;
  gateway?: string;
}

/**
 * Creates the account if missing and returns its id. Uses INSERT ... ON CONFLICT
 * so two concurrent callers can't both create it (a plain "find, then create"
 * would race and one would crash on the unique index).
 */
export async function ensureAccount(db: Db, spec: AccountSpec): Promise<string> {
  await db.$executeRaw`
    INSERT INTO accounts (id, code, type, normal_side, merchant_id, gateway, currency, created_at)
    VALUES (gen_random_uuid(), ${spec.code}, ${spec.type}::"AccountType", ${NORMAL_SIDE[spec.type]}::"NormalSide",
            ${spec.merchantId ?? null}::uuid, ${spec.gateway ?? null}, 'NGN', now())
    ON CONFLICT (code) DO NOTHING`;
  const account = await db.account.findUniqueOrThrow({ where: { code: spec.code }, select: { id: true } });
  return account.id;
}

export async function accountIdByCode(db: Db, code: string): Promise<string> {
  const account = await db.account.findUnique({ where: { code }, select: { id: true } });
  if (!account) throw new Error(`Ledger account ${code} does not exist`);
  return account.id;
}

export async function ensureMerchantAccounts(db: Db, merchantId: string) {
  const balance = await ensureAccount(db, {
    code: accountCode.merchantBalance(merchantId),
    type: AccountType.merchant_balance,
    merchantId,
  });
  const pending = await ensureAccount(db, {
    code: accountCode.merchantPending(merchantId),
    type: AccountType.merchant_pending,
    merchantId,
  });
  return { balance, pending };
}

export async function ensureGatewayAccounts(db: Db, gateway: string) {
  const clearing = await ensureAccount(db, {
    code: accountCode.gatewayClearing(gateway),
    type: AccountType.gateway_clearing,
    gateway,
  });
  const fees = await ensureAccount(db, {
    code: accountCode.gatewayFees(gateway),
    type: AccountType.gateway_fees,
    gateway,
  });
  return { clearing, fees };
}

export async function ensureSystemAccounts(db: Db) {
  return {
    paymentsPending: await ensureAccount(db, { code: accountCode.paymentsPending(), type: AccountType.payments_pending }),
    platformRevenue: await ensureAccount(db, { code: accountCode.platformRevenue(), type: AccountType.platform_revenue }),
    payoutsClearing: await ensureAccount(db, { code: accountCode.payoutsClearing(), type: AccountType.payouts_clearing }),
    openingBalance: await ensureAccount(db, { code: accountCode.openingBalance(), type: AccountType.opening_balance }),
  };
}
