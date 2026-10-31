import { PAYMENT_METHODS, type PaymentMethod } from '@po/shared';
import type { Redis } from 'ioredis';
import type { Env } from '../../lib/env';
import type { GatewayRegistry } from '../gateways/registry';
import { HealthTracker, type RouteHealth } from './health.tracker';
import type { GatewayRouter } from './router.types';

/** Every Nth payment for a method may go to a "probing" route first, to test recovery. */
const PROBE_EVERY = 5;

/**
 * Picks gateways for a payment method using live health:
 *  - degraded routes are skipped entirely (until their cooldown ends),
 *  - healthy routes come first, best success rate then lowest latency,
 *  - probing routes get a small share of traffic, and act as the last fallback.
 */
export class HealthAwareRouter implements GatewayRouter {
  readonly tracker: HealthTracker;

  constructor(
    private readonly registry: GatewayRegistry,
    private readonly redis: Redis,
    private readonly config: Env,
  ) {
    this.tracker = new HealthTracker(redis, config);
  }

  async candidates(method: PaymentMethod): Promise<string[]> {
    const routes = await Promise.all(
      this.registry
        .list()
        .filter((g) => g.supportedMethods.includes(method))
        .map((g) => this.tracker.health(g.name, method)),
    );

    // A route isn't judged until it has MIN_SAMPLES results: with less evidence it
    // counts as 100% (otherwise one early failure would push it to the back forever,
    // it would get no more traffic, and its score could never recover).
    const minSamples = this.config.ROUTING_MIN_SAMPLES;
    const score = (r: RouteHealth) => (r.samples >= minSamples ? (r.successRate ?? 1) : 1);
    const latency = (r: RouteHealth) => (r.samples >= minSamples ? (r.avgLatencyMs ?? 0) : 0);
    // Array.sort is stable, so ties keep registry order (the configured priority).
    const healthy = routes
      .filter((r) => r.state === 'healthy')
      .sort((a, b) => score(b) - score(a) || latency(a) - latency(b))
      .map((r) => r.gateway);
    const probing = routes.filter((r) => r.state === 'probing').map((r) => r.gateway);

    if (healthy.length === 0) return probing;
    if (probing.length === 0) return healthy;

    const n = await this.redis.incr(`po:health:probe-counter:${method}`);
    return n % PROBE_EVERY === 0 ? [...probing, ...healthy] : [...healthy, ...probing];
  }

  recordResult(gateway: string, method: PaymentMethod, ok: boolean, latencyMs: number): Promise<void> {
    return this.tracker.record(gateway, method, ok, latencyMs);
  }

  async snapshot(): Promise<RouteHealth[]> {
    const all: RouteHealth[] = [];
    for (const g of this.registry.list()) {
      for (const m of PAYMENT_METHODS) {
        if (g.supportedMethods.includes(m)) all.push(await this.tracker.health(g.name, m));
      }
    }
    return all;
  }
}
