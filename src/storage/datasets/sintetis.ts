/**
 * The synthetic dataset: two columns whose correlation is exactly the slider.
 *
 * The wilayah schema is for credibility; this one is for control. `a` and `b`
 * are categorical with known cardinalities and a dependency degree set directly,
 * so the correlation plot's rectangle can be swept from detached to landed
 * without any confounding structure (PRD §4.7, DESIGN.md §5.3).
 */
import type { Table } from '../table.js';
import type { BTreeIndex } from '../btree.js';
import type { Value } from '../table.js';
import { correlatedCategory, generatorRng, physicallyCluster, zipfSampler, type GeneratorParams } from '../generator.js';
import { buildIndexes, fromRows } from './wilayah.js';

const A_DISTINCT = 100;
const B_DISTINCT = 40;

export function buildSintetis(params: GeneratorParams): { tables: Map<string, Table>; indexes: Map<string, BTreeIndex> } {
  const n = Math.max(1000, Math.round(params.rows));
  const rng = generatorRng(params, 'sintetis');
  const pickA = zipfSampler(A_DISTINCT, params.zipf, rng);
  const aValues = Array.from({ length: n }, () => pickA());
  const bValues = correlatedCategory(aValues, B_DISTINCT, params.correlation, rng);

  interface Row { a: number; b: number; c: number; x: number }
  let rows: Row[] = aValues.map((a, i) => ({
    a,
    b: bValues[i],
    c: rng.int(1000),
    x: Math.round(rng.normal() * 1000) / 10,
  }));
  rows = physicallyCluster(rows, (r) => r.a, params.correlation, rng);

  const fakta = fromRows('fakta', [
    { name: 'id', type: 'int', width: 4 },
    { name: 'a', type: 'int', width: 4 },
    { name: 'b', type: 'int', width: 4 },
    { name: 'c', type: 'int', width: 4 },
    { name: 'x', type: 'float', width: 8 },
  ], rows.map((r, i) => [i, r.a, r.b, r.c, r.x] as Value[]));

  // A small dimension to join against, so the synthetic dataset can still
  // exercise join selectivity and a two-table lattice.
  const dim = fromRows('dim', [
    { name: 'id', type: 'int', width: 4 },
    { name: 'label', type: 'text', width: 10 },
    { name: 'bucket', type: 'int', width: 4 },
  ], Array.from({ length: A_DISTINCT }, (_, i) => [i, `a${i}`, i % 7] as Value[]));

  const tables = new Map<string, Table>([['fakta', fakta], ['dim', dim]]);
  return {
    tables,
    indexes: buildIndexes(tables, ['fakta.id', 'fakta.a', 'fakta.b', 'fakta.c', 'dim.id', 'dim.bucket']),
  };
}
