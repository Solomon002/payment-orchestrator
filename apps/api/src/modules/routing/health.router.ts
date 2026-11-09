import { PAYMENT_METHODS, type PaymentMethod } from '@po/shared';
import {
  combineStates,
  DEFAULT_THOMPSON,
  expectedSuccess,
  orderByBreaker,
  orderByThompson,
  sumCounts,
  type ThompsonConfig,
  type ThompsonRoute,
} from '@po/routing';
import type { Redis } from 'ioredis';
import type { Env } from '../../lib/env';
import type { GatewayRegistry } from '../gateways/registry';
import { HealthTracker, type RouteHealth } from './health.tracker';
import type { CandidateRequest, GatewayRouter, RouteOutcome } from './router.types';

export interface RouteView extends RouteHealth {
  /** Thompson posterior-mean success probability (what the bandit currently believes). */
  expectedSuccess: number;
}

/**
 * Health-aware routing with a switchable strategy (ROUTING_STRATEGY):
 *  - breaker:       circuit breaker per route; degraded routes excluded
 *  - thompson:      Thompson sampling, maximise P(success)
 *  - thompson_cost: Thompson sampling, maximise P(success) x (amount - fee)
 * Both levels (gateway+method, gateway+method+bank) feed every strategy.
 * docs/ROUTING-LAB.md compares the strategies in simulation.
 */
export class HealthAwareRouter implements GatewayRouter {
  readonly tracker: HealthTracker;
  readonly thompson: ThompsonConfig;

  constructor(
    private readonly registry: GatewayRegistry,
    private readonly redis: Redis,
    private readonly config: Env,
    private readonly random: () => number = Math.random,
  ) {
    this.tracker = new HealthTracker(redis, config);
    this.thompson = {
      ...DEFAULT_THOMPSON,
      halfLifeMs: config.ROUTING_TS_HALF_LIFE_MS,
      minViableRate: config.ROUTING_MIN_VIABLE_RATE,
    };
  }

  get strategy() {
    return this.config.ROUTING_STRATEGY;
  }

  async candidates(method: PaymentMethod, request: CandidateRequest = {}): Promise<string[]> {
    const bankCode = request.bankCode ?? null;
    const gateways = this.registry.list().filter((g) => g.supportedMethods.includes(method));
    const gm = await Promise.all(gateways.map((g) => this.tracker.health(g.name, method)));
    const bank = bankCode ? await Promise.all(gateways.map((g) => this.tracker.health(g.name, method, bankCode))) : null;

    if (this.strategy === 'breaker') {
      // A route is only as healthy as its worst level.
      const routes = gateways.map((g, i) => ({
        gateway: g.name,
        state: combineStates([gm[i]!.state, ...(bank ? [bank[i]!.state] : [])]),
        samples: gm[i]!.samples,
        successRate: gm[i]!.successRate,
        avgLatencyMs: gm[i]!.avgLatencyMs,
      }));
      const n = await this.redis.incr(`po:health:probe-counter:${method}`);
      return orderByBreaker(routes, this.config.ROUTING_MIN_SAMPLES, n);
    }

    const now = Date.now();
    const gmCounts = await Promise.all(gateways.map((g) => this.tracker.counts({ gateway: g.name, method })));
    const bankCounts = bankCode
      ? await Promise.all(gateways.map((g) => this.tracker.counts({ gateway: g.name, method, bankCode })))
      : null;
    const routes: ThompsonRoute[] = gateways.map((g, i) => ({
      gateway: g.name,
      gatewayCounts: gmCounts[i]!,
      bankCounts: bankCounts ? bankCounts[i]! : null,
      otherGatewaysBankCounts: bankCounts ? sumCounts(bankCounts.filter((_, j) => j !== i), now, this.thompson.halfLifeMs) : null,
      netValueKobo: request.amountKobo !== undefined ? request.amountKobo - g.estimateFeeKobo(request.amountKobo) : undefined,
    }));
    return orderByThompson(this.random, routes, this.thompson, now, this.strategy === 'thompson_cost' ? 'net_revenue' : 'success');
  }

  /**
   * Attribution: a success counts for both levels; a gateway-caused failure only
   * for (gateway, method); a bank-caused failure only for (gateway, method, bank).
   */
  async recordResult(o: RouteOutcome): Promise<void> {
    const bank = o.bankCode ?? null;
    if (o.ok) {
      await this.tracker.record(o.gateway, o.method, true, o.latencyMs);
      if (bank) await this.tracker.record(o.gateway, o.method, true, o.latencyMs, bank);
    } else if (o.scope === 'bank' && bank) {
      await this.tracker.record(o.gateway, o.method, false, o.latencyMs, bank);
    } else {
      await this.tracker.record(o.gateway, o.method, false, o.latencyMs);
    }
  }

  private async view(gateway: string, method: PaymentMethod, bankCode: string | null): Promise<RouteView> {
    const h = await this.tracker.health(gateway, method, bankCode);
    const now = Date.now();
    const gmCounts = await this.tracker.counts({ gateway, method });
    const bankCounts = bankCode ? await this.tracker.counts({ gateway, method, bankCode }) : null;
    const others = bankCode
      ? await Promise.all(
          this.registry
            .list()
            .filter((g) => g.name !== gateway && g.supportedMethods.includes(method))
            .map((g) => this.tracker.counts({ gateway: g.name, method, bankCode })),
        )
      : [];
    const route: ThompsonRoute = {
      gateway,
      gatewayCounts: gmCounts,
      bankCounts,
      otherGatewaysBankCounts: bankCode ? sumCounts(others, now, this.thompson.halfLifeMs) : null,
    };
    // Bank rows show only the bank factor's belief combined with the gateway's.
    return { ...h, expectedSuccess: expectedSuccess(route, this.thompson, now) };
  }

  /** Health of every (gateway, method) route, plus every bank-level route seen so far. */
  async snapshot(): Promise<{ routes: RouteView[]; bankRoutes: RouteView[] }> {
    const routes: RouteView[] = [];
    for (const g of this.registry.list()) {
      for (const m of PAYMENT_METHODS) if (g.supportedMethods.includes(m)) routes.push(await this.view(g.name, m, null));
    }
    const known = (await this.tracker.knownRoutes()).filter((k) => k.bankCode && this.registry.get(k.gateway));
    const bankRoutes: RouteView[] = [];
    for (const k of known) bankRoutes.push(await this.view(k.gateway, k.method, k.bankCode ?? null));
    bankRoutes.sort((a, b) => (a.bankCode ?? '').localeCompare(b.bankCode ?? '') || a.gateway.localeCompare(b.gateway) || a.method.localeCompare(b.method));
    return { routes, bankRoutes };
  }
}
