import { Worker } from 'bullmq';
import type { AppContext } from '../context';
import { markWebhookDeadLettered, processWebhookEvent } from '../modules/webhooks/webhook.processor';
import { runNightlyReconciliation } from '../modules/reconciliation/reconciliation.service';
import { initDemoSchedule, resetDemo } from '../modules/demo/demo.service';
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
      if (job.name === 'demo-reset') return resetDemo(ctx);
      if (job.name === 'reconcile-nightly') {
        const run = await runNightlyReconciliation(ctx);
        return { runId: run.id, totals: run.totals };
      }
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
  await ctx.queues.maintenance.upsertJobScheduler(
    'reconcile-nightly',
    { pattern: ctx.config.RECONCILIATION_CRON, tz: ctx.config.RECONCILIATION_TZ },
    { name: 'reconcile-nightly', opts: { removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } } },
  );
  // Public demo: wipe and reseed the shared sandbox on a fixed interval.
  if (ctx.config.PUBLIC_DEMO) {
    // Start every boot from a clean sandbox. On free hosts the server sleeps when
    // idle; on wake the mock gateways' in-memory charges are gone, so old data in
    // the database would no longer match them (reconciliation would flag it).
    try {
      await resetDemo(ctx);
    } catch (err) {
      ctx.log.error({ err }, 'demo reset on startup failed; will retry on the next scheduled reset');
      await initDemoSchedule(ctx);
    }
    await ctx.queues.maintenance.upsertJobScheduler(
      'demo-reset',
      { every: ctx.config.DEMO_RESET_INTERVAL_MS },
      { name: 'demo-reset', opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 10 } } },
    );
  } else {
    await ctx.queues.maintenance.removeJobScheduler('demo-reset');
  }
}
