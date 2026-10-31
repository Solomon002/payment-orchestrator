// Worker process entry point: `pnpm --filter @po/api dev:worker`.
// Runs separately from the API so slow background work never delays HTTP requests.
import { closeContext, createContext } from './context';
import { scheduleRecurringJobs, startWorkers } from './queues/workers';

const ctx = createContext();
const workers = startWorkers(ctx);
await scheduleRecurringJobs(ctx);
ctx.log.info('worker started: webhooks + maintenance queues');

async function shutdown(signal: string) {
  ctx.log.info({ signal }, 'shutting down worker');
  await workers.close();
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
