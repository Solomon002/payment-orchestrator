import { formatNaira } from '@po/shared';

export const naira = (kobo: number | null | undefined) => (kobo === null || kobo === undefined ? '-' : formatNaira(kobo));

export const percent = (ratio: number | null | undefined, digits = 0) =>
  ratio === null || ratio === undefined ? '-' : `${(ratio * 100).toFixed(digits)}%`;

export function time(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
}

/** "12s ago", "3m ago"... */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const shortRef = (ref: string | null | undefined, n = 14) => (!ref ? '-' : ref.length > n ? `${ref.slice(0, n)}…` : ref);
