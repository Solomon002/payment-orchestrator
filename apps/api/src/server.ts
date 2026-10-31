import { createApp } from './app';
import { closeContext, createContext } from './context';

const ctx = createContext();
const app = createApp(ctx);

const server = app.listen(ctx.config.API_PORT, () => {
  ctx.log.info(`API listening on http://localhost:${ctx.config.API_PORT}`);
});

async function shutdown(signal: string) {
  ctx.log.info({ signal }, 'shutting down API');
  server.close();
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
