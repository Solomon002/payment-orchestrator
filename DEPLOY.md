# Deploying the public demo (free tier)

```
Visitor ──> Vercel (dashboard, static site) ──HTTPS──> Render free web service (one container, ONE process)
                                                         ├─ API        (public URL)
                                                         ├─ worker     (queues, poller, demo reset)
                                                         └─ mockpay-a + mockpay-b (internal only)
                                                       Neon (Postgres, free)   Render Key Value (Redis, free)
```

| Piece | Host | Cost |
|---|---|---|
| Dashboard | Vercel (Hobby) | free |
| Backend container | Render web service (Free) | free |
| Postgres | Neon (Free) | free |
| Redis | Render Key Value (Free) | free |

Free-tier limits change, so check each provider's pricing page when you sign up. At the time of writing:
- **Render's free web service sleeps after about 15 minutes without visitors.** The next visit wakes it in roughly 30-60 seconds; the login page shows a "waking up the server" note meanwhile.
- **Every wake-up starts a clean sandbox** (demo mode resets on startup), because the mock gateways keep their charges in memory, which sleeping wipes.
- **The container uses about 100 MB** (measured with a 512 MB cap: ~96 MB idle, ~104 MB after 50 payments), because the API, worker and mock gateways run in one process (`apps/api/src/all-in-one.ts`).

> **Important:** demo mode wipes **all** data in its database on every start and every hour. Use a Neon database created only for this demo.

**Do the steps in this order.** Each one gives you a value the next needs.

---

## Step 1: generate secrets (your laptop)

From the repo root:

```powershell
node scripts/gen-secrets.mjs
```

Save the 5 printed lines somewhere private, such as a password manager. **`ADMIN_API_KEY` is your owner login for the live dashboard.** Never paste these into a chat, an issue or a commit.

## Step 2: Postgres on Neon

