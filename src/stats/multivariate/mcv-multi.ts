/**
 * Multivariate MCV: the most common *combinations*, with frequencies.
 *
 * The most powerful of the three and the largest to store. It handles the
 * general case rather than only equality conjunctions, because it records what
 * a combination's frequency actually is instead of a rule for deriving it.
 *
 * Each entry also carries `baseFrequency` — what independence would have
 * predicted for that combination. Carrying both in one object is what lets the
 * correlation plot draw the wrong belief and the corrected one from the same
 * source (CLAUDE.md §1), and it is what the recovery view compares.
 */
import { keyOf } from '../mcv.js';
import type { Value } from '../types.js';

export interface MultiMcvEntry {
  values: Value[];
  frequency: number;
  baseFrequency: number;
}

export function computeMultiMcv(
  rows: Value[][], target: number,
): MultiMcvEntry[] {
  const n = rows[0]?.length ?? 0;
  if (n === 0) return [];

  // Marginal frequencies per column, for the independence prediction.
  const marginals = rows.map((column) => {
    const counts = new Map<string, number>();
    for (const v of column) counts.set(keyOf(v), (counts.get(keyOf(v)) ?? 0) + 1);
    return counts;
  });

  const combos = new Map<string, { values: Value[]; count: number }>();
  for (let r = 0; r < n; r++) {
    const values = rows.map((c) => c[r]);
    const k = values.map(keyOf).join('');
    const e = combos.get(k);
    if (e) e.count++;
    else combos.set(k, { values, count: 1 });
  }

  return [...combos.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, target)
    .map((e) => ({
      values: e.values,
      frequency: e.count / n,
      baseFrequency: e.values.reduce<number>(
        (p, v, i) => p * ((marginals[i].get(keyOf(v)) ?? 0) / n),
        1,
      ),
    }));
}

/** Find the entry matching an exact combination of values, if it is listed. */
export function lookupCombination(
  entries: MultiMcvEntry[], values: Value[],
): MultiMcvEntry | null {
  const k = values.map(keyOf).join('');
  return entries.find((e) => e.values.map(keyOf).join('') === k) ?? null;
}

/** Total frequency the list accounts for. The fallback subtracts this out. */
export function listedFrequency(entries: MultiMcvEntry[]): number {
  return entries.reduce((s, e) => s + e.frequency, 0);
}
