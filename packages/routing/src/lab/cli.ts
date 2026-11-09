// `pnpm lab [--seeds N]`: runs the routing lab and writes
//   docs/routing-lab/results.json        full results
//   apps/dashboard/src/data/routing-lab.json   the same, for the dashboard's Routing Lab page
//   docs/ROUTING-LAB.md                  results tables (between the RESULTS markers)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resultsMarkdown } from './report';
import { runLab } from './run';

const root = resolve(import.meta.dirname, '../../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const seeds = Number(arg('--seeds') ?? 8);

const started = Date.now();
console.log(`Routing lab: ${seeds} seeds per scenario x strategy...`);
const results = runLab({ seeds, onProgress: (m) => console.log(`  ${m} (${((Date.now() - started) / 1000).toFixed(1)}s)`) });

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path.replace(root, '.')}`);
};
const json = `${JSON.stringify(results, (_k, v) => (typeof v === 'number' ? Number(v.toPrecision(6)) : v))}\n`;
write(resolve(root, 'docs/routing-lab/results.json'), json);
write(resolve(root, 'apps/dashboard/src/data/routing-lab.json'), json);

const mdPath = resolve(root, 'docs/ROUTING-LAB.md');
const START = '<!-- RESULTS:START -->';
const END = '<!-- RESULTS:END -->';
const table = `${START}\n${resultsMarkdown(results)}\n${END}`;
if (existsSync(mdPath)) {
  const md = readFileSync(mdPath, 'utf8');
  const a = md.indexOf(START);
  const b = md.indexOf(END);
  write(mdPath, a >= 0 && b > a ? md.slice(0, a) + table + md.slice(b + END.length) : `${md}\n\n${table}\n`);
} else {
  write(mdPath, `# Routing Lab\n\n## Results\n\n${table}\n`);
}

// Console summary: overall success rate per scenario and strategy.
const rows = results.scenarios.map((sc) =>
  Object.fromEntries([
    ['scenario', sc.id],
    ...sc.strategies.map((s) => [s.strategy, s.stats.successRate ? `${(s.stats.successRate.mean * 100).toFixed(2)}%` : '-']),
  ]),
);
console.table(rows);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
