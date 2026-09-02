/**
 * Multivariate n-distinct: the number of distinct combinations across a column
 * group, for every subset of the group of size two or more.
 *
 * This repairs GROUP BY estimates over correlated columns. Independence says the
 * number of groups over (kota, provinsi) is distinct(kota) x distinct(provinsi);
 * when kota determines provinsi the truth is distinct(kota), which for 41 cities
 * and 37 provinces is 41 rather than 1,517. The estimate feeds hash aggregate
 * sizing, so getting it wrong spills a hash that would have fitted.
 */
import { keyOf } from '../mcv.js';
import type { Value } from '../types.js';
import type { Sample } from '../sample.js';

export function ndistinctKey(columns: string[]): string {
  return [...columns].sort().join(',');
}

export function computeNDistinct(
  columns: string[], rows: Value[][], sample: Sample,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const subset of subsetsOfAtLeastTwo(columns.length)) {
    const seen = new Set<string>();
    for (let r = 0; r < rows[0].length; r++) {
      seen.add(subset.map((c) => keyOf(rows[c][r])).join(''));
    }
    out.set(
      ndistinctKey(subset.map((c) => columns[c])),
      extrapolate(seen.size, rows[0].length, sample.populationSize),
    );
  }
  return out;
}

/**
 * The same first-order estimator the single-column case uses, simplified: with
 * no singleton count to work from for combinations, scale by the sampling ratio
 * and cap at the row count. Understating combinations is the safer error here,
 * since it is the direction that avoids re-inflating the independence gap.
 */
function extrapolate(distinctInSample: number, sampleRows: number, population: number): number {
  if (sampleRows >= population || sampleRows === 0) return distinctInSample;
  const ratio = population / sampleRows;
  return Math.min(population, Math.round(distinctInSample * Math.sqrt(ratio)));
}

function* subsetsOfAtLeastTwo(n: number): Generator<number[]> {
  for (let mask = 1; mask < 1 << n; mask++) {
    const bits: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bits.push(i);
    if (bits.length >= 2) yield bits;
  }
}
