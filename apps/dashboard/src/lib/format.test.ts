import { describe, expect, it } from 'vitest';
import { ago, naira, percent, shortRef } from './format';

describe('format helpers', () => {
  it('formats kobo as naira', () => {
    expect(naira(1_500_000)).toBe('NGN 15,000.00');
    expect(naira(null)).toBe('-');
  });

  it('formats ratios as percentages', () => {
    expect(percent(0.875, 1)).toBe('87.5%');
    expect(percent(null)).toBe('-');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(ago('2026-01-01T11:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-01-01T11:00:00Z', now)).toBe('1h ago');
  });

  it('shortens long references', () => {
    expect(shortRef('pay_0123456789abcdef', 8)).toBe('pay_0123…');
  });
});
