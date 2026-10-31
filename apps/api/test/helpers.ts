import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { createApp } from '../src/app';
import { closeContext, createContext, type AppContext } from '../src/context';
import { env } from '../src/lib/env';
import { createMerchant, topUpMerchant } from '../src/modules/merchants/merchant.service';

export const silentLog = pino({ level: 'silent' });

export function testContext(): AppContext {
  return createContext({ config: env(), log: silentLog });
}

/**
 * Empties every table. TRUNCATE skips row-level triggers, which is why the
 * append-only ledger triggers don't block it; it is only used on the test DB.
 */
export async function resetDatabase(ctx: AppContext) {
  if (!ctx.config.DATABASE_URL.includes('payments_test')) {
    throw new Error('Refusing to reset a database that is not the test database');
  }
  await ctx.prisma.$executeRawUnsafe(`
    TRUNCATE postings, journal_entries, withdrawals, payment_attempts, payments, accounts, merchants,
      idempotency_keys, webhook_events, gateway_settlements, discrepancies, reconciliation_runs
    RESTART IDENTITY CASCADE`);
  // Clear routing health only. Queue keys are left alone: wiping them while a
  // worker holds a job produces confusing "missing key" errors.
  const keys = await ctx.redis.keys('po:health:*');
  if (keys.length) await ctx.redis.del(...keys);
}

export async function merchantWithBalance(ctx: AppContext, balanceKobo: bigint) {
  const { merchant, apiKey } = await createMerchant(ctx.prisma, 'Test Merchant');
  if (balanceKobo > 0n) await topUpMerchant(ctx.prisma, merchant.id, balanceKobo, `test:topup:${merchant.id}`);
  return { merchant, apiKey, auth: { authorization: `Bearer ${apiKey}` } };
}

export function listen(ctx: AppContext): { server: Server; url: string } {
  const server = createApp(ctx).listen(0);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function teardown(ctx: AppContext, server?: Server) {
  server?.close();
  await closeContext(ctx);
}
