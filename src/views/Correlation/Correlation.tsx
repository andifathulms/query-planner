/**
 * The correlation plot (DESIGN.md §5.3, PRD §5.3).
 *
 * Two predicate columns as a scatter, with the independence assumption drawn on
 * top as the rectangle it implies: the product of two marginal selectivities.
 *
 * The gap between that rectangle and the actual point cloud is the estimation
 * error, as area. It is the app's thesis as a single picture, and sweeping the
 * correlation slider from 0 to 1 and watching the rectangle detach from the
 * cloud is a five-second explanation of the whole subject.
 *
 * When a multivariate statistic exists, a second solid rectangle appears showing
 * what it predicts, and it lands on the cloud.
 */
import { useMemo } from 'react';
import { compareValues } from '../../storage/table.js';
import { estimateExpr } from '../../planner/selectivity.js';
import { makeContext } from '../../planner/cardinality.js';
import { compilePredicate, distinctValues, measureExpr, scatter, tableFor } from '../../state/truth.js';
import { conjoin } from '../../planner/paths.js';
import { exact, percent, selectivity as formatSelectivity } from '../../ui/format.js';
import { TraceDetail } from '../../ui/TraceDetail.js';
import type { Statistics, Value } from '../../stats/types.js';
import type { QuerySpec, Restriction } from '../../planner/types.js';
import type { Schema, Table } from '../../storage/table.js';
import { DataTable } from '../../ui/DataTable.js';
import './Correlation.css';

const PLOT = 340;
const PAD = 28;

export interface CorrelationProps {
  schema: Schema;
  statistics: Statistics;
  spec: QuerySpec | null;
  correlation: number;
  onCorrelation: (value: number) => void;
}

export function Correlation({
  schema, statistics, spec, correlation, onCorrelation,
}: CorrelationProps) {
  const pair = useMemo(() => choosePair(spec), [spec]);
  const table = pair && spec ? tableFor(schema, spec, pair.alias) : null;

  const model = useMemo(() => {
    if (!spec || !pair || !table) return null;
    return buildModel(statistics, spec, pair, table);
  }, [statistics, spec, pair, table]);

  return (
    <div className="correlation">
      <div className="correlation-controls">
        <label className="correlation-slider t-small">
          <span>generator correlation</span>
          <input
            type="range"
            className="range"
            min={0}
            max={1}
            step={0.01}
            value={correlation}
            aria-valuetext={correlation.toFixed(2)}
            onChange={(e) => onCorrelation(Number(e.target.value))}
          />
          <output className="t-data">{correlation.toFixed(2)}</output>
        </label>
        {/* "Selectivity" appears in this interface more than fifty times and was
            defined nowhere. Defined here, next to the first place a reader meets
            it as a number, rather than in a glossary they would have to go find. */}
        <p className="t-prose correlation-define">
          Selectivity is the fraction of rows a condition keeps. Written as
          {' '}<span className="mono">1 in 118</span>, it means one row in a hundred and
          eighteen survives the condition, so a table of 131,000 rows yields about 1,110.
        </p>
        <p className="t-prose correlation-hint">
          Sweep it from 0 to 1 and watch the rectangle detach from the cloud.
        </p>
      </div>

      {!model ? (
        <p className="t-prose correlation-empty">
          Two equality predicates on one table are needed to draw this. The example query
          has them.
        </p>
      ) : (
        <>
          {/* The plot is a fixed square and the bay is the full width of the
              app, so on a wide display two thirds of this panel was empty field
              to the right of it. The readout moves up beside the picture it
              describes. */}
          <div className="correlation-figure">
          <div className="correlation-plot scroll-x">
            <Plot model={model} />
          </div>

          <div className="correlation-readout">
            <dl className="t-small">
              <div>
                <dt>independence predicts</dt>
                <dd className="is-believed">
                  {formatSelectivity(model.independent)} · {exact(model.independent * model.rowCount)} rows
                </dd>
              </div>
              {model.corrected !== null && (
                <div>
                  <dt>the statistic predicts</dt>
                  <dd className="is-corrected">
                    {formatSelectivity(model.corrected)} · {exact(model.corrected * model.rowCount)} rows
                  </dd>
                </div>
              )}
              <div>
                <dt>the truth is</dt>
                <dd className="is-true">
                  {formatSelectivity(model.measured)} · {exact(model.measured * model.rowCount)} rows
                </dd>
              </div>
            </dl>
            <p className="t-prose correlation-gap">
              {model.measured > 0
                ? `Independence is wrong by ${(model.measured / Math.max(model.independent, 1e-12)).toFixed(0)}× here.`
                : 'No rows match both predicates.'}
            </p>
          </div>
          </div>

          <TraceDetail trace={model.trace} />

          <DataTable
            caption="The estimates"
            columns={['source', 'selectivity', 'rows']}
            rows={[
              ['independence', formatSelectivity(model.independent), exact(model.independent * model.rowCount)],
              ...(model.corrected !== null
                ? [['multivariate statistic', formatSelectivity(model.corrected), exact(model.corrected * model.rowCount)]]
                : []),
              ['measured', formatSelectivity(model.measured), exact(model.measured * model.rowCount)],
            ]}
          />
        </>
      )}
    </div>
  );
}

