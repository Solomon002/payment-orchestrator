// Turns lab results into Markdown tables.
import type { LabResults, Stat, StrategyResult } from './run';

const pct = (s: Stat | null | undefined, digits = 1) => (s ? `${(s.mean * 100).toFixed(digits)}% ± ${(s.ci95 * 100).toFixed(digits)}` : '-');
const num = (s: Stat | null | undefined, digits = 2, unit = '') => (s ? `${s.mean.toFixed(digits)}${unit} ± ${s.ci95.toFixed(digits)}` : '-');
const naira = (s: Stat | null | undefined) => (s ? `NGN ${(s.mean / 100).toFixed(2)}` : '-');

function minutesCell(r: StrategyResult, key: 'adaptMin' | 'recoverMin', seeds: number) {
  const s = r.stats[key];
  if (!s) return 'never';
  const missing = seeds - s.n;
  return `${s.mean.toFixed(1)} ± ${s.ci95.toFixed(1)}${missing > 0 ? ` (never in ${missing}/${seeds})` : ''}`;
}

export function resultsMarkdown(results: LabResults): string {
  const lines: string[] = [];
  lines.push(
    `_Generated ${results.generatedAt.slice(0, 16).replace('T', ' ')} UTC by \`pnpm lab\`: ${results.seeds} seeds per cell, ` +
      `${results.traffic.ratePerSec} payments/s for ${results.traffic.durationMs / 60_000} simulated minutes ` +
      `(~${Math.round((results.traffic.ratePerSec * results.traffic.durationMs) / 1000).toLocaleString('en')} payments per run). ` +
      `Values are mean ± 95% confidence interval across seeds._`,
  );
  for (const sc of results.scenarios) {
    lines.push('', `### ${sc.title} (\`${sc.id}\`)`, '', sc.description, '');
    const hasIncident = sc.id !== 'baseline';
    const head = ['Strategy', 'Success (all)', ...(hasIncident ? ['Success (affected, during)'] : []), 'Attempts/payment', 'Mean latency', 'p95 latency', 'Fee rate', 'Net revenue/payment'];
    if (hasIncident) head.push('Adapt (min)', 'Recover (min)');
    head.push('Breaker changes');
    lines.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const r of sc.strategies) {
      const s = r.stats;
      const row = [
        `**${r.strategy}**`,
        pct(s.successRate, 2),
        ...(hasIncident ? [pct(s.incidentSuccessRate)] : []),
        num(s.avgAttempts, 3),
        num(s.meanLatencyMs, 0, ' ms'),
        num(s.p95LatencyMs, 0, ' ms'),
        s.feeRateBps ? `${(s.feeRateBps.mean / 100).toFixed(3)}%` : '-',
        naira(s.netRevenuePerPaymentKobo),
      ];
      if (hasIncident) row.push(minutesCell(r, 'adaptMin', results.seeds), minutesCell(r, 'recoverMin', results.seeds));
      row.push(s.transitions && s.transitions.mean > 0 ? s.transitions.mean.toFixed(0) : '-');
      lines.push(`| ${row.join(' | ')} |`);
    }
  }
  return lines.join('\n');
}
