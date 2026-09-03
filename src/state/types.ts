/**
 * Application state (CLAUDE.md §9).
 *
 * Everything except `selected` serialises to the URL. A surprising plan must be
 * reproducible from a link — that is how someone shares a counterexample.
 */
import type { CostParams } from '../planner/types.js';
import type { DatasetId } from '../storage/datasets/index.js';
import type { MultivariateSpec } from '../stats/multivariate/index.js';

export interface GeneratorSettings {
  rows: number;
  correlation: number;
  zipf: number;
}

export interface AppState {
  sql: string;
  dataset: DatasetId;
  generator: GeneratorSettings;
  costParams: CostParams;
  sampleSize: number;
  /** Statistics the user has created. */
  multivariate: MultivariateSpec[];
  seed: number;
  allowCartesian: boolean;
  /** Not serialised: a selection is a view of state, not state. */
  selected: { cell: string | null; node: string | null; instrument: InstrumentId };
}

export type InstrumentId =
  | 'correlation' | 'histogram' | 'sample' | 'timeline' | 'recovery';

export const INSTRUMENTS: Array<{ id: InstrumentId; label: string }> = [
  { id: 'correlation', label: 'correlation' },
  { id: 'histogram', label: 'histogram' },
  { id: 'sample', label: 'sample' },
  { id: 'timeline', label: 'timeline' },
  { id: 'recovery', label: 'recovery' },
];

/**
 * The empty state: a dataset loaded and the correlated-predicate query
 * pre-filled, because it produces the app's best result on first run
 * (DESIGN.md §7).
 */
export const EXAMPLE_QUERY = `SELECT k.nama, k.penduduk
FROM kelurahan k
WHERE k.kota = 'Kupang'
  AND k.provinsi = 'Nusa Tenggara Timur'`;

export const EXAMPLES: Array<{ label: string; sql: string; note: string }> = [
  {
    label: 'correlated predicates',
    sql: EXAMPLE_QUERY,
    note: 'Each predicate matches about one row in a hundred, so independence predicts one in ten thousand. The truth is one in a hundred, because the second condition adds nothing once the first holds.',
  },
  {
    label: 'the same error, damped',
    sql: `SELECT k.nama, k.penduduk
FROM kelurahan k
WHERE k.kota = 'Balikpapan'
  AND k.provinsi = 'Kalimantan Timur'`,
    note: 'Kalimantan Timur holds three cities rather than one, so knowing the city still narrows the province but does not fix it. The same failure, an order of magnitude smaller.',
  },
  {
    label: 'the lattice, six tables',
    sql: `SELECT p.pekerjaan, k.nama, c.nama, b.nama, v.nama
FROM penduduk p
JOIN kelurahan k ON p.kelurahan_id = k.id
JOIN kecamatan c ON k.kecamatan_id = c.id
JOIN kabupaten b ON c.kabupaten_id = b.id
JOIN provinsi v ON b.provinsi_id = v.id
WHERE k.kota = 'Surabaya'`,
    note: 'Five relations, 31 subsets. Watch the search fill level by level and the winner descend into the tree.',
  },
  {
    label: 'the plan flip',
    sql: `SELECT p.pekerjaan, p.pendapatan
FROM penduduk p
WHERE p.umur = 40`,
    note: 'Drag random_page_cost from 4.0 to 1.1 and the sequential scan becomes an index scan.',
  },
  {
    label: 'why LIMIT changes the plan',
    sql: `SELECT p.pekerjaan, k.nama
FROM penduduk p
JOIN kelurahan k ON p.kelurahan_id = k.id
ORDER BY p.kelurahan_id
LIMIT 10`,
    note: 'A pipelining plan can beat a cheaper blocking one, because LIMIT selects on startup cost.',
  },
  {
    label: 'grouping over correlated columns',
    sql: `SELECT k.kota, k.provinsi, count(*)
FROM kelurahan k
GROUP BY k.kota, k.provinsi`,
    note: 'Independence multiplies the distinct counts. Multivariate n-distinct counts the combinations instead.',
  },
  {
    label: 'a range and a histogram',
    sql: `SELECT p.pekerjaan
FROM penduduk p
WHERE p.pendapatan BETWEEN 3000000 AND 5000000`,
    note: 'A range predicate located in the histogram, with the interpolation shown.',
  },
];

export const DEFAULT_GENERATOR: GeneratorSettings = {
  rows: 120_000,
  correlation: 0.95,
  zipf: 0.8,
};

/** Postgres's default_statistics_target implies about this many rows. */
export const DEFAULT_SAMPLE_SIZE = 30_000;
