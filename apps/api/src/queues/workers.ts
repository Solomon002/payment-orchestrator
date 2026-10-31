import { Worker } from 'bullmq';
import type { AppContext } from '../context';
import { markWebhookDeadLettered, processWebhookEvent } from '../modules/webhooks/webhook.processor';
import { pollPendingPayments } from './poller';
import { bullConnection, QUEUE_NAMES, QUEUE_PREFIX } from './queues';

export type MaintenanceHandler = (ctx: AppContext, jobName: string) => Promise<unknown>;

/**
 * Starts the BullMQ workers. Returned so callers (worker.ts, tests, the demo)
 * can stop them cleanly.
 */
export function startWorkers(ctx: AppContext, extraMaintenance: Record<string, MaintenanceHandler> = {}) {
  const connection = bullConnection(ctx.config.REDIS_URL);

  const webhookWorker = new Worker<{ webhookEventId: string }>(
    QUEUE_NAMES.webhooks,
    async (job) => processWebhookEvent(ctx, job.data.webhookEventId),
    { connection, prefix: QUEUE_PREFIX, concurrency: 5 },
  );

  webhookWorker.on('failed', (job, err) => {
    if (!job) return;
    const attemptsAllowed = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= attemptsAllowed || err.name === 'UnrecoverableError';
    ctx.log.warn({ jobId: job.id, attempt: job.attemptsMade, final, err: err.message }, 'webhook job failed');
    if (final) {
      void markWebhookDeadLettered(ctx, job.data.webhookEventId, err.message).catch((e: unknown) =>
        ctx.log.error({ err: e }, 'dead-letter bookkeeping failed'),
      );
    }
  });

  const maintenanceWorker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      if (job.name === 'poll-pending') return pollPendingPayments(ctx);
      const handler = extraMaintenance[job.name];
      if (handler) return handler(ctx, job.name);
      throw new Error(`Unknown maintenance job ${job.name}`);
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
  );
  maintenanceWorker.on('completed', (job, result) => ctx.log.debug({ job: job.name, result }, 'maintenance job done'));
  maintenanceWorker.on('failed', (job, err) => ctx.log.error({ job: job?.name, err: err.message }, 'maintenance job failed'));

  return {
    webhookWorker,
    maintenanceWorker,
    async close() {
      await Promise.all([webhookWorker.close(), maintenanceWorker.close()]);
      connection.disconnect();
    },
  };
}

/** Repeating jobs. upsertJobScheduler is idempotent: restarting the worker doesn't duplicate schedules. */
export async function scheduleRecurringJobs(ctx: AppContext) {
  await ctx.queues.maintenance.upsertJobScheduler(
    'poll-pending',
    { every: ctx.config.POLL_INTERVAL_MS },
    { name: 'poll-pending', opts: { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } } },
  );
}
