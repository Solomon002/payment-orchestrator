# Learning Log

A running record of what I built, the key idea behind it (with an analogy), the bug it prevents, and one interview question I should be able to answer.

---

## Setup, Step 1: Checked my tools

**What we built:** Nothing yet. We checked Node, npm, pnpm, Git, Docker and Docker Compose.

**Key idea:** A tool can be installed but unusable. `docker --version` only checks the command-line tool; `docker info` checks that the Docker engine is actually running. Postgres and Redis need the engine.

**Interview line:** "I run Postgres and Redis in Docker so every developer and CI run gets identical versions without installing databases on their machine."

---

## Setup, Step 2: Created the repo

**What we built:** The `payment-orchestrator` folder, a Git repo on `main`, a `.gitignore`, a `.gitattributes` and this log.

**Key idea:** `.gitignore` is a security control. `.env` holds secrets (gateway keys, database passwords). Once a secret is committed it lives in Git history forever, so we ignore `.env` from the first commit. We commit a `.env.example` with placeholder values instead, so others know which variables exist.

**Interview line:** "I normalise line endings to LF with `.gitattributes` because our code runs in Linux containers, and mixed CRLF/LF causes noisy diffs and broken shell scripts."

**Debugging lesson:** A PowerShell here-string (`@'` ... `'@`) needs `@'` at the end of its own line and `'@` at the start of its own line. If pasting removes the line breaks, it fails with "No characters are allowed after a here-string header".

---

## Phase 0: Foundation

**What we built:** A pnpm monorepo (`apps/api`, `apps/mock-gateway`, `apps/dashboard`, `packages/shared`), Postgres 16 and Redis 7 in Docker Compose with health checks, Zod-validated environment variables, structured logging with pino (secrets redacted), security headers (helmet), a strict CORS policy, body-size limits, a consistent error format, a `/health` endpoint, the Prisma schema with the first migrations, and an idempotent seed script.

**Key idea (analogy):** Env validation is a pilot's pre-flight checklist. The plane refuses to take off with a missing instrument instead of discovering it mid-flight. Our API refuses to start with a missing secret, a live Paystack key, or the unsafe demo endpoints switched on in production.

**Also:** the ledger rules (every journal entry sums to zero, history is append-only) live in the *database* as triggers, not just in TypeScript. The database is the last line of defence: even a buggy script cannot write an unbalanced entry.

**Bug it prevents:** Starting with a placeholder or live secret; leaking API keys into logs; a typo'd `UPDATE postings ...` silently rewriting financial history.

**Interview question:** *"Why enforce ledger rules in the database when the application already checks them?"* Because there are many ways to write to a database (migrations, scripts, future services, a tired engineer in psql). Constraints in the database hold for all of them; application checks only hold for code that remembers to call them.

---

## Phase 1: Ledger, idempotency and the double-spend

**What we built:** The double-entry ledger service (`postJournalEntry`, derived balances), hashed merchant API keys, rate limits, the `Idempotency-Key` middleware, and withdrawals in two versions: `/v1/withdrawals/naive` (deliberately unsafe) and `/v1/withdrawals` (safe). Plus `pnpm demo:concurrency` and tests.

**Key idea 1, double-entry (analogy):** Moving water between buckets. Every journal entry pours water out of one bucket and into another, so the total never changes: postings always sum to zero. We never overwrite a bucket's level; the level is the sum of every pour ever made, so history explains every kobo.

**Key idea 2, the race (analogy):** Two people check a shared bank card balance on their phones at the same moment, both see NGN 10,000, and both buy something for NGN 8,000. Each check was correct when it ran; the problem is that "check" and "spend" were not one indivisible step.

**The fix:** `SELECT ... FOR UPDATE` on the merchant's balance account row inside a transaction. That row works as a lock: the second transaction waits at that line until the first commits, then re-reads the (now lower) balance. Different merchants lock different rows, so they don't slow each other down.

**Before/after (real output of `pnpm demo:concurrency`, 50 simultaneous NGN 1,000 withdrawals, balance NGN 10,000):**

| Version | Succeeded | Final balance |
|---|---|---|
| Naive (no lock) | 31 | **-NGN 21,000** (double-spend) |
| Safe (FOR UPDATE) | 10 | NGN 0 |
| Safe, all 50 reuse one Idempotency-Key | 1 withdrawal | NGN 9,000 |

