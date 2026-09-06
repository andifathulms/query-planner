/**
 * The histogram (DESIGN.md §5.4, PRD §5.4).
 *
 * One column's statistics in full: the MCV list as labelled bars, the equi-depth
 * histogram as buckets, the null fraction as a segment.
 *
 * The active predicate is overlaid. Partially covered buckets are shown
 * partially covered, the interpolation arithmetic prints beneath so it can be
 * checked by hand, and the predicted selectivity sits beside the measured one as
 * a paired span.
 *
 * This is where "selectivity" stops being a word.
 */
import { useMemo, useState } from 'react';
import { locate } from '../../stats/histogram.js';
import { compareValues } from '../../storage/table.js';
import { estimateExpr } from '../../planner/selectivity.js';
import { makeContext } from '../../planner/cardinality.js';
import { measureExpr, tableFor } from '../../state/truth.js';
import { Span } from '../../ui/Span.js';
import { exact, percent, selectivity as formatSelectivity } from '../../ui/format.js';
import { TraceDetail } from '../../ui/TraceDetail.js';
import { conjoin } from '../../planner/paths.js';
import type { ColumnStatistics, Statistics, Value } from '../../stats/types.js';
import type { QuerySpec, Restriction } from '../../planner/types.js';
import type { Schema } from '../../storage/table.js';
import { DataTable } from '../../ui/DataTable.js';
import { Select } from '../../ui/Select.js';
import './Histogram.css';

const WIDTH = 620;
const BAR_H = 74;

export interface HistogramProps {
  schema: Schema;
  statistics: Statistics;
  spec: QuerySpec | null;
}

