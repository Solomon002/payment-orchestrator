import { describe, expect, it } from 'vitest';
import { createPaymentSchema, formatNaira, mockControlPatchSchema } from './index';

describe('createPaymentSchema', () => {
  const valid = {
    amountKobo: 500_000,
    method: 'card',
    reference: 'order-123',
    customerEmail: 'ada@example.com',
  };

  it('accepts a valid payment and defaults currency to NGN', () => {
    const parsed = createPaymentSchema.parse(valid);
    expect(parsed.currency).toBe('NGN');
  });

  it('rejects fractional kobo (money must be integers)', () => {
    expect(createPaymentSchema.safeParse({ ...valid, amountKobo: 100.5 }).success).toBe(false);
  });

  it('rejects unknown fields (strict input)', () => {
    expect(createPaymentSchema.safeParse({ ...valid, isAdmin: true }).success).toBe(false);
  });

  it('rejects unsupported currencies', () => {
    expect(createPaymentSchema.safeParse({ ...valid, currency: 'USD' }).success).toBe(false);
  });
});

describe('formatNaira', () => {
  it('formats kobo as naira without floating point', () => {
    expect(formatNaira(500_050)).toBe('NGN 5,000.50');
    expect(formatNaira(-7)).toBe('-NGN 0.07');
  });
});

describe('mockControlPatchSchema', () => {
  it('allows partial method outage updates', () => {
    expect(mockControlPatchSchema.parse({ methodOutages: { bank_transfer: true } })).toEqual({
      methodOutages: { bank_transfer: true },
    });
  });
});
