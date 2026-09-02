/**
 * The bridge between state and engine.
 *
 * Everything expensive is memoised on the inputs that actually affect it, in
 * layers: the dataset depends on the generator, the statistics on the dataset
 * and the sample, the plan on the statistics and the cost parameters. Dragging
 * `random_page_cost` therefore re-plans without regenerating a million rows,
 * which is what the 200 ms budget is for (CLAUDE.md §8).
 */
import { buildDataset, type DatasetId } from '../storage/datasets/index.js';
import type { Schema } from '../storage/table.js';
import { analyze, DEFAULT_STATISTICS_TARGET } from '../stats/column.js';
import type { Sample } from '../stats/sample.js';
import { createMultivariate, specKey, type MultivariateSpec } from '../stats/multivariate/index.js';
import type { Statistics } from '../stats/types.js';
import { parse, SqlError } from '../parser/parser.js';
import { resolveQuery, PlanningError } from '../planner/resolve.js';
import { enumerate, type EnumerationResult } from '../planner/selinger.js';
import { execute, type ExecutionResult } from '../executor/execute.js';
import type { CostParams, QuerySpec } from '../planner/types.js';
import type { AppState, GeneratorSettings } from './types.js';

export interface DatasetBundle {
  schema: Schema;
  statistics: Statistics;
  samples: Map<string, Sample>;
}

/** Cache one dataset and one statistics bundle; the inputs change one at a time. */
let datasetCache: { key: string; schema: Schema } | null = null;
let statsCache: { key: string; bundle: DatasetBundle } | null = null;

function generatorKey(dataset: DatasetId, g: GeneratorSettings, seed: number): string {
  return `${dataset}|${g.rows}|${g.correlation}|${g.zipf}|${seed}`;
}

export function getSchema(dataset: DatasetId, g: GeneratorSettings, seed: number): Schema {
  const key = generatorKey(dataset, g, seed);
  if (datasetCache?.key === key) return datasetCache.schema;
  const schema = buildDataset(dataset, { ...g, seed });
  datasetCache = { key, schema };
  return schema;
}

/**
 * Statistics, including whatever multivariate statistics the user has created.
 *
 * The multivariate statistics are attached to a copy of the bundle rather than
 * recollected, so creating one does not re-sample the tables — the recovery view
 * must change one thing at a time for its before-and-after to mean anything.
 */
export function getStatistics(state: AppState): DatasetBundle {
  const schema = getSchema(state.dataset, state.generator, state.seed);
  const key = `${generatorKey(state.dataset, state.generator, state.seed)}|${state.sampleSize}`;

  let bundle = statsCache?.key === key ? statsCache.bundle : null;
  if (!bundle) {
    const { statistics, samples } = analyze(schema, {
      sampleSize: state.sampleSize, seed: state.seed,
    });
    bundle = { schema, statistics, samples };
    statsCache = { key, bundle };
  }

  const multivariate = state.multivariate
    .map((spec) => buildMultivariate(schema, bundle.samples, spec))
    .filter((m) => m !== null);

  return {
    schema: bundle.schema,
    samples: bundle.samples,
    statistics: { ...bundle.statistics, multivariate },
  };
}

const multivariateCache = new Map<string, ReturnType<typeof createMultivariate>>();

function buildMultivariate(
  schema: Schema, samples: Map<string, Sample>, spec: MultivariateSpec,
) {
  const sample = samples.get(spec.table);
  if (!sample) return null;
  const key = `${specKey(spec)}|${sample.populationSize}|${sample.rowIds.length}|${sample.seed}`;
  const hit = multivariateCache.get(key);
  if (hit) return hit;
  try {
    const stat = createMultivariate(schema, sample, spec, DEFAULT_STATISTICS_TARGET);
    multivariateCache.set(key, stat);
    return stat;
  } catch {
    // A statistic naming a column that does not exist in this dataset. Dropping
    // it is better than refusing to plan; the interface will not offer it again.
    return null;
  }
}

// ── Planning and execution ───────────────────────────────────────────────────

export interface EngineError {
  message: string;
  /** Character offsets into the SQL, for underlining the offending token. */
  start?: number;
  end?: number;
  line?: number;
  column?: number;
}

export interface EngineResult {
  bundle: DatasetBundle;
  spec: QuerySpec | null;
  planning: EnumerationResult | null;
  execution: ExecutionResult | null;
  error: EngineError | null;
}

export function runQuery(state: AppState, options: { execute?: boolean } = {}): EngineResult {
  const bundle = getStatistics(state);
  const base = { bundle, spec: null, planning: null, execution: null };

  let spec: QuerySpec;
  try {
    spec = resolveQuery(parse(state.sql), bundle.statistics);
  } catch (e) {
    return { ...base, error: toEngineError(e) };
  }

  let planning: EnumerationResult;
  try {
    planning = enumerate(spec, bundle.statistics, {
      params: state.costParams,
      allowCartesian: state.allowCartesian,
    });
  } catch (e) {
    return { ...base, spec, error: toEngineError(e) };
  }

  if (options.execute === false) {
    return { bundle, spec, planning, execution: null, error: null };
  }

  try {
    const execution = execute(planning.winner, spec, bundle.schema, {
      params: state.costParams,
      // The result grid shows a window, not a million rows. The plan still runs
      // to completion above this — only the materialised output is capped.
      maxRows: 500,
    });
    return { bundle, spec, planning, execution, error: null };
  } catch (e) {
    return { bundle, spec, planning, execution: null, error: toEngineError(e) };
  }
}

function toEngineError(e: unknown): EngineError {
  if (e instanceof SqlError) {
    return { message: e.message, start: e.start, end: e.end, line: e.line, column: e.column };
  }
  if (e instanceof PlanningError) return { message: e.message };
  return { message: e instanceof Error ? e.message : String(e) };
}

export { specKey };
export type { CostParams };
