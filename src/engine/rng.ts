/**
 * Seeded PRNG. The engine never calls Math.random (CLAUDE.md §4) — same data,
 * same seed, same statistics must produce the same plan (PRD §7.3).
 *
 * mulberry32: 32-bit state, well-distributed, and short enough to audit.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Standard normal, Box-Muller. */
  normal(): number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return {
    next,
    int: (n) => Math.floor(next() * n),
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0, s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const f = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * f;
      return u * f;
    },
  };
}

/** Derive an independent stream from a seed and a label, so streams do not interleave. */
export function deriveSeed(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
