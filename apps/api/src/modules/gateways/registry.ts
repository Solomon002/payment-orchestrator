import type { Env } from '../../lib/env';
import type { GatewayAdapter } from './gateway.types';
import { MockGatewayAdapter } from './mock.adapter';
import { PaystackAdapter } from './paystack.adapter';

export class GatewayRegistry {
  private readonly adapters = new Map<string, GatewayAdapter>();

  constructor(adapters: GatewayAdapter[]) {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  get(name: string): GatewayAdapter | undefined {
    return this.adapters.get(name);
  }

  require(name: string): GatewayAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`Unknown gateway ${name}`);
    return adapter;
  }

  list(): GatewayAdapter[] {
    return [...this.adapters.values()];
  }

  names(): string[] {
    return [...this.adapters.keys()];
  }
}

/** Builds the gateways from configuration. Paystack is included only when a TEST key is set. */
export function registryFromEnv(config: Env): GatewayRegistry {
  const adapters: GatewayAdapter[] = [
    new MockGatewayAdapter('mockpay-a', config.MOCKPAY_A_URL, config.MOCKPAY_A_SECRET, config.GATEWAY_TIMEOUT_MS, 150),
    new MockGatewayAdapter('mockpay-b', config.MOCKPAY_B_URL, config.MOCKPAY_B_SECRET, config.GATEWAY_TIMEOUT_MS, 140),
  ];
  if (config.PAYSTACK_SECRET_KEY) {
    adapters.push(new PaystackAdapter(config.PAYSTACK_SECRET_KEY, config.GATEWAY_TIMEOUT_MS, config.PAYSTACK_CALLBACK_URL));
  }
  return new GatewayRegistry(adapters);
}