interface Model {
  xValues: Value[];
  yValues: Value[];
  points: Array<{ x: number; y: number; count: number; matches: boolean }>;
  maxCount: number;
  xLabel: string;
  yLabel: string;
  xTarget: number;
  yTarget: number;
  /** Marginal selectivities, which set the rectangle's width and height. */
  xMarginal: number;
  yMarginal: number;
  independent: number;
  corrected: number | null;
  measured: number;
  rowCount: number;
  trace: ReturnType<typeof estimateExpr>['trace'];
}

function Plot({ model }: { model: Model }) {
  const size = PLOT;
  const cellW = size / Math.max(1, model.xValues.length);
  const cellH = size / Math.max(1, model.yValues.length);

  // Every area on this plot is on one scale: area over the field is
  // selectivity. That is the whole point of the picture and revision 1 only did
  // half of it — the belief was drawn to scale and the truth was drawn as
  // whichever grid cells happened to match, which is a texture, not an area.
  // Side by side at the same anchor, a 4 px box inside a 43 px one is the
  // hundredfold error, seen before anything is read.
  const anchorX = model.xTarget * cellW + cellW / 2;
  const anchorY = model.yTarget * cellH + cellH / 2;
  const centred = (side: number) => ({
    x: Math.max(0, Math.min(size - side, anchorX - side / 2)),
    y: Math.max(0, Math.min(size - side, anchorY - side / 2)),
    width: side,
    height: side,
  });

  // The independence rectangle: the product of two marginals, positioned at the
  // predicate's values. Its area is what the planner believes.
  const rectW = Math.max(3, model.xMarginal * size);
  const rectH = Math.max(3, model.yMarginal * size);
  const rectX = Math.max(0, Math.min(size - rectW, anchorX - rectW / 2));
  const rectY = Math.max(0, Math.min(size - rectH, anchorY - rectH / 2));

  // The measured area, on the same scale. Under-estimates are the dangerous
  // direction, so the region belief failed to cover is tinted rather than left
  // as bare field (DESIGN.md §2.2).
  const truth = centred(Math.sqrt(Math.max(model.measured, 0) * size * size));
  const underestimated = model.measured > model.independent;

  // What the multivariate statistic predicts, if one exists, at the same scale.
  const correctedArea = model.corrected === null ? null : model.corrected * size * size;
  const correctedSide = correctedArea === null ? 0 : Math.sqrt(Math.max(correctedArea, 9));

  return (
    <svg
      width={size + PAD * 2}
      height={size + PAD * 2}
      role="img"
      aria-label={
        `Scatter of ${model.xLabel} against ${model.yLabel}, `
        + 'with selectivity drawn as area. '
        + `Independence predicts ${formatSelectivity(model.independent)}; `
        + `the truth is ${formatSelectivity(model.measured)}.`
      }
    >
      <g transform={`translate(${PAD}, ${PAD})`}>
        <rect width={size} height={size} className="correlation-field" />

        {/* Points at low opacity so density reads. */}
        {model.points.map((p, i) => (
          <rect
            key={i}
            className={`correlation-point${p.matches ? ' is-match' : ''}`}
            x={p.x * cellW}
            y={p.y * cellH}
            width={Math.max(cellW - 0.5, 1)}
            height={Math.max(cellH - 0.5, 1)}
            style={{ opacity: p.matches ? 1 : Math.min(0.62, 0.2 + p.count / model.maxCount) }}
          />
        ))}

        {/* The measured area, beneath the belief so the belief sits inside it.
            The fill is the gap: the part of the truth the estimate missed. */}
        {truth.width > 0 && (
          <rect
            className={`correlation-truth ${underestimated ? 'gap-under' : 'gap-over'}`}
            {...truth}
          />
        )}
        {truth.width > 0 && (
          <rect className="correlation-truth-edge" {...truth}>
            <title>{`measured ${formatSelectivity(model.measured)}`}</title>
          </rect>
        )}

        {/* The wrong belief, drawn hollow and dashed the way a proposal is. */}
        <rect
          className="mark-believed correlation-rect"
          x={rectX} y={rectY} width={rectW} height={rectH}
        >
          <title>{`independence predicts ${formatSelectivity(model.independent)}`}</title>
        </rect>

        {correctedSide > 0 && (
          <rect
            className="correlation-corrected"
            x={Math.max(0, Math.min(size - correctedSide, model.xTarget * cellW + cellW / 2 - correctedSide / 2))}
            y={Math.max(0, Math.min(size - correctedSide, model.yTarget * cellH + cellH / 2 - correctedSide / 2))}
            width={correctedSide}
            height={correctedSide}
          >
            <title>{`the multivariate statistic predicts ${formatSelectivity(model.corrected!)}`}</title>
          </rect>
        )}
      </g>

      <text className="t-micro correlation-axis" x={PAD} y={size + PAD + 14}>{model.xLabel}</text>
      <text
        className="t-micro correlation-axis"
        transform={`translate(12, ${PAD + size}) rotate(-90)`}
      >
        {model.yLabel}
      </text>
    </svg>
  );
}

