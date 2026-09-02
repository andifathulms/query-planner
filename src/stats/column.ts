/**
 * Per-column statistics, collected from a sample.
 *
 * This module is the one place that touches both storage and the boundary type.
 * Everything downstream of here reads `Statistics` and cannot see the data.
 */
import type { Table, Value as StoredValue } from '../storage/table.js';
import type { Schema } from '../storage/table.js';
import { compareValues } from '../storage/table.js';
import { buildHistogram } from './histogram.js';
import { buildMcv } from './mcv.js';
import { reservoirSample, scaleFactor, type Sample } from './sample.js';
import type {
  ColumnStatistics, IndexStatistics, Statistics, TableStatistics, Value,
} from './types.js';

/** Postgres's default_statistics_target. Both list lengths derive from it. */
export const DEFAULT_STATISTICS_TARGET = 100;

export interface AnalyzeOptions {
  /** Rows to sample per table (CLAUDE.md §6). */
  sampleSize: number;
  seed: number;
  statisticsTarget?: number;
}

export interface AnalyzeResult {
  statistics: Statistics;
  /** Which rows each table's statistics actually saw. The sample view needs these. */
  samples: Map<string, Sample>;
}

export function analyze(schema: Schema, options: AnalyzeOptions): AnalyzeResult {
  const target = options.statisticsTarget ?? DEFAULT_STATISTICS_TARGET;
  const tables = new Map<string, TableStatistics>();
  const samples = new Map<string, Sample>();

  for (const [name, table] of schema.tables) {
    const sample = reservoirSample(table.rowCount, options.sampleSize, options.seed);
    samples.set(name, sample);

    const columns = new Map<string, ColumnStatistics>();
    for (const def of table.columns) {
      columns.set(def.name, analyzeColumn(table, def.name, sample, target));
    }
    tables.set(name, {
      name,
      // Even the row count is an estimate here in principle; the engine knows it
      // exactly, and pretending otherwise would be theatre rather than honesty.
      rowCount: table.rowCount,
      pageCount: table.pageCount,
      rowWidth: table.rowWidth,
      columns,
    });
  }

  const indexes = new Map<string, IndexStatistics>();
  for (const [key, index] of schema.indexes) {
    indexes.set(key, {
      table: index.table, column: index.column,
      entries: index.entries, height: index.height, pages: index.pages,
    });
  }

  return {
    statistics: { tables, indexes, multivariate: [], sampleSize: options.sampleSize },
    samples,
  };
}

export function analyzeColumn(
  table: Table, column: string, sample: Sample, target: number,
): ColumnStatistics {
  const def = table.columns[table.columnIndex(column)];
  const source = table.column(column);
  const sampled: Value[] = sample.rowIds.map((id) => source[id] as Value);
  const n = sampled.length;

  const nulls = sampled.reduce<number>((s, v) => s + (v === null ? 1 : 0), 0);
  const nullFraction = n === 0 ? 0 : nulls / n;

  const { entries: mcv, remainder } = buildMcv(sampled, target);
  const histogram = buildHistogram(remainder, target);

  return {
    table: table.name,
    column,
    type: def.type,
    nullFraction,
    nDistinct: estimateDistinct(sampled, sample),
    mcv,
    histogram,
    correlation: estimateCorrelation(sampled),
    sampleSize: n,
    tableRowCount: table.rowCount,
    averageWidth: def.width,
  };
}

/**
 * Distinct values in the table, estimated from the distinct values in the
 * sample.
 *
 * This is the estimator Postgres uses, from Haas, Naughton, Seshadri and Stokes.
 * A naive count of distinct sample values badly underestimates a
 * high-cardinality column: with 30,000 rows sampled from a million, a column
 * with a million distinct values shows only 30,000 of them. The correction
 * inflates by the share of values seen exactly once.
 *
 * When the sample is the whole table the estimate is exact, and when distinct
 * values scale with the table Postgres records the negative ratio instead.
 */
export function estimateDistinct(sampled: Value[], sample: Sample): number {
  const counts = new Map<string, number>();
  for (const v of sampled) {
    if (v === null) continue;
    const k = `${typeof v}:${String(v)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const d = counts.size;
  const n = sampled.length - sampled.filter((v) => v === null).length;
  const N = sample.populationSize;
  if (d === 0) return 0;
  if (n >= N || n === 0) return d;

  let f1 = 0; // values seen exactly once
  for (const c of counts.values()) if (c === 1) f1++;
  if (f1 === n) {
    // Every sampled value was unique. The column is probably unique overall,
    // which Postgres records as the ratio -1.
    return -1;
  }
  const estimate = d / (1 - (f1 / n) * ((N - n) / N));
  const capped = Math.min(N, Math.max(d, estimate));
  // Above a tenth of the table, record a ratio so the estimate tracks the row
  // count rather than freezing at the value observed at analyze time.
  if (capped > N * 0.1) return -(capped / N);
  return Math.round(capped);
}

/**
 * Physical correlation: Spearman's rank correlation between a column's logical
 * order and its physical order. 1 means the table is stored in that column's
 * order, which makes an index scan nearly sequential.
 */
export function estimateCorrelation(sampled: Value[]): number {
  const present: Array<{ v: Value; physical: number }> = [];
  for (let i = 0; i < sampled.length; i++) {
    if (sampled[i] !== null) present.push({ v: sampled[i], physical: i });
  }
  const n = present.length;
  if (n < 2) return 0;

  const byValue = [...present].sort((a, b) => compareValues(a.v as StoredValue, b.v as StoredValue) || a.physical - b.physical);
  const logicalRank = new Map<number, number>();
  byValue.forEach((e, rank) => logicalRank.set(e.physical, rank));

  // Pearson over ranks, which is Spearman.
  const meanRank = (n - 1) / 2;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const x = i - meanRank;
    const y = logicalRank.get(present[i].physical)! - meanRank;
    cov += x * y; varX += x * x; varY += y * y;
  }
  if (varX === 0 || varY === 0) return 0;
  return clamp(cov / Math.sqrt(varX * varY), -1, 1);
}

/** Scale a sample-measured frequency to a table row count. */
export function toRows(frequency: number, sample: Sample): number {
  return frequency * sample.rowIds.length * scaleFactor(sample);
}

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
