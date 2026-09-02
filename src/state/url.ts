/**
 * URL serialisation (CLAUDE.md §9).
 *
 * Everything except the current selection round-trips through the hash, so a
 * surprising plan is a link. Keys are short because a query is already long, and
 * every value that equals its default is omitted so an ordinary link stays
 * readable.
 */
import { DEFAULT_COST_PARAMS, type CostParams } from '../planner/types.js';
import type { DatasetId } from '../storage/datasets/index.js';
import type { MultivariateKind } from '../stats/types.js';
import type { MultivariateSpec } from '../stats/multivariate/index.js';
import {
  DEFAULT_GENERATOR, DEFAULT_SAMPLE_SIZE, EXAMPLE_QUERY, type AppState,
} from './types.js';

export function defaultState(): AppState {
  return {
    sql: EXAMPLE_QUERY,
    dataset: 'wilayah',
    generator: { ...DEFAULT_GENERATOR },
    costParams: { ...DEFAULT_COST_PARAMS },
    sampleSize: DEFAULT_SAMPLE_SIZE,
    multivariate: [],
    seed: 1,
    allowCartesian: false,
    selected: { cell: null, node: null, instrument: 'correlation' },
  };
}

const COST_KEYS: Array<[keyof CostParams, string]> = [
  ['seq_page_cost', 'spc'],
  ['random_page_cost', 'rpc'],
  ['cpu_tuple_cost', 'ctc'],
  ['cpu_index_tuple_cost', 'citc'],
  ['cpu_operator_cost', 'coc'],
  ['work_mem', 'wm'],
  ['effective_cache_size', 'ecs'],
];

export function encodeState(state: AppState): string {
  const p = new URLSearchParams();
  const base = defaultState();

  if (state.sql !== base.sql) p.set('q', state.sql);
  if (state.dataset !== base.dataset) p.set('d', state.dataset);
  if (state.generator.rows !== base.generator.rows) p.set('n', String(state.generator.rows));
  if (state.generator.correlation !== base.generator.correlation) {
    p.set('r', state.generator.correlation.toFixed(3));
  }
  if (state.generator.zipf !== base.generator.zipf) p.set('z', state.generator.zipf.toFixed(3));
  if (state.sampleSize !== base.sampleSize) p.set('s', String(state.sampleSize));
  if (state.seed !== base.seed) p.set('seed', String(state.seed));
  if (state.allowCartesian) p.set('cart', '1');

  for (const [key, short] of COST_KEYS) {
    if (state.costParams[key] !== base.costParams[key]) {
      p.set(short, String(state.costParams[key]));
    }
  }

  if (state.multivariate.length > 0) {
    // table:col1,col2:kind+kind — one statistic per semicolon-separated group.
    p.set('mv', state.multivariate
      .map((m) => `${m.table}:${m.columns.join(',')}:${m.kinds.join('+')}`)
      .join(';'));
  }

  return p.toString();
}

export function decodeState(search: string): AppState {
  const state = defaultState();
  const p = new URLSearchParams(search);
  if (p.toString() === '') return state;

  const sql = p.get('q');
  if (sql) state.sql = sql;

  const dataset = p.get('d');
  if (dataset === 'wilayah' || dataset === 'sintetis') state.dataset = dataset as DatasetId;

  state.generator.rows = clampInt(p.get('n'), state.generator.rows, 1000, 2_000_000);
  state.generator.correlation = clampNumber(p.get('r'), state.generator.correlation, 0, 1);
  state.generator.zipf = clampNumber(p.get('z'), state.generator.zipf, 0, 2);
  state.sampleSize = clampInt(p.get('s'), state.sampleSize, 100, 500_000);
  state.seed = clampInt(p.get('seed'), state.seed, 0, 2 ** 31);
  state.allowCartesian = p.get('cart') === '1';

  for (const [key, short] of COST_KEYS) {
    // A cost parameter of zero or below would make plans free and the search
    // meaningless, so the floor is above zero rather than at it.
    state.costParams[key] = clampNumber(p.get(short), state.costParams[key], 1e-6, 1e12);
  }

  const mv = p.get('mv');
  if (mv) state.multivariate = parseMultivariate(mv);

  return state;
}

const KINDS = new Set<string>(['dependencies', 'ndistinct', 'mcv']);

function parseMultivariate(raw: string): MultivariateSpec[] {
  const out: MultivariateSpec[] = [];
  for (const group of raw.split(';')) {
    const [table, columns, kinds] = group.split(':');
    if (!table || !columns || !kinds) continue;
    const parsedKinds = kinds.split('+').filter((k) => KINDS.has(k)) as MultivariateKind[];
    const parsedColumns = columns.split(',').filter(Boolean);
    if (parsedKinds.length === 0 || parsedColumns.length < 2) continue;
    out.push({ table, columns: parsedColumns, kinds: parsedKinds });
  }
  return out;
}

function clampNumber(raw: string | null, fallback: number, lo: number, hi: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  return Math.round(clampNumber(raw, fallback, lo, hi));
}
