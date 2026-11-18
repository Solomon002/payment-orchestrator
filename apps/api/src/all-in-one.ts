// ALL-IN-ONE mode for small hosts (e.g. Render's free 512 MB instance):
// the API, the worker and both mock gateways run in ONE Node process instead
// of four, which cuts memory roughly to a third. Started by scripts/start-prod.mjs.
// Locally, `pnpm dev` still runs them as separate processes.
import { createMockGateway } from '@po/mock-gateway';
import type { Server } from 'node:http';
import { createApp } from './app';
import { closeContext, createContext } from './context';
import { scheduleRecurringJobs, startWorkers } from './queues/workers';

const ctx = createContext();
const { config, log } = ctx;

const listen = (app: { listen: (port: number, host: string, cb: () => void) => Server }, port: number, host: string) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, host, () => resolve(server));
  });

// 1. Mock gateways, reachable only inside this container (127.0.0.1).
const mocks = [
  { name: 'mockpay-a', url: config.MOCKPAY_A_URL, secret: config.MOCKPAY_A_SECRET, feeBps: 150 },
  { name: 'mockpay-b', url: config.MOCKPAY_B_URL, secret: config.MOCKPAY_B_SECRET, feeBps: 140 },
].map((m) =>
  createMockGateway({
    name: m.name,
    secret: m.secret,
    controlKey: config.MOCK_CONTROL_KEY,
    webhookUrl: `http://127.0.0.1:${config.API_PORT}/webhooks/${m.name}`,
    publicUrl: m.url,
    feeBps: m.feeBps,
    feeCapKobo: 200_000,
    log: (msg) => log.debug({ gateway: m.name }, msg),
  }),
);
const servers: Server[] = [];
for (const [i, gw] of mocks.entries()) {
  const port = Number(new URL([config.MOCKPAY_A_URL, config.MOCKPAY_B_URL][i]!).port);
  servers.push(await listen(gw.app, port, '127.0.0.1'));
}

// 2. The public API (all interfaces, on the port the host gives us).
servers.push(await listen(createApp(ctx), config.API_PORT, '0.0.0.0'));
log.info(`all-in-one: API on port ${config.API_PORT}, mock gateways on ${config.MOCKPAY_A_URL} and ${config.MOCKPAY_B_URL}`);

// 3. Workers and scheduled jobs (in demo mode this also resets the sandbox).
const workers = startWorkers(ctx);
await scheduleRecurringJobs(ctx);
log.info('all-in-one: worker started');

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  for (const gw of mocks) gw.close();
  for (const s of servers) s.close();
  await workers.close();
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
