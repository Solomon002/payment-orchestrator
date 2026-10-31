import type { PaymentMethod } from '@po/shared';
import type { GatewayRegistry } from '../gateways/registry';
import type { GatewayRouter } from './router.types';

/**
 * The simplest possible router: every gateway that supports the method, in a
 * fixed order. Used as the baseline before health-aware routing (Phase 3) and
 * in tests that need deterministic order.
 */
export class StaticRouter implements GatewayRouter {
  constructor(private readonly registry: GatewayRegistry) {}

  async candidates(method: PaymentMethod): Promise<string[]> {
    return this.registry
      .list()
      .filter((g) => g.supportedMethods.includes(method))
      .map((g) => g.name);
  }

  async recordResult(): Promise<void> {}
}
