// Production entry point for the backend container (Railway, Render, Docker).
// Runs, in order:
//   1. database migrations (prisma migrate deploy)
//   2. the idempotent seed (system accounts + demo merchant)
//   3. API + worker + both mock gateways, as four processes in one container
// If any process dies, all are stopped and the container exits non-zero, so
// the host restarts it cleanly instead of leaving a half-working app.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'apps/api');
const mock = join(root, 'apps/mock-gateway');
const bin = (dir, name) => join(dir, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);

// The host tells us which port to listen on via PORT.
const port = process.env.PORT ?? process.env.API_PORT ?? '4000';
const env = {
  ...process.env,
  API_PORT: port,
  // Mock gateways run inside this container and send webhooks to the API here.
  API_PUBLIC_URL: process.env.API_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  MOCKPAY_A_URL: process.env.MOCKPAY_A_URL ?? 'http://127.0.0.1:4101',
  MOCKPAY_B_URL: process.env.MOCKPAY_B_URL ?? 'http://127.0.0.1:4102',
};

function runOnce(label, cmd, args, cwd) {
  console.log(`[start] ${label}...`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[start] ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

runOnce('applying database migrations', bin(api, 'prisma'), ['migrate', 'deploy'], api);
runOnce('seeding demo merchant', bin(api, 'tsx'), ['src/scripts/seed.ts'], api);

const procs = [
  ['api', bin(api, 'tsx'), ['src/server.ts'], api],
  ['worker', bin(api, 'tsx'), ['src/worker.ts'], api],
  ['mock-a', bin(mock, 'tsx'), ['src/server.ts', 'mockpay-a'], mock],
  ['mock-b', bin(mock, 'tsx'), ['src/server.ts', 'mockpay-b'], mock],
].map(([label, cmd, args, cwd]) => {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  child.on('exit', (code, signal) => {
    console.error(`[start] ${label} exited (code ${code}, signal ${signal}); stopping everything`);
    shutdown(code || 1);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
console.log(`[start] all processes started; API on port ${port}`);
