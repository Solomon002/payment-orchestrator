# Deploying the public demo

```
Visitor ──> Vercel (dashboard, static site) ──HTTPS──> Railway (one container)
                                                       ├─ API            (public URL)
                                                       ├─ worker         (queues, poller, hourly reset)
                                                       ├─ mockpay-a      (internal only)
                                                       └─ mockpay-b      (internal only)
                                                       + Railway Postgres + Railway Redis
```

**Why two hosts:** the dashboard is a static site, which is what Vercel is best at. The backend needs programs that run all the time (the worker waits on queues; the mock gateways keep charges in memory and use timers), which serverless functions are not designed for. So the backend runs as one always-on container on Railway.

> **Important:** demo mode wipes **all** data in its database every hour. Give it its own Postgres, never one that holds anything else.

---

## Step 1: generate fresh secrets (on your laptop)

Don't reuse your local `.env`. From the repo root:

```powershell
node scripts/gen-secrets.mjs
```

It prints 5 lines (`ADMIN_API_KEY=...` etc.). Keep them somewhere private (a password manager). **`ADMIN_API_KEY` is your owner login for the live dashboard.** Never paste these into a chat, an issue or a commit.

## Step 2: backend on Railway

1. Go to [railway.com](https://railway.com), sign in with GitHub, and click **New Project → Deploy from GitHub repo**. Pick your repository.
   Railway finds the `Dockerfile` in the repo root and builds it. The first deploy will **fail**, because no settings exist yet. That's expected.
2. In the same project click **+ Create → Database → PostgreSQL**, then again **+ Create → Database → Redis**.
3. Open your app's service (the one built from GitHub) → **Variables** → **Raw Editor**, and paste the 5 secret lines from Step 1 plus:

   ```
   NODE_ENV=production
   PUBLIC_DEMO=true
   ENABLE_NAIVE_ENDPOINTS=false
   TRUST_PROXY=1
   LOG_LEVEL=info
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   DASHBOARD_ORIGIN=https://example.vercel.app
   ```

   - `${{Postgres.DATABASE_URL}}` is a Railway **reference**: it copies the value from the Postgres service. If your database services have different names, or the variable is named differently, open that service's **Variables** tab and use the exact name shown there.
   - `DASHBOARD_ORIGIN` is a placeholder for now. You will set the real Vercel URL in Step 4.
   - Don't set `PORT`. Railway sets it, and the start script uses it.
4. **Settings → Networking → Generate Domain.** Copy the URL, e.g. `https://payment-orchestrator-production.up.railway.app`.
5. **Settings → Deploy → Healthcheck Path:** `/health`
6. Redeploy (Deployments → the latest → Redeploy). In **Deploy Logs** you should see:

   ```
   [start] applying database migrations...
   [start] seeding demo merchant...
   [start] all processes started; API on port ...
   [mockpay-a] mock gateway listening on http://127.0.0.1:4101
   ```

7. Check in your browser:
   - `https://<your-railway-domain>/health` → `{"status":"ok", ...}`
   - `https://<your-railway-domain>/demo/info` → `{"enabled":true, ...}`

## Step 3: dashboard on Vercel

1. In Vercel: **Add New → Project** → import the same GitHub repository.
2. On the screen listing `api`, `dashboard` and `mock-gateway`, click **Import single project** next to **dashboard** only.
   (Root Directory becomes `apps/dashboard`. `apps/dashboard/vercel.json` sets the install and build commands, the output folder, and the single-page-app routing.)
3. Under **Environment Variables** add:

   ```
   VITE_API_URL=https://<your-railway-domain>
   ```

   No trailing slash needed. This is baked in at build time, so **change it, then redeploy**.
4. Click **Deploy** and copy the URL, e.g. `https://payment-orchestrator.vercel.app`.

## Step 4: connect them

1. Back in Railway → your app → **Variables**: set `DASHBOARD_ORIGIN` to the exact Vercel URL (`https://...vercel.app`, no trailing slash). The API only accepts browser requests from this origin (CORS).
2. Railway redeploys automatically.
3. Open your Vercel URL → **Try the live demo** → Simulator → **mockpay-a down** → **Send 10 payments**.

To sign in as the owner instead, open "Owner sign-in" and use `ADMIN_API_KEY` from Step 1.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Railway logs: `Invalid environment configuration` followed by a list | A variable is missing or malformed. The message names it; values are never printed. |
| Railway logs: Redis `ENOTFOUND` or timeouts | `REDIS_URL` doesn't point at the Redis service. Check the reference name in Step 2.3. |
| Dashboard: "Failed to fetch", or a CORS error in the browser console (F12) | `DASHBOARD_ORIGIN` on Railway doesn't exactly match the Vercel URL (check `https://`, no trailing slash), or `VITE_API_URL` on Vercel is wrong. Redeploy Vercel after changing it. |
| Dashboard loads, but "Try the live demo" is missing | `/demo/info` says `enabled:false`: `PUBLIC_DEMO=true` isn't set on Railway. |
| Vercel build fails at install | Check that the build log shows `pnpm@12.11.2`. The lockfile was written by pnpm 12; `vercel.json` pins it. |
| Refreshing a page like `/lab` gives 404 on Vercel | The `rewrites` in `apps/dashboard/vercel.json` didn't apply; check that Root Directory is `apps/dashboard`. |
| Data disappeared | Expected: demo mode resets everything every hour. |

## Costs and limits (check current pricing; it changes)

- **Vercel:** the Hobby plan is free for a static personal site.
- **Railway:** usually a trial credit, then a small monthly charge for an always-on service plus Postgres and Redis. Set a spending limit in Railway's billing settings.
- The demo's own quotas (`DEMO_*` variables, see `.env.example`) cap how much traffic visitors can create.

## What was verified before writing this guide

The backend image was built from this `Dockerfile` and run locally with production settings (`NODE_ENV=production`, `PUBLIC_DEMO=true`, `PORT` set by the "host", fresh secrets). Checked: migrations and seed run on start, all four processes start, `/health` is ok, a demo session can send payments, webhooks travel mock → API → worker inside the container and settle all payments, the ledger stays balanced, forbidden actions get 403, and CORS allows only `DASHBOARD_ORIGIN`. The dashboard was built with Vercel's exact install and build commands.

**Not verified:** Railway's and Vercel's own platforms (no account access from here). Railway variable reference names and the platforms' UIs may differ slightly from these steps.
