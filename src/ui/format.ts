/**
 * Number and copy formatting.
 *
 * English, sentence case, no exclamation marks. Postgres terminology exactly as
 * Postgres writes it, because the app's value depends on a reader mapping what
 * they see here onto real EXPLAIN output (DESIGN.md §7).
 */

export function rows(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function exact(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

export function cost(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100_000) return n.toExponential(2);
  if (n >= 1000) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

export function ms(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  if (n >= 10) return `${n.toFixed(0)} ms`;
  if (n >= 1) return `${n.toFixed(1)} ms`;
  return `${n.toFixed(2)} ms`;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${Math.round(n)} B`;
}

export function percent(f: number, places = 1): string {
  return `${(f * 100).toFixed(places)}%`;
}

/**
 * A selectivity, in whichever form reads better at its magnitude.
 *
 * "1 in 10,000" is legible where "0.01%" is not, and the app's central claim is
 * about a ratio of exactly that size.
 */
export function selectivity(f: number): string {
  if (f <= 0) return '0';
  if (f >= 1) return '100%';
  if (f >= 0.01) return `${(f * 100).toFixed(2)}%`;
  return `1 in ${exact(1 / f)}`;
}

/**
 * The error ratio between an estimate and the truth, with its direction.
 *
 * Under-estimates are the dangerous ones — they are what make a planner choose a
 * nested loop it cannot afford — so the direction is always stated.
 */
export interface ErrorRatio {
  ratio: number;
  direction: 'under' | 'over' | 'exact';
  label: string;
}

export function errorRatio(estimated: number, actual: number): ErrorRatio {
  const e = Math.max(estimated, 1e-9);
  const a = Math.max(actual, 1e-9);
  if (Math.abs(e - a) < 0.5 || Math.abs(e / a - 1) < 0.02) {
    return { ratio: 1, direction: 'exact', label: '1×' };
  }
  if (e < a) {
    const ratio = a / e;
    return { ratio, direction: 'under', label: `${formatRatio(ratio)}×` };
  }
  const ratio = e / a;
  return { ratio, direction: 'over', label: `${formatRatio(ratio)}×` };
}

function formatRatio(r: number): string {
  if (r >= 1000) return rows(r);
  if (r >= 100) return r.toFixed(0);
  if (r >= 10) return r.toFixed(0);
  return r.toFixed(1);
}

export function directionWord(direction: ErrorRatio['direction']): string {
  return direction === 'under' ? 'underestimated'
    : direction === 'over' ? 'overestimated'
      : 'estimated exactly';
}

/** Join a list of words with commas and a final "and". */
export function list(words: string[]): string {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
