// Random numbers for routing and simulation.
//
// The simulator must be REPRODUCIBLE: the same seed must give the same run, so
// results can be checked and compared fairly. Math.random can't be seeded, so
// we use a small seeded generator (mulberry32). Production passes Math.random.

/** A source of uniform random numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: a tiny, fast, seedable 32-bit generator. Good enough for simulation, NOT for cryptography. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal N(0, 1) via the Box-Muller transform. */
export function sampleNormal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng(); // avoid log(0)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Gamma(shape, 1) using Marsaglia & Tsang (2000). For shape < 1 we use the
 * standard boost: Gamma(a) = Gamma(a + 1) * U^(1/a).
 */
export function sampleGamma(rng: Rng, shape: number): number {
  if (shape <= 0) throw new Error(`Gamma shape must be positive, got ${shape}`);
  if (shape < 1) return sampleGamma(rng, shape + 1) * Math.pow(rng() || Number.MIN_VALUE, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Beta(alpha, beta). If X ~ Gamma(alpha) and Y ~ Gamma(beta), X / (X + Y) ~ Beta(alpha, beta).
 * A Beta distribution describes our uncertainty about a probability (here: a
 * route's success rate) given alpha-1 successes and beta-1 failures.
 */
export function sampleBeta(rng: Rng, alpha: number, beta: number): number {
  const x = sampleGamma(rng, alpha);
  const y = sampleGamma(rng, beta);
  return x / (x + y);
}

/** Exponential with the given mean, e.g. time between Poisson arrivals. */
export function sampleExponential(rng: Rng, mean: number): number {
  return -mean * Math.log(1 - rng());
}
