// Outage scenarios replayed against every strategy. Each runs 120 simulated
// minutes. Times are in minutes for readability.
import type { Incident } from './model';

const min = (m: number) => m * 60_000;

export interface Scenario {
  id: string;
  title: string;
  description: string;
  incidents: Incident[];
  /** Which payments the incident is about, and which routes count as "affected", for adapt/recover timing. */
  focus: { method?: 'card' | 'bank_transfer'; bank?: string; gateways: string[] | 'all' } | null;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'baseline',
    title: 'Normal day',
    description: 'No incidents. Measures the cost of each strategy\'s exploration and its fees.',
    incidents: [],
    focus: null,
  },
  {
    id: 'gateway_outage',
    title: 'Gateway outage (timeouts)',
    description: 'gw-a stops answering for 30 minutes (minutes 30-60); every call to it times out after 5s.',
    incidents: [{ label: 'gw-a down', startMs: min(30), endMs: min(60), level: 'gateway', gateway: 'gw-a', successAt: () => 0, mode: 'timeout' }],
    focus: { gateways: ['gw-a'] },
  },
  {
    id: 'nibss_outage',
    title: 'NIBSS-style outage',
    description: 'Bank transfers fail on EVERY gateway for 45 minutes (95% time out); cards are unaffected.',
    incidents: [{ label: 'transfers down everywhere', startMs: min(30), endMs: min(75), level: 'gateway', method: 'bank_transfer', successAt: () => 0.05, mode: 'timeout' }],
    focus: { method: 'bank_transfer', gateways: 'all' },
  },
  {
    id: 'bank_outage_everywhere',
    title: 'One bank down everywhere',
    description: 'GTBank (058) transfers succeed only 15% of the time on every gateway for 50 minutes.',
    incidents: [{ label: 'GTBank transfers failing', startMs: min(30), endMs: min(80), level: 'bank', method: 'bank_transfer', bank: '058', successAt: () => 0.15, mode: 'error' }],
    focus: { method: 'bank_transfer', bank: '058', gateways: 'all' },
  },
  {
    id: 'bank_outage_one_gateway',
    title: 'One bank down on one gateway',
    description: 'GTBank (058) transfers fail 90% of the time, but only through gw-a, for 50 minutes. Other banks on gw-a are fine.',
    incidents: [{ label: 'GTBank via gw-a failing', startMs: min(30), endMs: min(80), level: 'bank', gateway: 'gw-a', method: 'bank_transfer', bank: '058', successAt: () => 0.1, mode: 'error' }],
    focus: { method: 'bank_transfer', bank: '058', gateways: ['gw-a'] },
  },
  {
    id: 'flaky_gateway',
    title: 'Flaky gateway',
    description: 'gw-a cards drop to 55% success in 3-minute bursts every 12 minutes (minutes 20-110). Tests stability and flip-flopping.',
    incidents: Array.from({ length: 8 }, (_, k) => ({
      label: `burst ${k + 1}`,
      startMs: min(20 + 12 * k),
      endMs: min(23 + 12 * k),
      level: 'gateway' as const,
      gateway: 'gw-a',
      method: 'card' as const,
      successAt: () => 0.55,
      mode: 'error' as const,
    })),
    focus: { method: 'card', gateways: ['gw-a'] },
  },
  {
    id: 'slow_degradation',
    title: 'Slow degradation',
    description: 'gw-a cards slide from 97% to 60% success between minutes 20 and 70, stay there until 90, then recover.',
    incidents: [
      {
        label: 'gw-a cards degrading',
        startMs: min(20),
        endMs: min(90),
        level: 'gateway',
        gateway: 'gw-a',
        method: 'card',
        successAt: (t) => (t < min(70) ? 0.97 - ((0.97 - 0.6) * (t - min(20))) / min(50) : 0.6),
        mode: 'error',
      },
    ],
    focus: { method: 'card', gateways: ['gw-a'] },
  },
];