export function Histogram({ schema, statistics, spec }: HistogramProps) {
  const columns = useMemo(() => candidateColumns(spec, statistics), [spec, statistics]);
  const [chosen, setChosen] = useState<string | null>(null);
  const active = columns.find((c) => c.key === chosen) ?? columns[0] ?? null;

  if (!spec || !active) {
    return <p className="t-prose histogram-empty">Add a WHERE clause to see a column&rsquo;s statistics.</p>;
  }

  return (
    <div className="histogram">
      <div className="histogram-head">
        <label className="t-small">
          <span className="visually-hidden">Column</span>
          <Select value={active.key} onChange={(e) => setChosen(e.target.value)}>
            {columns.map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
          </Select>
        </label>
        <p className="t-small histogram-summary">
          {exact(active.stat.sampleSize)} rows sampled ·{' '}
          {active.stat.mcv.length} MCV {active.stat.mcv.length === 1 ? 'entry' : 'entries'} ·{' '}
          {Math.max(0, active.stat.histogram.length - 1)} buckets ·{' '}
          {percent(active.stat.nullFraction, 2)} null
        </p>
      </div>

      <ColumnChart stat={active.stat} restrictions={active.restrictions} />

      <DataTable
        caption={`${active.key} statistics`}
        columns={['entry', 'kind', 'frequency']}
        rows={[
          ...active.stat.mcv.map((e) => [String(e.value), 'most common value', percent(e.frequency, 3)]),
          ...active.stat.histogram.slice(0, -1).map((low, i) => [
            `${String(low)} … ${String(active.stat.histogram[i + 1])}`,
            `bucket ${i + 1}`,
            percent(
              Math.max(0, 1 - active.stat.mcv.reduce((s, e) => s + e.frequency, 0) - active.stat.nullFraction)
                / Math.max(1, active.stat.histogram.length - 1),
              3,
            ),
          ]),
          ['NULL', 'null fraction', percent(active.stat.nullFraction, 3)],
        ]}
      />

      <Comparison
        schema={schema}
        statistics={statistics}
        spec={spec}
        stat={active.stat}
        alias={active.alias}
        restrictions={active.restrictions}
      />
    </div>
  );
}

/** The MCV list, the histogram buckets, and the null fraction, on one axis. */
function ColumnChart({
  stat, restrictions,
}: { stat: ColumnStatistics; restrictions: Restriction[] }) {
  const mcvTotal = stat.mcv.reduce((s, e) => s + e.frequency, 0);
  const buckets = Math.max(0, stat.histogram.length - 1);
  const histogramShare = Math.max(0, 1 - mcvTotal - stat.nullFraction);

  // Coverage of each bucket by the predicate, computed from the same histogram
  // the estimator read.
  const coverage = useMemo(
    () => bucketCoverage(stat, restrictions),
    [stat, restrictions],
  );

  const mcvWidth = mcvTotal * WIDTH;
  const nullWidth = stat.nullFraction * WIDTH;
  const histogramWidth = histogramShare * WIDTH;

  return (
    <div className="histogram-chart scroll-x">
      <svg width={WIDTH} height={BAR_H + 26} role="img"
        aria-label={`Statistics for ${stat.table}.${stat.column}`}
      >
        {/* Most-common values, widths in proportion to their frequencies. */}
        <g>
          {stat.mcv.slice(0, 40).map((entry, i) => {
            const x = stat.mcv.slice(0, i).reduce((s, e) => s + e.frequency, 0) * WIDTH;
            const w = entry.frequency * WIDTH;
            const covered = restrictions.length > 0 && coverage.mcvMatches.has(String(entry.value));
            return (
              <g key={String(entry.value)}>
                <title>{`${String(entry.value)}: ${percent(entry.frequency, 2)}`}</title>
                <rect
                  className={`histogram-mcv${covered ? ' is-covered' : ''}`}
                  x={x} y={10} width={Math.max(w - 0.5, 0.5)} height={BAR_H - 20}
                />
              </g>
            );
          })}
          {mcvWidth > 30 && (
            <text className="t-micro histogram-axis" x={0} y={6}>
              MCV · {percent(mcvTotal, 1)}
            </text>
          )}
        </g>

        {/* Equi-depth buckets: equal counts, so equal widths. The partially
            covered one is drawn partially covered. */}
        <g transform={`translate(${mcvWidth}, 0)`}>
          {Array.from({ length: buckets }, (_, i) => {
            const w = histogramWidth / buckets;
            const cover = coverage.buckets[i] ?? 0;
            return (
              <g key={i} transform={`translate(${i * w}, 0)`}>
                <title>
                  {`bucket ${i + 1}: ${String(stat.histogram[i])} to ${String(stat.histogram[i + 1])}`
                    + (cover > 0 ? `, ${percent(cover, 1)} covered` : '')}
                </title>
                <rect className="histogram-bucket" x={0} y={10} width={Math.max(w - 0.4, 0.4)} height={BAR_H - 20} />
                {cover > 0 && (
                  <rect className="histogram-bucket is-covered" x={0} y={10} width={Math.max(w * cover - 0.4, 0.4)} height={BAR_H - 20} />
                )}
              </g>
            );
          })}
          {histogramWidth > 60 && (
            <text className="t-micro histogram-axis" x={0} y={6}>
              histogram · {buckets} buckets
            </text>
          )}
        </g>

        {/* The null fraction is part of the column and is drawn as part of it. */}
        {nullWidth > 0 && (
          <g transform={`translate(${mcvWidth + histogramWidth}, 0)`}>
            <title>{`null: ${percent(stat.nullFraction, 2)}`}</title>
            <rect className="histogram-null" x={0} y={10} width={Math.max(nullWidth, 1)} height={BAR_H - 20} />
          </g>
        )}

        <line x1={0} y1={BAR_H - 10} x2={WIDTH} y2={BAR_H - 10} stroke="var(--line)" />
      </svg>
    </div>
  );
}

/**
 * Predicted selectivity against measured selectivity, as a paired span, with the
 * trace that produced the prediction.
 */
function Comparison({
  schema, statistics, spec, stat, alias, restrictions,
}: {
  schema: Schema;
  statistics: Statistics;
  spec: QuerySpec;
  stat: ColumnStatistics;
  alias: string;
  restrictions: Restriction[];
}) {
  const result = useMemo(() => {
    if (restrictions.length === 0) return null;
    const table = tableFor(schema, spec, alias);
    if (!table) return null;
    const expr = conjoin(restrictions.map((r) => r.expr));
    const estimate = estimateExpr(expr, makeContext(spec, statistics));
    const measured = measureExpr(table, expr) / Math.max(1, table.rowCount);
    return { estimate, measured, rowCount: table.rowCount };
  }, [schema, statistics, spec, alias, restrictions]);

  if (!result) {
    return <p className="t-prose histogram-empty">No predicate on this column.</p>;
  }

  const predictedRows = result.estimate.selectivity * result.rowCount;
  const measuredRows = result.measured * result.rowCount;

  return (
    <div className="histogram-comparison">
      <div className="histogram-pair">
        <svg width={280} height={16} aria-hidden="true">
          <Span
            believed={Math.max(1, predictedRows)}
            actual={Math.max(1, measuredRows)}
            min={1}
            max={Math.max(10, result.rowCount)}
            width={272}
            height={14}
          />
        </svg>
        <p className="t-small">
          predicted {formatSelectivity(result.estimate.selectivity)} ({exact(predictedRows)} rows)
          {' · '}
          measured {formatSelectivity(result.measured)} ({exact(measuredRows)} rows)
        </p>
      </div>

      {/* The arithmetic prints so it can be checked by hand (§5.4). */}
      <TraceDetail trace={result.estimate.trace} />
      <p className="t-prose histogram-note">
        The prediction comes from a sample of {exact(stat.sampleSize)} rows. The measurement
        scans all {exact(result.rowCount)}.
      </p>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ColumnChoice {
  key: string;
  alias: string;
  column: string;
  stat: ColumnStatistics;
  restrictions: Restriction[];
}

/**
 * Columns worth offering: the ones the query constrains first, then the rest of
 * the relations in scope.
 */
function candidateColumns(spec: QuerySpec | null, statistics: Statistics): ColumnChoice[] {
  if (!spec) return [];
  const out: ColumnChoice[] = [];
  const seen = new Set<string>();

  const add = (alias: string, table: string, column: string): void => {
    const key = `${alias}.${column}`;
    if (seen.has(key)) return;
    const stat = statistics.tables.get(table)?.columns.get(column);
    if (!stat) return;
    seen.add(key);
    out.push({
      key, alias, column, stat,
      restrictions: spec.restrictions.filter(
        (r) => r.relation === alias && mentions(r, column),
      ),
    });
  };

  for (const restriction of spec.restrictions) {
    const relation = spec.relations.find((r) => r.alias === restriction.relation);
    if (!relation) continue;
    for (const column of columnsOf(restriction)) add(relation.alias, relation.table, column);
  }
  for (const relation of spec.relations) {
    for (const column of statistics.tables.get(relation.table)?.columns.keys() ?? []) {
      add(relation.alias, relation.table, column);
    }
  }
  return out;
}

function columnsOf(restriction: Restriction): string[] {
  const out: string[] = [];
  const walk = (e: typeof restriction.expr): void => {
    switch (e.kind) {
      case 'column': out.push(e.name); break;
      case 'binary': walk(e.left); walk(e.right); break;
      case 'unary': walk(e.operand); break;
      case 'between': walk(e.operand); walk(e.low); walk(e.high); break;
      case 'in': walk(e.operand); e.values.forEach(walk); break;
      case 'isnull': walk(e.operand); break;
      default: break;
    }
  };
  walk(restriction.expr);
  return out;
}

function mentions(restriction: Restriction, column: string): boolean {
  return columnsOf(restriction).includes(column);
}

/**
 * How much of each bucket the predicate covers, and which MCV entries it takes.
 *
 * Derived from the same histogram the estimator read, so what is drawn is what
 * was computed rather than a second opinion about it.
 */
function bucketCoverage(stat: ColumnStatistics, restrictions: Restriction[]): {
  buckets: number[];
  mcvMatches: Set<string>;
} {
  const buckets = Math.max(0, stat.histogram.length - 1);
  const coverage = new Array<number>(buckets).fill(0);
  const mcvMatches = new Set<string>();
  if (restrictions.length === 0) return { buckets: coverage, mcvMatches };

  const bounds = boundsOf(restrictions, stat.column);
  if (!bounds) {
    // An equality or an IN: mark the exact values rather than a range.
    for (const value of equalityValues(restrictions, stat.column)) {
      if (stat.mcv.some((e) => compareValues(e.value, value) === 0)) {
        mcvMatches.add(String(value));
      } else if (buckets > 0) {
        const position = locate(stat.histogram, value);
        if (position.bucket >= 0 && position.bucket < buckets) {
          // A single value inside a bucket: a sliver, drawn as one.
          coverage[position.bucket] = Math.max(coverage[position.bucket], 0.08);
        }
      }
    }
    return { buckets: coverage, mcvMatches };
  }

  for (const entry of stat.mcv) {
    if (withinBounds(entry.value, bounds)) mcvMatches.add(String(entry.value));
  }

  const low = bounds.low === null ? 0 : locate(stat.histogram, bounds.low).fraction;
  const high = bounds.high === null ? 1 : locate(stat.histogram, bounds.high).fraction;
  for (let i = 0; i < buckets; i++) {
    const start = i / buckets;
    const end = (i + 1) / buckets;
    const overlap = Math.min(end, high) - Math.max(start, low);
    coverage[i] = Math.max(0, overlap) / (end - start);
  }
  return { buckets: coverage, mcvMatches };
}

interface Bounds { low: Value | null; high: Value | null }

function boundsOf(restrictions: Restriction[], column: string): Bounds | null {
  let low: Value | null = null;
  let high: Value | null = null;
  let found = false;

  for (const restriction of restrictions) {
    const e = restriction.expr;
    if (e.kind === 'between' && e.operand.kind === 'column' && e.operand.name === column
      && e.low.kind === 'literal' && e.high.kind === 'literal' && !e.negated) {
      low = e.low.value; high = e.high.value; found = true;
      continue;
    }
    if (e.kind !== 'binary') continue;
    const side = e.left.kind === 'column' && e.left.name === column && e.right.kind === 'literal'
      ? { value: e.right.value, op: e.op }
      : e.right.kind === 'column' && e.right.name === column && e.left.kind === 'literal'
        ? { value: e.left.value, op: flipOp(e.op) }
        : null;
    if (!side) continue;
    if (side.op === '>' || side.op === '>=') { low = side.value; found = true; }
    if (side.op === '<' || side.op === '<=') { high = side.value; found = true; }
  }
  return found ? { low, high } : null;
}

function equalityValues(restrictions: Restriction[], column: string): Value[] {
  const out: Value[] = [];
  for (const restriction of restrictions) {
    const e = restriction.expr;
    if (e.kind === 'binary' && e.op === '=') {
      if (e.left.kind === 'column' && e.left.name === column && e.right.kind === 'literal') out.push(e.right.value);
      if (e.right.kind === 'column' && e.right.name === column && e.left.kind === 'literal') out.push(e.left.value);
    }
    if (e.kind === 'in' && e.operand.kind === 'column' && e.operand.name === column && !e.negated) {
      for (const v of e.values) if (v.kind === 'literal') out.push(v.value);
    }
  }
  return out;
}

function withinBounds(value: Value, bounds: Bounds): boolean {
  if (bounds.low !== null && compareValues(value, bounds.low) < 0) return false;
  if (bounds.high !== null && compareValues(value, bounds.high) > 0) return false;
  return true;
}

function flipOp(op: string): string {
  return op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : op === '>=' ? '<=' : op;
}
