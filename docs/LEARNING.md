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