Note that the naive run did not break the ledger's zero-sum rule: every entry balanced. It broke a *business* rule (no overdraft). Integrity constraints and concurrency control solve different problems.

**Key idea 3, idempotency (analogy):** A coat-check ticket. Same ticket, same coat: you get the stored result back. Same ticket, different coat: refused (422). The unique index on `(merchant_id, key)` is what makes two simultaneous identical requests safe: only one INSERT can win.

**Bug it prevents:** Overdrafts under concurrent requests; double charges when a client retries after a timeout or a user double-clicks.

**Interview question:** *"Why does the safe version re-read the balance after acquiring the lock, and why does that work under READ COMMITTED?"* Because the balance read before the lock may be stale. In READ COMMITTED, each statement takes a fresh snapshot, so the SELECT after the lock sees everything the previous lock holder committed.

---

## Phase 2: Payments, webhooks, queues and the polling fallback

**What we built:** `POST /v1/payments` with a strict state machine, the gateway adapter interface (mock + Paystack test mode), the webhook endpoint (raw body, HMAC check, store, dedupe, enqueue, 200), a BullMQ worker with exponential backoff and a dead-letter queue, and a poller that recovers payments whose webhook never came.

**Key idea 1, state machine (analogy):** A parcel's tracking status. "Delivered" never goes back to "out for delivery". `created -> pending -> succeeded | failed | expired`; terminal states are final. The update is a compare-and-set (`UPDATE ... WHERE status = 'pending'`), so two racing updates can't both win.

**Key idea 2, webhooks:** The gateway calls *us*. We (1) check the HMAC-SHA512 signature over the raw bytes, because anyone can POST to our URL; (2) store the raw event; (3) dedupe with `UNIQUE(gateway, event_id)`; (4) put a job on the queue and answer 200 immediately. The worker does the slow part and **verifies with the gateway's API before moving money** ("trust, but verify").

**Key idea 3, queues (analogy):** A restaurant. The waiter (API) takes the order and returns to the door; the kitchen (worker) cooks. If a dish fails, the kitchen retries with growing pauses (1s, 2s, 4s...: exponential backoff). Orders that fail every retry go to a "problem orders" shelf (the dead-letter queue) for a human.

**Key idea 4, polling fallback:** Webhooks are not guaranteed. If one never arrives, the poller asks the gateway "what happened to payment X?", like checking the tracking page when the delivery SMS never came.

**Bugs it prevents:** Crediting a merchant twice for a resent webhook; trusting a forged webhook; a payment stuck "pending" forever because a webhook was lost; a late "failed" event undoing a success.

**Proved by tests:** duplicate webhook processed once; bad signature rejected (stored as `rejected`, no money moves); dropped webhook recovered by the poller; a late webhook after the poller already settled changes nothing; illegal transitions throw.

**Interview question:** *"Why return 200 to a duplicate webhook instead of 409?"* Because the gateway did nothing wrong. A non-2xx tells it to retry, which creates even more duplicates. We acknowledge it and do nothing.

---

## Phase 3: Health-aware routing and failover

**What we built:** A health tracker in Redis for every **(gateway, payment method)** pair, a router that skips degraded routes, failover inside a single request, and `GET /admin/routing/health`.

**Key idea (analogy):** A house fuse box with one fuse per room, not one for the whole house. Each (gateway, method) pair is a **circuit breaker**:
- **healthy**: normal traffic.
- **degraded** ("tripped"): success rate fell below 80% over at least 5 calls. No traffic for a cooldown period.
- **probing** ("half-open"): after the cooldown, a small share of traffic tests whether it has recovered.
- Two or three probes in a row succeed: back to healthy. One probe fails: degraded again.

**Why per method:** A NIBSS outage breaks bank transfers on *every* gateway at once while cards keep working. A per-gateway breaker would either kill cards needlessly or keep sending transfers into a black hole. When a method is down on every gateway, the API answers `503 METHOD_UNAVAILABLE` and suggests the method that still works (for example "try card").

