// Full in-process stack: API + worker + two mock gateways on random local ports.
// Used by the integration tests and by `pnpm demo`.
import { createMockGateway, type MockGateway } from '@po/mock-gateway';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { createApp } from '../app';
import { closeContext, createContext, type AppContext } from '../context';
import type { Env } from '../lib/env';
import { MockGatewayAdapter } from '../modules/gateways/mock.adapter';
import { GatewayRegistry } from '../modules/gateways/registry';
import { HealthAwareRouter } from '../modules/routing/health.router';
import { StaticRouter } from '../modules/routing/static.router';
import { startWorkers } from '../queues/workers';

export interface Harness {
  ctx: AppContext;
  url: string;
  mocks: Record<'mockpay-a' | 'mockpay-b', MockGateway>;
  close(): Promise<void>;
}

const listenOn = (server: Server, port = 0) =>
  new Promise<number>((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

export async function startHarness(opts: {
  config: Env;
  log: Logger;
  router?: 'static' | 'health';
  workers?: boolean;
  /** Random source for Thompson draws (tests pass a seeded one for reproducibility). */
  random?: () => number;
  mockLog?: (msg: string) => void;
}): Promise<Harness> {
  // Bind the API port first so the mocks know where to send webhooks.
  const apiServer = createServer();
  const apiPort = await listenOn(apiServer);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  const secrets = { 'mockpay-a': opts.config.MOCKPAY_A_SECRET, 'mockpay-b': opts.config.MOCKPAY_B_SECRET };
  const mocks = {} as Harness['mocks'];
  const mockServers: Server[] = [];
  const adapters: MockGatewayAdapter[] = [];

  for (const [name, feeBps] of [['mockpay-a', 150], ['mockpay-b', 140]] as const) {
    const server = createServer();
    const port = await listenOn(server);
    const mockUrl = `http://127.0.0.1:${port}`;
    const gw = createMockGateway({
      name,
      secret: secrets[name],
      controlKey: opts.config.MOCK_CONTROL_KEY,
      webhookUrl: `${apiUrl}/webhooks/${name}`,
      publicUrl: mockUrl,
      feeBps,
      feeCapKobo: 200_000,
      webhookRetries: 2,
      webhookRetryBaseMs: 200,
      log: opts.mockLog,
    });
    gw.control.latencyMs = 5;
    gw.control.completionDelayMs = 50;
    server.on('request', gw.app);
    mocks[name] = gw;
    mockServers.push(server);
    adapters.push(new MockGatewayAdapter(name, mockUrl, secrets[name], opts.config.GATEWAY_TIMEOUT_MS, feeBps));
  }

  const ctx = createContext({
    config: { ...opts.config, API_PUBLIC_URL: apiUrl },
    log: opts.log,
    gateways: new GatewayRegistry(adapters),
    router: (base) =>
      opts.router === 'health' ? new HealthAwareRouter(base.gateways, base.redis, base.config, opts.random) : new StaticRouter(base.gateways),
  });
  apiServer.on('request', createApp(ctx));
  const workers = opts.workers === false ? undefined : startWorkers(ctx);

  return {
    ctx,
    url: apiUrl,
    mocks,
    async close() {
      for (const gw of Object.values(mocks)) gw.close();
      await workers?.close();
      await new Promise((r) => apiServer.close(r));
      await Promise.all(mockServers.map((s) => new Promise((r) => s.close(r))));
      await closeContext(ctx);
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
