# Decision Records

Short ADR-style notes: the context, the decision, and what it costs.

---

## ADR-001: Money as integer kobo in `BIGINT`

**Context:** Floating-point numbers cannot represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`).
**Decision:** Store and calculate every amount as integer kobo (`BIGINT` in Postgres, `bigint` in TypeScript). Convert to `number` only at the JSON boundary, and only after checking `Number.isSafeInteger`.
**Consequences:** No rounding drift. Fees use explicit integer basis-point maths with half-up rounding. API clients send `amountKobo` integers; fractional kobo are rejected by validation.

## ADR-002: Append-only double-entry ledger, enforced in the database

**Context:** "balance = balance + x" loses history and can't be audited.
**Decision:** Journal entries with signed postings that sum to zero; balances derived by `SUM`. Postgres enforces zero-sum (deferred constraint trigger) and append-only (triggers on UPDATE/DELETE), in addition to the application check.
**Consequences:** Every kobo is explainable. Corrections are reversing entries. Balance reads are aggregates; at large scale you'd add periodic balance snapshots, still computed from postings.

## ADR-003: Row lock on the balance account as a per-merchant mutex

**Options:** (a) `SERIALIZABLE` isolation with retries, (b) `SELECT ... FOR UPDATE` on a row, (c) Redis distributed lock.
**Decision:** (b). Lock the merchant's `merchant_balance` account row inside a READ COMMITTED transaction, then re-read the balance.
**Why:** Simple to explain, no retry loop, and the lock lives in the same database as the data, so it can't disagree with it. Different merchants never block each other. (c) adds a second system that can fail independently.
**Consequences:** Withdrawals for one merchant are serialised. That's fine at this scale; a hot merchant would need sub-accounts or queueing.

## ADR-004: Idempotency stored in Postgres, response saved before it is sent

**Decision:** `idempotency_keys` with `UNIQUE (merchant_id, key)`, a SHA-256 fingerprint of method + path + canonical JSON body, the stored status and body. 2xx and 4xx responses are stored; 5xx releases the key so the client can retry. Stale in-progress claims (over 60 s) can be taken over.
**Consequences:** The same key + body replays exactly; the same key + a different body returns 422; concurrent duplicates get 409. As a second line of defence, withdrawals also carry a unique idempotency key column. Keys are never expired (known limitation).

## ADR-005: Webhooks: verify, store, dedupe, enqueue, 200; then verify again in the worker

**Decision:** The API does only fast, safe work: HMAC over the raw body, an `INSERT ... ON CONFLICT DO NOTHING` on `(gateway, event_id)`, enqueue, 200. The worker calls the gateway's verify API before settling. Duplicates get 200 (a non-2xx would make the gateway retry forever). Invalid signatures are stored as `rejected` for audit (body truncated to 10 KB, behind the rate limiter).
**Consequences:** Webhook payloads are never trusted for money. If Redis is down, events stay `received` and the poller re-enqueues them. The `webhook_events.duplicate_count` column replaces the spec's "duplicate" status, because the unique index means a duplicate never gets its own row.

## ADR-006: Gateway calls happen outside database transactions

**Decision:** Create the payment and its pending entry in one transaction, call the gateway with no transaction open, then record the result in a second transaction.
**Why:** Holding row locks while waiting up to `GATEWAY_TIMEOUT_MS` on the network lets one slow gateway stall everyone.
**Consequences:** A crash between the steps can leave a payment in `created`. The poller fails those after 5 minutes and releases the pending amount.

## ADR-007: Circuit breaker per (gateway, method), state in Redis

**Decision:** Rolling window (20 calls), trip below 80% success with at least 5 samples, 30 s cooldown, half-open probing (every 5th payment, plus fallback), recover after 3 consecutive probe successes. Routes are unranked until they have the minimum samples.
**Why:** NIBSS outages hit one rail across all gateways. The thresholds give hysteresis, so routing doesn't flip-flop.
**Consequences:** Health is shared by all API instances through Redis. Updates are not atomic (no Lua script), so a route can trip one call late. All thresholds are environment variables.

## ADR-008: A 402 response when every gateway fails, 503 when nothing is routable

**Decision:** If candidates exist but all fail, the payment is created, marked `failed`, and the API answers **402 `PAYMENT_FAILED`** with the payment and suggested alternative methods. Being 4xx, this response is stored for idempotent replay. If no route is available at all, the API answers **503 `METHOD_UNAVAILABLE`** before creating anything, so it is safe to retry.

## ADR-009: Our own mock gateway, Paystack as an optional test-mode adapter

**Decision:** Two instances of a controllable mock gateway (latency, error rate, declines, per-method outages, duplicate/delayed/dropped/forged webhooks, settlement tampering). Paystack is implemented only for initialize, verify and webhook HMAC, marked "VERIFY AGAINST OFFICIAL DOCS", refuses `sk_live_` keys, and is only registered when a test key is set.
**Consequences:** Every failure mode is reproducible in tests and demos. The Paystack adapter is unverified; its settlements come in through CSV upload.

## ADR-010: Reconciliation compares against ledger postings, never auto-fixes

**Decision:** Compare settlements with the `gateway_clearing` + `gateway_fees` postings of each payment's "succeeded" entry, not just the `payments` table. Four discrepancy types, plus "same reference settled on a second gateway" reported as `missing_in_ledger` (possible double charge after failover). Matching is by reference across window boundaries.
**Consequences:** Ledger bugs surface too. Humans resolve discrepancies with a note.

## ADR-011: Dashboard auth is a single admin key (demo simplification)

**Decision:** `X-Admin-Key`, compared in constant time, stored in `sessionStorage`. The browser never receives the mock control key; simulator calls go through the API. Simulator routes are not mounted in production.
**Consequences:** No per-user identity, roles or audit trail. A production system would use SSO/OIDC, roles, and httpOnly session cookies.

## ADR-012: Stable, well-known library majors over the newest releases

**Context:** The newest majors on the registry at build time (for example Prisma 7/8, TypeScript 7, Zod 4, BullMQ 6) changed APIs I could not verify against docs offline.
**Decision:** Pin well-established majors: Prisma 6, TypeScript 5.9, Zod 3.25, BullMQ 5, Vitest 3, Vite 7, Express 5.
**Consequences:** Upgrading later is a separate, testable task.

## ADR-013: Local infrastructure on non-default ports, images from the ECR Public mirror

**Decision:** Postgres on 5433 and Redis on 6380, bound to 127.0.0.1. `docker-compose.yml` pulls the official images through `public.ecr.aws/docker/library/...` because Docker Hub authentication failed on the development machine. CI uses Docker Hub directly.

## ADR-014: Scratch databases for tests and the demo

**Decision:** Tests use `payments_test` and Redis DB 1; `pnpm demo` creates and uses `payments_demo` and Redis DB 2.
**Why:** `pnpm test` and `pnpm demo` must never wipe development data, and must work while `pnpm dev` is running.

## ADR-015: Hybrid routing (breaker gate + Thompson ordering), chosen by simulation

**Context:** The Phase 3 circuit breaker used hand-picked thresholds and ignored banks. Nigerian failures are often bank-specific, and gateways differ in fees.
**Options:** keep the breaker; add bank-level breakers; replace it with Thompson sampling (a Bayesian multi-armed bandit); combine them.
**Decision:** Evaluate all of them in a reproducible simulator (`packages/routing/src/lab`, `pnpm lab`, 7 strategies x 7 scenarios x 8 seeds, 95% CIs) that calls the same pure routing functions as production. Ship `hybrid` as the default: bank-aware breakers decide which routes are alive; Thompson sampling (objective: P(success) x (amount - fee)) orders the healthy ones. `breaker`, `thompson` and `thompson_cost` remain selectable via `ROUTING_STRATEGY`.
**Why:** see docs/ROUTING-LAB.md. Bank attribution: 94.1% -> 97.8% success when one bank fails everywhere. Breaker memory: best in hard outages (p95 0.7 s vs 5 s for pure Thompson). Thompson ordering: fees 1.43% -> 1.32% of volume on normal days. The hybrid matched the best success rate everywhere.
**Consequences:** Slower to react to slow degradations (~9 min vs ~1.5) and to recover after full outages; slightly more breaker state changes; occasional exploratory attempts on a route that failed for one bank. All results are from illustrative parameters, not real gateway data.

## ADR-016: Only the gateway call can trigger failover

**Context:** The end-to-end demo found a double charge: a slow database transaction right after a gateway had accepted a charge threw inside the same `try` as the gateway call, so it was treated as a gateway failure and the payment was sent to a second gateway.
**Decision:** The `try` around a gateway attempt covers only `adapter.initialize`. Once a gateway accepts, the payment is committed to it: routing-health bookkeeping is best-effort (errors logged, never thrown), and the "created -> pending" transaction retries transient errors with a longer wait.
**Root cause of the slow transaction:** Prisma waits only 2 s by default to START an interactive transaction; on a cold connection pool (a fresh process talking to Postgres in Docker on Windows) opening connections sometimes took longer. The client now connects eagerly and uses `transactionOptions: { maxWait: 10s, timeout: 15s }`; the same error had also caused rare test flakes.
**Consequences:** A regression test simulates a bookkeeping failure after acceptance and asserts that exactly one gateway was tried and charged. If the database stays down, the request fails with a 500 and the payment stays `created` (the poller fails it after 5 minutes and the charge surfaces in reconciliation), which is better than charging twice.
