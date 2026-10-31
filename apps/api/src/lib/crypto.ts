import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha512Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha512', secret).update(payload).digest('hex');
}

/**
 * Compares two secrets in constant time.
 * A normal `a === b` stops at the first different character, so an attacker
 * timing many requests could learn a secret one character at a time. Hashing
 * both sides first also makes the inputs equal length, which timingSafeEqual requires.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Merchant API keys are 192 bits of randomness, so a fast SHA-256 hash is
 * enough to store them safely (slow hashes like bcrypt exist for low-entropy
 * human passwords, which these are not). The prefix is kept for display only.
 */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `sk_test_${randomBytes(24).toString('hex')}`;
  return { key, hash: sha256Hex(key), prefix: key.slice(0, 12) };
}

/** JSON with sorted object keys, so {a,b} and {b,a} hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
