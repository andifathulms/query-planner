/**
 * Creating and dropping multivariate statistics, as `CREATE STATISTICS`.
 *
 * Each kind reports what it costs to store, because the recovery view states
 * what each repair is worth and what it is paid for (PRD §5.8).
 */
import type { Schema } from '../../storage/table.js';
import type { Sample } from '../sample.js';
import type { MultivariateKind, MultivariateStatistics, Value } from '../types.js';
import { computeDependencies } from './dependencies.js';
import { computeNDistinct } from './ndistinct.js';
import { computeMultiMcv } from './mcv-multi.js';

export interface MultivariateSpec {
  table: string;
  columns: string[];
  kinds: MultivariateKind[];
}

export function specKey(spec: MultivariateSpec): string {
  return `${spec.table}(${spec.columns.join(',')}):${[...spec.kinds].sort().join('+')}`;
}

export function createMultivariate(
  schema: Schema, sample: Sample, spec: MultivariateSpec, target: number,
): MultivariateStatistics {
  const table = schema.tables.get(spec.table);
  if (!table) throw new Error(`Table ${spec.table} does not exist`);

  const rows: Value[][] = spec.columns.map((c) => {
    const source = table.column(c);
    return sample.rowIds.map((id) => source[id] as Value);
  });

  const stat: MultivariateStatistics = {
    table: spec.table,
    columns: [...spec.columns],
    kinds: [...spec.kinds],
    storageBytes: 0,
  };

  if (spec.kinds.includes('dependencies')) {
    stat.dependencies = computeDependencies(spec.columns, rows);
  }
  if (spec.kinds.includes('ndistinct')) {
    stat.nDistinct = computeNDistinct(spec.columns, rows, sample);
  }
  if (spec.kinds.includes('mcv')) {
    stat.mcv = computeMultiMcv(rows, target);
  }
  stat.storageBytes = storageBytes(stat);
  return stat;
}

/**
 * Storage cost, in bytes.
 *
 * Dependencies and n-distinct are a handful of numbers regardless of table size.
 * A multivariate MCV list carries every listed combination's values, so it is
 * two orders of magnitude larger — which is exactly the trade the recovery view
 * asks the reader to weigh.
 */
export function storageBytes(stat: MultivariateStatistics): number {
  let bytes = 64; // catalogue row
  if (stat.dependencies) bytes += stat.dependencies.size * 24;
  if (stat.nDistinct) bytes += stat.nDistinct.size * 24;
  if (stat.mcv) {
    for (const e of stat.mcv) {
      bytes += 16; // the two frequencies
      for (const v of e.values) bytes += typeof v === 'string' ? v.length + 4 : 8;
    }
  }
  return bytes;
}

/** What each kind repairs. The recovery view prints this beside each row. */
export const REPAIRS: Record<MultivariateKind, string> = {
  dependencies: 'Equality conjunctions on correlated columns.',
  ndistinct: 'Group counts over correlated columns, which size a hash aggregate.',
  mcv: 'The general case, including ranges and inequalities, at the largest cost.',
};

export const KIND_LABELS: Record<MultivariateKind, string> = {
  dependencies: 'dependencies',
  ndistinct: 'ndistinct',
  mcv: 'mcv',
};
