/**
 * Reservoir sampling with a seeded PRNG (CLAUDE.md §6).
 *
 * Statistics come from a sample, always. Never scan the whole table and call the
 * result an estimate — sampling error is part of the subject, and the sample
 * view shows exactly which rows the statistics saw.
 *
 * Only the row ids are kept. Reproducing the sample from the seed is cheaper
 * than storing the values twice, and the sample view needs the ids anyway.
 */
import { makeRng, deriveSeed } from '../engine/rng.js';

export interface Sample {
  /** Row ids the statistics saw, ascending. */
  rowIds: number[];
  /** Rows in the table when the sample was taken. */
  populationSize: number;
  /** The requested target; the actual sample is min(target, population). */
  target: number;
  seed: number;
}

/**
 * Algorithm R. Every row has an equal chance of ending in the reservoir, and the
 * result depends only on (population, target, seed).
 */
export function reservoirSample(populationSize: number, target: number, seed: number): Sample {
  const k = Math.min(target, populationSize);
  const rng = makeRng(deriveSeed(seed, `sample:${populationSize}:${target}`));
  const reservoir = new Array<number>(k);
  for (let i = 0; i < k; i++) reservoir[i] = i;
  for (let i = k; i < populationSize; i++) {
    const j = rng.int(i + 1);
    if (j < k) reservoir[j] = i;
  }
  reservoir.sort((a, b) => a - b);
  return { rowIds: reservoir, populationSize, target, seed };
}

/**
 * The scale factor from sample counts to table counts. A frequency measured over
 * `rowIds.length` rows describes `populationSize` rows.
 */
export function scaleFactor(sample: Sample): number {
  return sample.rowIds.length === 0 ? 0 : sample.populationSize / sample.rowIds.length;
}

/**
 * Standard error of a proportion measured on this sample, with the finite
 * population correction. The interface states sampling error rather than hiding
 * it (PRD §6.3).
 */
export function proportionStandardError(p: number, sample: Sample): number {
  const n = sample.rowIds.length;
  const N = sample.populationSize;
  if (n <= 1 || N <= 1) return 0;
  const fpc = Math.sqrt(Math.max(0, (N - n) / (N - 1)));
  return Math.sqrt(Math.max(0, (p * (1 - p)) / n)) * fpc;
}
