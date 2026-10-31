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
