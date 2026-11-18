// Production entry point for the backend container (Render, Railway, Docker).
// Runs, in order:
//   1. database migrations (prisma migrate deploy)
//   2. the idempotent seed (system accounts + demo merchant)
//   3. the API, worker and both mock gateways in ONE process (src/all-in-one.ts),
//      which keeps memory low enough for small free instances.
// If the app process exits, the container exits too, so the host restarts it.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'apps/api');
const bin = (name) => join(api, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const shell = process.platform === 'win32';

// The host tells us which port to listen on via PORT.
const port = process.env.PORT ?? process.env.API_PORT ?? '4000';
const env = {
  ...process.env,
  API_PORT: port,
  API_PUBLIC_URL: process.env.API_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  // The mock gateways live inside this container.
  MOCKPAY_A_URL: process.env.MOCKPAY_A_URL ?? 'http://127.0.0.1:4101',
  MOCKPAY_B_URL: process.env.MOCKPAY_B_URL ?? 'http://127.0.0.1:4102',
};

function runOnce(label, cmd, args) {
  console.log(`[start] ${label}...`);
  const r = spawnSync(cmd, args, { cwd: api, env, stdio: 'inherit', shell });
  if (r.status !== 0) {
    console.error(`[start] ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

runOnce('applying database migrations', bin('prisma'), ['migrate', 'deploy']);
runOnce('seeding demo merchant', bin('tsx'), ['src/scripts/seed.ts']);

console.log(`[start] starting API + worker + mock gateways (one process) on port ${port}`);
const app = spawn(bin('tsx'), ['src/all-in-one.ts'], { cwd: api, env, stdio: ['ignore', 'inherit', 'inherit'], shell });
app.on('exit', (code, signal) => {
  console.error(`[start] app exited (code ${code}, signal ${signal})`);
  process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.kill(sig));
