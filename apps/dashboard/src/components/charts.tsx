// Small hand-built SVG charts (no chart library). Conventions:
// thin 2px lines, hairline solid grid, colour by entity via CSS tokens
// (.viz-root in index.css), crosshair + tooltip on hover and keyboard focus,
// and every chart on the page has a table view next to it.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(260, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export interface LineSeries {
  id: string;
  label: string;
  /** CSS color, e.g. 'var(--series-1)'. */
  color: string;
  values: (number | null)[];
}

interface LineChartProps {
  series: LineSeries[];
  /** x value for each index (e.g. simulated minute). */
  x: number[];
  xLabel: string;
  yFormat: (v: number) => string;
  /** Force the y-domain (otherwise from the data, with headroom). */
  yDomain?: [number, number];
  bands?: { from: number; to: number; label: string }[];
  height?: number;
  ariaLabel: string;
}

export function LineChart({ series, x, xLabel, yFormat, yDomain, bands = [], height = 260, ariaLabel }: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 52, r: 12, t: 12, b: 34 };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let [lo, hi] = yDomain ?? [Math.min(...all, 1), Math.max(...all, 0)];
  if (!yDomain) {
    const pad = (hi - lo || 0.01) * 0.08;
    lo -= pad;
    hi += pad;
  }
  const xMin = x[0] ?? 0;
  const xMax = x[x.length - 1] ?? 1;
  const sx = (v: number) => m.l + ((v - xMin) / (xMax - xMin || 1)) * w;
  const sy = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * h;
  const yTicks = niceTicks(lo, hi, 4).filter((t) => t >= lo && t <= hi);
  const xTicks = niceTicks(xMin, xMax, Math.max(2, Math.floor(w / 90)));

  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${sx(x[i]!).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const indexAt = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - m.l;
    const i = Math.round((px / w) * (x.length - 1));
    return Math.max(0, Math.min(x.length - 1, i));
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => setHover(indexAt(e.clientX, (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((i) => Math.min(x.length - 1, (i ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((i) => Math.max(0, (i ?? x.length) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const tipLeft = hover !== null ? sx(x[hover]!) : 0;
  const tipOnRight = tipLeft < width / 2;

  return (
    <div ref={ref} className="viz-root relative w-full min-w-0">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setHover((i) => i ?? x.length - 1)}
        onBlur={() => setHover(null)}
        className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {bands.map((b) => (
          <rect key={`${b.from}-${b.to}`} x={sx(b.from)} y={m.t} width={Math.max(1, sx(b.to) - sx(b.from))} height={h} fill="var(--viz-band)" />
        ))}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + w} y1={sy(t)} y2={sy(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={m.l - 8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" className="tabular">
              {yFormat(t)}
            </text>
          </g>
        ))}
        <line x1={m.l} x2={m.l + w} y1={m.t + h} y2={m.t + h} stroke="var(--viz-axis)" strokeWidth={1} />
        {xTicks.map((t) => (
          <text key={t} x={sx(t)} y={m.t + h + 16} textAnchor="middle" fontSize={11} fill="var(--viz-muted)" className="tabular">
            {t}
          </text>
        ))}
        <text x={m.l + w} y={height - 2} textAnchor="end" fontSize={11} fill="var(--viz-muted)">
          {xLabel}
        </text>
        {series.map((s) => (
          <path key={s.id} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={sx(x[hover]!)} x2={sx(x[hover]!)} y1={m.t} y2={m.t + h} stroke="var(--viz-muted)" strokeWidth={1} />
            {series.map((s) =>
              s.values[hover] !== null && s.values[hover] !== undefined ? (
                <circle key={s.id} cx={sx(x[hover]!)} cy={sy(s.values[hover]!)} r={4} fill={s.color} stroke="var(--color-white, #fff)" strokeWidth={2} className="dark:stroke-slate-900" />
              ) : null,
            )}
          </g>
        )}
        <rect x={m.l} y={m.t} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
          style={tipOnRight ? { left: tipLeft + 12 } : { right: width - tipLeft + 12 }}
        >
          <div className="mb-1 text-slate-500">
            {xLabel} {x[hover]}
          </div>
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-2 py-0.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
              <span className="tabular font-semibold text-slate-900 dark:text-slate-100">{s.values[hover] === null ? '-' : yFormat(s.values[hover]!)}</span>
              <span className="text-slate-500">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface BarRow {
  id: string;
  label: string;
  value: number;
  /** Half-width of the 95% confidence interval. */
  ci?: number;
  emphasized?: boolean;
}

/** Ranked horizontal bars with 95% CI whiskers. One emphasised bar, the rest recessive. */
export function BarChart({ rows, format, max, ariaLabel }: { rows: BarRow[]; format: (v: number) => string; max?: number; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const labelW = Math.min(150, width * 0.36);
  const valueW = 64;
  const barH = 18;
  const gap = 10;
  const top = Math.max(...rows.map((r) => r.value + (r.ci ?? 0)), 0);
  const domainMax = max ?? (top || 1);
  const w = width - labelW - valueW - 8;
  const sx = (v: number) => labelW + (Math.max(0, v) / domainMax) * w;
  const height = rows.length * (barH + gap);

  return (
    <div ref={ref} className="viz-root w-full min-w-0">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        <line x1={labelW} x2={labelW} y1={0} y2={height - gap} stroke="var(--viz-axis)" strokeWidth={1} />
        {rows.map((r, i) => {
          const y = i * (barH + gap);
          const fill = r.emphasized ? 'var(--series-1)' : 'var(--viz-dim)';
          const end = sx(r.value);
          const active = hover === r.id;
          return (
            <g
              key={r.id}
              tabIndex={0}
              onPointerEnter={() => setHover(r.id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(r.id)}
              onBlur={() => setHover(null)}
              className="outline-none"
            >
              <title>{`${r.label}: ${format(r.value)}${r.ci !== undefined ? ` (95% CI ± ${format(r.ci)})` : ''}`}</title>
              <rect x={0} y={y - gap / 2} width={width} height={barH + gap} fill="transparent" />
              <text x={labelW - 8} y={y + barH / 2} dy="0.32em" textAnchor="end" fontSize={12} className={r.emphasized ? 'fill-slate-900 font-semibold dark:fill-slate-100' : 'fill-slate-600 dark:fill-slate-300'}>
                {r.label}
              </text>
              {/* Bar anchored at the baseline, 4px rounded data end. */}
              <path
                d={`M${labelW + 1},${y} H${Math.max(labelW + 1, end - 4)} a4,4 0 0 1 4,4 V${y + barH - 4} a4,4 0 0 1 -4,4 H${labelW + 1} Z`}
                fill={fill}
                opacity={active ? 0.8 : 1}
              />
              {r.ci !== undefined && r.ci > 0 && (
                <g stroke="var(--viz-muted)" strokeWidth={1.5}>
                  <line x1={sx(r.value - r.ci)} x2={sx(r.value + r.ci)} y1={y + barH / 2} y2={y + barH / 2} />
                  <line x1={sx(r.value - r.ci)} x2={sx(r.value - r.ci)} y1={y + 5} y2={y + barH - 5} />
                  <line x1={sx(r.value + r.ci)} x2={sx(r.value + r.ci)} y1={y + 5} y2={y + barH - 5} />
                </g>
              )}
              <text x={sx(r.value + (r.ci ?? 0)) + 6} y={y + barH / 2} dy="0.32em" fontSize={12} className="tabular fill-slate-700 dark:fill-slate-200">
                {format(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