1. Go to [neon.tech](https://neon.tech) and sign up (GitHub sign-in is fine).
2. Create a project, e.g. `payment-orchestrator-demo`. **Pick a region close to where you'll put Render** (e.g. AWS Europe (Frankfurt) or US East).
3. On the project dashboard click **Connect**.
   - **Turn "Connection pooling" OFF.** We need the *direct* connection: database migrations and interactive transactions don't work well through the pooler.
   - Copy the connection string. It looks like `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`
4. Save it as your **`DATABASE_URL`**.

## Step 3: Redis on Render (Key Value)

1. Go to [render.com](https://render.com) and sign up with GitHub.
2. **New → Key Value.**
   - Name: `po-redis`
   - **Region: the same region you'll use for the web service** (e.g. Frankfurt, near your Neon region)
   - Instance type: **Free**
   - **Maxmemory policy: `noeviction`**, if the option is shown. BullMQ needs this so queued jobs are never silently dropped.
3. Create it. On its page, copy the **Internal Key Value URL** (it looks like `redis://red-xxxxxxxxxxxx:6379`).
4. Save it as your **`REDIS_URL`**.

## Step 4: backend on Render (Web Service)

1. **New → Web Service** → connect your GitHub repository.
2. Settings:
   - **Language/Runtime: Docker** (Render detects the `Dockerfile` in the repo root)
   - Branch: `main`
   - **Region: the same as the Key Value** (the internal Redis URL only works inside one region)
   - Root Directory: leave empty
   - **Instance type: Free**
3. **Environment variables.** Add the 5 lines from Step 1, plus:

   ```
   NODE_ENV=production
   PUBLIC_DEMO=true
   ENABLE_NAIVE_ENDPOINTS=false
   TRUST_PROXY=1
   LOG_LEVEL=info
   DATABASE_URL=<from Step 2>
   REDIS_URL=<from Step 3>
   DASHBOARD_ORIGIN=https://example.vercel.app
   ```

   - `DASHBOARD_ORIGIN` is a placeholder for now; you'll set the real Vercel URL in Step 6.
   - Don't set `PORT`. Render sets it, and the start script uses it.
4. **Advanced → Health Check Path:** `/health`
5. Click **Create Web Service.** The first build takes several minutes. In the logs you should see:

   ```
   [start] applying database migrations...
   [start] seeding demo merchant...
   [start] starting API + worker + mock gateways (one process) on port 10000
   ... "all-in-one: API on port 10000 ..."
   ... "public demo reset complete"
   ```

6. Copy your service URL (e.g. `https://payment-orchestrator-xxxx.onrender.com`) and check in your browser:
   - `https://<your-render-url>/health` → `{"status":"ok", ...}`
   - `https://<your-render-url>/demo/info` → `{"enabled":true, ...}`

## Step 5: dashboard on Vercel

1. In Vercel: **Add New → Project** → import your GitHub repository.
2. On the screen listing `api`, `dashboard` and `mock-gateway`, click **Import single project** next to **dashboard** only (Root Directory becomes `apps/dashboard`).
3. **Environment Variables:**

   ```
   VITE_API_URL=https://<your-render-url>
   ```

   This is baked in at build time. If you change it later, **redeploy**.
4. Click **Deploy** and copy the URL (e.g. `https://payment-orchestrator.vercel.app`).

## Step 6: connect them

1. Render → your web service → **Environment**: set `DASHBOARD_ORIGIN` to the exact Vercel URL (`https://...vercel.app`, no trailing slash) and save. Render redeploys automatically.
2. Open the Vercel URL → **Try the live demo** → Simulator → **mockpay-a down** → **Send 10 payments.**

To sign in as the owner instead, open **Owner sign-in** and use `ADMIN_API_KEY` from Step 1.

From now on, **every `git push` redeploys both automatically.**

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Render logs: `Invalid environment configuration` + a list | A variable is missing or malformed. The message names it (values are never printed). |
| Render logs: `Can't reach database server` | `DATABASE_URL` is wrong, or is the *pooled* Neon string. Use the direct one (Step 2.3), ending in `?sslmode=require`. |
| Render logs: Redis `ENOTFOUND` / `ECONNREFUSED` | Use the **Internal** Key Value URL, and make sure the Key Value and the web service are in the **same region**. |
| Dashboard: "Failed to fetch" / CORS error in the browser console (F12) | `DASHBOARD_ORIGIN` on Render doesn't exactly match the Vercel URL (check `https://`, no trailing slash), or `VITE_API_URL` on Vercel is wrong (redeploy after fixing). |
| Login page shows "Waking up the server…" for a long time | Normal on the free tier for up to about a minute. If it never wakes, check the Render logs. |
| No "Try the live demo" button | `/demo/info` says `enabled:false`: set `PUBLIC_DEMO=true` on Render. |
| Vercel build fails at install | The log should show `pnpm@12.11.2` (pinned in `apps/dashboard/vercel.json`, matching the lockfile). |
| Refreshing `/lab` gives 404 on Vercel | Root Directory must be `apps/dashboard`, so `vercel.json`'s rewrites apply. |
| Data disappeared | Expected: demo mode resets on every wake-up and every hour. |

## What was verified before writing this guide

The image was built from this `Dockerfile` and run locally like Render's free tier: `PORT=10000`, a **512 MB memory cap**, production settings and fresh secrets. Checked:
- migrations, seed and the startup reset run;
- the single process serves the API and mock gateways;
- a demo visitor's 50 payments all settle through webhooks inside the container, including failover when a gateway is broken;
- the ledger balances and reconciliation matches all 50;
- memory is ~104 MB after load;
- after a restart (simulated sleep/wake) the sandbox is clean with no false discrepancies;
- the dashboard builds with Vercel's exact commands.

**Not verified:** the Render, Neon and Vercel platforms themselves (no account access from here). Their screens and setting names may differ slightly from these steps.

*Paid alternative:* the same Dockerfile also runs on Railway or any Docker host. Set the same variables; the host provides `PORT`.
