# Code Walkthrough

A reading order for someone who knows React, TypeScript and Express but not ledgers, locking, idempotency or queues. Each new term is defined the first time it appears. Read the files in this order; each one builds on the previous ones.

---

## 0. Shared vocabulary

**`packages/shared/src/index.ts`** defines the words every app uses: payment methods (`card`, `bank_transfer`), statuses, and the Zod schemas for request bodies and mock-gateway settings. The API, mock gateway and dashboard all import from here, so they cannot disagree about what a payment looks like.

- **Kobo:** 1/100 of a naira. All money is an integer number of kobo, never a decimal (see DECISIONS ADR-001).
- **Zod schema:** a runtime description of valid data. `createPaymentSchema.parse(body)` either returns typed, clean data or throws a validation error.

## 1. Startup and plumbing (`apps/api/src`)

| File | What it does and why |
|---|---|
| `lib/env.ts` | Reads `.env` and validates it with Zod. The app refuses to start with a missing secret, a placeholder, a live Paystack key, or the unsafe demo endpoint enabled in production. |
| `lib/logger.ts` | **pino** structured (JSON) logging. **Redaction** replaces API keys and signatures with `[REDACTED]` before a line is written. |
| `lib/crypto.ts` | Hashing, HMAC, and `safeEqual`, a **constant-time comparison**: it takes the same time whether the first or last character differs, so an attacker can't guess a secret by measuring response times. |
| `lib/money.ts` | BigInt helpers, fee maths in **basis points** (1 bp = 0.01%), and the JSON converter (JSON has no BigInt type). |
| `context.ts` | Builds the **AppContext**: the database client, Redis, gateways, router and queues, created once and passed to whoever needs them. Tests and the demo build their own. |
| `app.ts` | The Express app: security headers (helmet), CORS, rate limits, then routes. Note that webhooks are mounted **before** the JSON body parser (section 4 explains why). |
| `middleware/errorHandler.ts` | Every error becomes `{ error: { code, message, requestId } }`. Internal details go to the log, not the client. |
| `middleware/auth.ts` | Merchant auth (Bearer API key, looked up by its SHA-256 hash) and admin auth (`X-Admin-Key`). |

## 2. The ledger (`modules/ledger`)

- **Double-entry:** every movement of money is recorded twice, once as money leaving one account and once as it arriving in another, so the totals always balance.
- **Journal entry:** one financial event (for example "payment X succeeded").
- **Posting:** one line of an entry: an account and a signed amount (debit = positive, credit = negative). An entry's postings always sum to zero.
- **Normal side:** whether an account's balance grows with debits (assets like `gateway_clearing`) or credits (liabilities like `merchant_balance`, money we owe the merchant).

Read `accounts.ts` (the account types and how they are created without races), then `ledger.service.ts` (`postJournalEntry`, `assertBalanced`, balances as `SUM`). Then read `prisma/migrations/*_ledger_integrity/migration.sql`: the same rules enforced by Postgres **triggers** (functions the database runs automatically on insert/update/delete). A **deferred** trigger runs at COMMIT, after all postings of an entry exist.

## 3. Concurrency: withdrawals and idempotency

- **Race condition:** the result depends on the timing of two simultaneous requests.
- **Transaction:** a group of statements that commit together or not at all.
- **Row lock (`SELECT ... FOR UPDATE`):** "I'm about to change things that depend on this row; anyone else who wants to lock it must wait until I commit."

Read `modules/withdrawals/withdrawal.service.ts`: `withdrawNaive` (check-then-act, broken on purpose) next to `withdrawSafe` (lock, re-read, check, write). Then run `pnpm demo:concurrency` and read `scripts/concurrency-demo.ts`.

- **Idempotency:** doing the same request twice has the same effect as doing it once. Read `modules/idempotency/idempotency.service.ts` (claiming a key with `INSERT ... ON CONFLICT DO NOTHING`), then `middleware/idempotency.ts` (it wraps `res.json` so the response is saved before it is sent).

## 4. Payments, gateways and webhooks

| Order | File | Key idea |
|---|---|---|
| 1 | `modules/payments/payment.state.ts` | The **state machine**: the only legal status changes. `transition()` is a **compare-and-set**: it updates only if the row is still in the expected state. |
| 2 | `modules/gateways/gateway.types.ts` | The **adapter interface** every gateway implements, and how errors are classified (unavailable / timeout / rejected). |
| 3 | `modules/gateways/mock.adapter.ts`, `paystack.adapter.ts` | Two implementations of the same interface. |
| 4 | `modules/payments/payment.service.ts` | `createPayment` (pending entry, then gateways tried in order outside any transaction) and `settlePayment` (lock the payment, transition, post the final entry; safe to call many times). |
| 5 | `modules/webhooks/webhook.routes.ts` + `webhook.service.ts` | **Webhook:** the gateway calling us. We need the **raw body** because the **HMAC signature** (a keyed hash proving the sender knows the secret) is computed over the exact bytes; re-serialised JSON could differ. Then store, **dedupe** on `(gateway, event_id)`, enqueue, answer 200. |
| 6 | `queues/queues.ts` | **BullMQ** queues in Redis. A **job** is a to-do item; **exponential backoff** waits 1 s, 2 s, 4 s... between retries; a **dead-letter queue** holds jobs that failed every retry. |
| 7 | `modules/webhooks/webhook.processor.ts` | The worker's job: **verify with the gateway** before trusting the webhook, then `settlePayment`. |
| 8 | `queues/poller.ts` | The **polling fallback** for webhooks that never arrive, plus expiry and recovery of stuck payments. |
| 9 | `queues/workers.ts`, `worker.ts` | Wires the processors to the queues and schedules repeating jobs. |

## 5. Routing and failover (`modules/routing`)

- **Circuit breaker:** like a fuse. After too many failures it "trips" and stops sending traffic, waits (**cooldown**), then lets a few test requests through (**half-open / probing**) before fully trusting the route again.

Read `router.types.ts` (the interface), `static.router.ts` (the simplest version), then `health.tracker.ts` (the breaker per gateway + method, stored in Redis) and `health.router.ts` (how candidates are ordered). `routing.routes.ts` exposes the state to the dashboard.

## 6. Reconciliation (`modules/reconciliation`)

- **Settlement:** the gateway's report of money it has actually paid us, usually net of its fee.
- **Reconciliation:** comparing our ledger with that report, line by line.

Read `settlement.importer.ts` (API import and CSV parsing), then `reconciliation.service.ts` (the four discrepancy types and the double-charge check), then `reconciliation.routes.ts`.

## 7. Admin API, simulator and dashboard

- `modules/admin/admin.routes.ts`: read-only data for the dashboard.
- `modules/admin/simulator.routes.ts`: forwards control changes to the mock gateways, so the control key never reaches the browser.
- `apps/mock-gateway/src/gateway.ts`: the fake gateway and every failure mode it can simulate.
- `apps/dashboard/src`: `lib/api.ts` (fetch wrapper), `App.tsx` (login and navigation), and one file per page in `pages/`. TanStack Query's `refetchInterval` makes the pages live.

## 8. Tests and demos

- `apps/api/src/dev/stack.ts`: starts the API, worker and both mock gateways in one process on random ports.
- `apps/api/test/*.test.ts`: each test file reads as a list of claims ("duplicate webhooks are stored once and processed once"). Good for interview prep.
- `apps/api/src/scripts/demo.ts`: the guided tour behind `pnpm demo`.
