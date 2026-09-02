/**
 * The statistics boundary (CLAUDE.md §1).
 *
 * This is the ONLY thing `src/planner/` may read. A planner that can peek at the
 * truth is not a planner, so the boundary is a type here and a lint rule in
 * eslint.config.js, and both matter.
 */

export type Value = string | number | boolean | null;

export interface McvEntry {
  value: Value;
  frequency: number;
}

export interface ColumnStatistics {
  table: string;
  column: string;
  type: 'int' | 'float' | 'text' | 'bool';
  nullFraction: number;
  /** Negative means a ratio of the row count, as Postgres records it. */
  nDistinct: number;
  mcv: McvEntry[];
  /** Equi-depth bucket boundaries: `histogram.length - 1` buckets of equal count. */
  histogram: Value[];
  /** Logical versus physical ordering, -1..1. */
  correlation: number;
  sampleSize: number;
  /** Itself an estimate, scaled up from the sample. */
  tableRowCount: number;
  /** Average stored width in bytes. Feeds row width up the plan. */
  averageWidth: number;
}

export interface MultivariateStatistics {
  table: string;
  columns: string[];
  kinds: MultivariateKind[];
  /** "a=>b" → degree 0..1. */
  dependencies?: Map<string, number>;
  /** "a,b" → distinct combinations. */
  nDistinct?: Map<string, number>;
  mcv?: Array<{
    values: Value[];
    frequency: number;
    /** What independence would have predicted. The recovery view draws both. */
    baseFrequency: number;
  }>;
  /** Bytes, so the recovery view can state what each statistic costs to store. */
  storageBytes: number;
}

export type MultivariateKind = 'dependencies' | 'ndistinct' | 'mcv';

export interface IndexStatistics {
  table: string;
  column: string;
  entries: number;
  height: number;
  pages: number;
}

export interface TableStatistics {
  name: string;
  rowCount: number;
  pageCount: number;
  rowWidth: number;
  columns: Map<string, ColumnStatistics>;
}

/** Everything the planner is allowed to know. */
export interface Statistics {
  tables: Map<string, TableStatistics>;
  indexes: Map<string, IndexStatistics>;
  multivariate: MultivariateStatistics[];
  /** How many rows each sample saw, for the honesty note in the sample view. */
  sampleSize: number;
}

/** Resolve Postgres's negative-nDistinct convention against a row count. */
export function distinctCount(stat: ColumnStatistics, rows = stat.tableRowCount): number {
  const n = stat.nDistinct < 0 ? -stat.nDistinct * rows : stat.nDistinct;
  return Math.max(1, n);
}

export function mcvTotal(stat: ColumnStatistics): number {
  return stat.mcv.reduce((s, e) => s + e.frequency, 0);
}

export function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}
