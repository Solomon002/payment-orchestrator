// BullMQ queues. A QUEUE is a to-do list stored in Redis: the web server writes
// a job ("process webhook event X") and returns immediately; a separate WORKER
// process picks jobs up, does the slow work, and retries on failure.
// Analogy: a restaurant. The waiter (API) takes the order and goes back to the
// door; the kitchen (worker) cooks. A slow kitchen never blocks the front door.
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_PREFIX = 'po';
export const QUEUE_NAMES = {
  webhooks: 'webhooks',
  maintenance: 'maintenance',
  deadLetter: 'webhooks-dead-letter',
} as const;

/**
 * Retry policy for webhook processing: up to 6 attempts with exponential
 * backoff (1s, 2s, 4s, 8s, 16s...). Exponential so that a struggling
 * dependency gets more breathing room after each failure, instead of being
 * hammered at a fixed rate.
 */
export const WEBHOOK_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

/** BullMQ requires maxRetriesPerRequest: null on its connections (blocking commands). */
export function bullConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export interface Queues {
  connection: Redis;
  webhooks: Queue;
  maintenance: Queue;
  deadLetter: Queue;
  close(): Promise<void>;
}

export function createQueues(redisUrl: string): Queues {
  const connection = bullConnection(redisUrl);
  const opts = { connection, prefix: QUEUE_PREFIX };
  const webhooks = new Queue(QUEUE_NAMES.webhooks, opts);
  const maintenance = new Queue(QUEUE_NAMES.maintenance, opts);
  const deadLetter = new Queue(QUEUE_NAMES.deadLetter, opts);
  return {
    connection,
    webhooks,
    maintenance,
    deadLetter,
    async close() {
      await Promise.all([webhooks.close(), maintenance.close(), deadLetter.close()]);
      connection.disconnect();
    },
  };
}
