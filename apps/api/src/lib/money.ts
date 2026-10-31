// Money helpers. All arithmetic is done in BigInt kobo; numbers only appear at
// the API boundary (JSON has no BigInt), and only when they are exactly representable.

export function toKobo(n: number | bigint): bigint {
  if (typeof n === 'bigint') return n;
  if (!Number.isSafeInteger(n)) throw new Error(`Not a safe integer amount: ${n}`);
  return BigInt(n);
}

export function koboToNumber(k: bigint): number {
  const n = Number(k);
  if (!Number.isSafeInteger(n)) throw new Error(`Amount ${k} is too large to serialise safely`);
  return n;
}

/**
 * Fee in basis points (1 bp = 0.01%), rounded half-up to the nearest kobo, then capped.
 * e.g. 150 bps of 500,000 kobo = 7,500 kobo.
 */
export function feeFromBps(amount: bigint, bps: number, capKobo: number): bigint {
  const raw = (amount * BigInt(bps) + 5_000n) / 10_000n;
  const cap = BigInt(capKobo);
  return raw > cap ? cap : raw;
}

/** JSON replacer used by Express and when storing responses: BigInt -> number. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? koboToNumber(value) : value;
}

/** Deep-copies a value into plain JSON (BigInt converted, Dates to ISO strings). */
export function toJsonValue<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value, bigintReplacer)) as T;
}
