/**
 * Equi-depth histogram over the values the MCV list did not take.
 *
 * `boundaries` holds `buckets + 1` values; every bucket between consecutive
 * boundaries holds the same number of rows. That is the shape Postgres uses and
 * the shape the histogram view draws.
 */
import { compareValues } from '../storage/table.js';
import type { Value } from './types.js';

export function buildHistogram(values: Value[], buckets: number): Value[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort(compareValues);
  const n = sorted.length;
  const wanted = Math.min(buckets, n);
  if (wanted <= 1) return [sorted[0], sorted[n - 1]];

  const boundaries: Value[] = [];
  for (let i = 0; i <= wanted; i++) {
    boundaries.push(sorted[Math.min(n - 1, Math.floor((i * n) / wanted))]);
  }
  boundaries[wanted] = sorted[n - 1];
  return boundaries;
}

/**
 * The fraction of the histogram's population below `value`.
 *
 * Whole buckets below the value count in full; the bucket containing it is
 * interpolated linearly. That interpolation is drawn in the histogram view, so
 * this returns enough detail to render it (DESIGN.md §5.4).
 */
export interface HistogramPosition {
  /** Fraction of histogram rows strictly below the value, 0..1. */
  fraction: number;
  /** Index of the bucket containing the value, or -1 / bucketCount if outside. */
  bucket: number;
  /** How far into that bucket the value sits, 0..1. */
  within: number;
}

export function locate(boundaries: Value[], value: Value): HistogramPosition {
  const buckets = boundaries.length - 1;
  if (buckets < 1) return { fraction: 0, bucket: -1, within: 0 };
  if (compareValues(value, boundaries[0]) <= 0) return { fraction: 0, bucket: -1, within: 0 };
  if (compareValues(value, boundaries[buckets]) >= 0) return { fraction: 1, bucket: buckets, within: 1 };

  let b = 0;
  while (b < buckets && compareValues(value, boundaries[b + 1]) > 0) b++;

  const within = interpolate(boundaries[b], boundaries[b + 1], value);
  return { fraction: (b + within) / buckets, bucket: b, within };
}

/** Where `value` sits between `low` and `high`, 0..1. */
export function interpolate(low: Value, high: Value, value: Value): number {
  if (typeof low === 'number' && typeof high === 'number' && typeof value === 'number') {
    if (high === low) return 0;
    return clamp01((value - low) / (high - low));
  }
  if (typeof low === 'string' && typeof high === 'string' && typeof value === 'string') {
    // Postgres converts the leading bytes of a string to a number for exactly
    // this purpose. Same idea, four characters deep.
    const l = stringOrdinal(low), h = stringOrdinal(high), v = stringOrdinal(value);
    if (h === l) return 0;
    return clamp01((v - l) / (h - l));
  }
  return 0.5;
}

function stringOrdinal(s: string): number {
  let n = 0;
  for (let i = 0; i < 4; i++) n = n * 256 + (i < s.length ? Math.min(255, s.charCodeAt(i)) : 0);
  return n;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