// ── Building the model ───────────────────────────────────────────────────────

interface Pair {
  alias: string;
  x: { column: string; value: Value; restriction: Restriction };
  y: { column: string; value: Value; restriction: Restriction };
}

/** Two equality predicates on one relation, which is the case the plot draws. */
function choosePair(spec: QuerySpec | null): Pair | null {
  if (!spec) return null;
  const byRelation = new Map<string, Array<{ column: string; value: Value; restriction: Restriction }>>();

  for (const restriction of spec.restrictions) {
    const e = restriction.expr;
    if (e.kind !== 'binary' || e.op !== '=') continue;
    const side = e.left.kind === 'column' && e.right.kind === 'literal'
      ? { column: e.left.name, value: e.right.value }
      : e.right.kind === 'column' && e.left.kind === 'literal'
        ? { column: e.right.name, value: e.left.value }
        : null;
    if (!side) continue;
    const list = byRelation.get(restriction.relation) ?? [];
    list.push({ ...side, restriction });
    byRelation.set(restriction.relation, list);
  }

  for (const [alias, list] of byRelation) {
    if (list.length >= 2) return { alias, x: list[0], y: list[1] };
  }
  return null;
}

function buildModel(
  statistics: Statistics, spec: QuerySpec, pair: Pair, table: Table,
): Model | null {
  const xValues = distinctValues(table, pair.x.column, 120);
  const yValues = distinctValues(table, pair.y.column, 120);
  if (xValues.length === 0 || yValues.length === 0) return null;

  const xIndex = new Map(xValues.map((v, i) => [String(v), i]));
  const yIndex = new Map(yValues.map((v, i) => [String(v), i]));

  const both = conjoin([pair.x.restriction.expr, pair.y.restriction.expr]);
  const matches = compilePredicate(both, table);
  const raw = scatter(table, pair.x.column, pair.y.column, matches);

  const points = raw.flatMap((p) => {
    const x = xIndex.get(String(p.x));
    const y = yIndex.get(String(p.y));
    return x === undefined || y === undefined ? [] : [{ x, y, count: p.count, matches: p.matches }];
  });
  const maxCount = Math.max(1, ...points.map((p) => p.count));

  const ctx = makeContext(spec, statistics);
  const estimate = estimateExpr(both, ctx);

  // The marginals set the rectangle's sides; their product is its area, and
  // that product is exactly what independence claims.
  const xMarginal = estimateExpr(pair.x.restriction.expr, ctx).selectivity;
  const yMarginal = estimateExpr(pair.y.restriction.expr, ctx).selectivity;

  const independent = xMarginal * yMarginal;
  const corrected = estimate.trace.method === 'independence' ? null : estimate.selectivity;
  const measured = measureExpr(table, both) / Math.max(1, table.rowCount);

  return {
    xValues, yValues, points, maxCount,
    xLabel: `${pair.alias}.${pair.x.column} = ${literal(pair.x.value)}`,
    yLabel: `${pair.alias}.${pair.y.column} = ${literal(pair.y.value)}`,
    xTarget: nearest(xValues, pair.x.value),
    yTarget: nearest(yValues, pair.y.value),
    xMarginal, yMarginal, independent, corrected, measured,
    rowCount: table.rowCount,
    trace: estimate.trace,
  };
}

function nearest(values: Value[], target: Value): number {
  const exactIndex = values.findIndex((v) => compareValues(v, target) === 0);
  return exactIndex >= 0 ? exactIndex : Math.floor(values.length / 2);
}

function literal(v: Value): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

export { percent };