**Anti flip-flop rules:** a minimum sample size (one blip can't trip it), a cooldown (no instant retry), consecutive successful probes to recover, and a fresh window after recovery. Also, a route isn't *ranked* below others until it has enough samples. Otherwise one early failure would push it to the back forever, and it would never get the traffic it needs to prove itself again (I found this while writing the tests).

**Bug it prevents:** Every customer waiting for a dead gateway to time out; a whole gateway being blacklisted because only one of its rails is down; routing that oscillates every few seconds.

**Interview question:** *"How do you stop a failover system from flip-flopping?"* Hysteresis: require enough evidence to trip (minimum samples plus a threshold), wait a cooldown before retrying, require several consecutive successes to recover, and only send probe traffic while half-open.

---

## Phase 4: Reconciliation

**What we built:** A settlement importer (pulls each mock gateway's settlement report; CSV upload for gateways without an API, like Paystack in this project), a reconciliation engine, `POST /admin/reconciliation/run` for on-demand runs, and a nightly BullMQ cron job (02:00 Africa/Lagos, 48-hour look-back).

**Key idea (analogy):** Checking your bank statement against your own notes at the end of the month. Every line should appear in both lists with the same amount. Anything that doesn't is written down as a **discrepancy** for a human to investigate, never "auto-fixed".

| Type | Meaning | Typical real cause |
|---|---|---|
| `missing_in_ledger` | Gateway settled money we have no payment for | Payment created outside our system, or a bug that lost a record |
| `missing_in_gateway` | We think it succeeded; the gateway's report doesn't have it | Settlement delayed, or we credited a merchant for money we never received |
| `amount_mismatch` | Both sides have it, amounts or fees differ | Fee changes, partial captures, currency/rounding bugs |
| `status_mismatch` | Gateway settled it, we still say pending/failed | Lost webhook not yet caught by the poller |

**Detail that matters:** we compare against the **ledger postings** (gateway_clearing + gateway_fees of the "succeeded" entry), not just the payments table, so a ledger bug would be caught too. Lookups match by reference regardless of the time window, so a payment at 23:59 settled at 00:01 isn't flagged on either side.

**Bug it prevents:** Silent money leaks that nobody notices until the year-end audit.

**Interview question:** *"If you have idempotency, webhooks and polling, why do you still need reconciliation?"* Because each of those can still be wrong in ways it can't detect itself: a gateway-side bug, a manual refund in the gateway's dashboard, a fee change, a webhook for a payment we never created. Reconciliation is the independent check that the two sets of books agree.

---

## Phase 5: Dashboard and simulator

**What we built:** A React + Vite + Tailwind + TanStack Query admin dashboard (Overview, Payments with a ledger view per payment, Gateway Health, Webhooks, Reconciliation, Simulator) and the admin/simulator API behind it.

**Key idea (analogy):** A flight simulator. Pilots practise engine failures on purpose so they recognise them instantly. The Simulator page breaks the mock gateways on purpose ("mockpay-a down", "NIBSS outage", "drop webhooks") so you can watch the circuit breakers, failover, poller and reconciliation react live.

**Security detail:** The browser only holds the admin key (in session storage). The key that controls the mock gateways stays on the server, and the API forwards simulator commands. Simulator routes aren't mounted in production.

**Interview question:** *"Why does the dashboard show 'Ledger check: Balanced'?"* It's the sum of every posting ever written. In a double-entry ledger that must be exactly zero; anything else means a bug wrote money that came from nowhere.

---

## Phase 6: Hardening, CI, docs and the demo

**What we built:** `pnpm demo` (7 scripted scenarios on a scratch database), a GitHub Actions workflow running lint, typecheck, tests, the dashboard build and both demos against real Postgres and Redis, and the README, ARCHITECTURE, DECISIONS and WALKTHROUGH docs.

**A bug found while writing the limitations list:** Reconciliation matched settlements to payments by reference only. If gateway A times out during failover but *did* charge the customer, and gateway B also succeeds, both settlements would "match", hiding a double charge. Now a settlement from a gateway that didn't complete the payment is flagged as `missing_in_ledger` ("possible double charge"), with a test.

**Key idea:** Writing down the known limitations honestly is a design review in disguise.

**Interview question:** *"What happens if a gateway times out but actually charged the customer?"* We fail over and may charge twice. Reconciliation catches it, because the same reference settles on two gateways, and a human refunds. A stronger design would verify with the first gateway before failing over, or use the same reference on both gateways so the gateway dedupes it.
