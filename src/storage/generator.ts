/**
 * Synthetic data with controlled correlation and skew.
 *
 * Synthetic is the primary source (PRD §4.7) because the app's subject is the
 * relationship between correlation and estimation error, and only a generator
 * lets you set that relationship exactly.
 */
import { makeRng, deriveSeed, type Rng } from '../engine/rng.js';
import type { Value } from './table.js';

/**
 * Zipf-distributed integers in [0, n). s = 0 is uniform; s ~ 1 is the classic
 * heavy head that makes an MCV list worth having.
 */
export function zipfSampler(n: number, s: number, rng: Rng): () => number {
  const weights = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 1 / Math.pow(i + 1, s);
    total += weights[i];
  }
  const cumulative = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += weights[i] / total; cumulative[i] = acc; }
  cumulative[n - 1] = 1;

  return () => {
    const u = rng.next();
    // Binary search the cumulative table.
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < u) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
}

/**
 * A second categorical column correlated with the first at strength `rho`.
 *
 * At rho = 1 the value of `a` fixes the value of `b` exactly — a functional
 * dependency, which is the independence failure in its purest form. At rho = 0
 * the two are drawn independently. In between, each row keeps the determined
 * value with probability rho and redraws otherwise, so the dependency degree
 * that the multivariate statistic will later measure is approximately rho.
 */
export function correlatedCategory(
  driver: number[], distinct: number, rho: number, rng: Rng,
): number[] {
  const determined = (a: number): number => (a * 2654435761) % distinct;
  return driver.map((a) => (rng.next() < rho ? determined(a) : rng.int(distinct)));
}

/**
 * Reorder rows so a column's physical order matches its logical order to the
 * degree `correlation`. This is what `ColumnStatistics.correlation` measures and
 * what makes an index scan cheap or expensive.
 */
export function physicallyCluster<T>(
  rows: T[], key: (row: T) => Value, correlation: number, rng: Rng,
): T[] {
  const sorted = [...rows].sort((x, y) => {
    const a = key(x), b = key(y);
    return a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0;
  });
  // Jitter each sorted position by a normal whose width shrinks as correlation
  // rises. At 1 the order is exact; at 0 the jitter dominates and the order is
  // effectively random.
  const spread = (1 - correlation) * rows.length;
  return sorted
    .map((row, i) => ({ row, k: i + rng.normal() * spread }))
    .sort((x, y) => x.k - y.k)
    .map((e) => e.row);
}

export interface GeneratorParams {
  rows: number;
  /** Correlation between the two demonstration columns, 0..1. */
  correlation: number;
  /** Zipf exponent for skewed columns, 0..1.5. */
  zipf: number;
  seed: number;
}

export function generatorRng(params: GeneratorParams, stream: string): Rng {
  return makeRng(deriveSeed(params.seed, stream));
}
