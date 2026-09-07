/**
 * A selectivity trace, rendered (CLAUDE.md §2, DESIGN.md §7).
 *
 * Every estimate states its method and its assumptions, from the trace object
 * the estimator produced. Not "estimated 12 rows" but "estimated 12 rows —
 * independence assumed between kota and provinsi".
 *
 * This renders the trace and computes nothing: the display and the computation
 * are one object.
 */
import { selectivity as formatSelectivity } from './format.js';
import type { SelectivityMethod, SelectivityTrace } from '../planner/types.js';
import { formulaFor, METHOD_RULES } from './traceFormula.js';
import './TraceDetail.css';

/** What each method is, in one clause, for the reader who has not met it. */
export const METHOD_LABELS: Record<SelectivityMethod, string> = {
  mcv: 'most-common values',
  histogram: 'histogram',
  default: 'default',
  independence: 'independence',
  dependency: 'functional dependency',
  'multivariate-mcv': 'multivariate MCV',
  'multivariate-ndistinct': 'multivariate n-distinct',
  join: 'join',
  nullfrac: 'null fraction',
  disjunction: 'disjunction',
  negation: 'negation',
};

/** The methods that involve an assumption the app is arguing about. */
const ASSUMED: ReadonlySet<SelectivityMethod> = new Set([
  'independence', 'default', 'disjunction',
]);

export function TraceDetail({ trace, depth = 0 }: { trace: SelectivityTrace; depth?: number }) {
  const formula = formulaFor(trace);
  const rule = METHOD_RULES[trace.method];

  return (
    <div className={`trace${depth > 0 ? ' is-nested' : ''}`}>
      <div className="trace-head">
        <code className="t-data trace-clause">{trace.clause}</code>
        <span className={`trace-method t-micro${ASSUMED.has(trace.method) ? ' is-assumed' : ''}`}>
          {METHOD_LABELS[trace.method]}
        </span>
        {/* The step that was missing: the operation, not just its operands and
            its answer. Shown only when evaluating it reproduces the estimator's
            own result, so it can be checked by hand and cannot drift. */}
        <span className="t-data trace-result">
          {formula?.verified && (
            <span className="trace-formula">{formula.expression} = </span>
          )}
          {formatSelectivity(trace.result)}
        </span>
      </div>

      {rule && <p className="trace-rule t-small">{rule}</p>}

      {Object.keys(trace.inputs).length > 0 && (
        <dl className="trace-inputs t-micro">
          {Object.entries(trace.inputs).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{formatInput(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {trace.assumptions.length > 0 && (
        <ul className="trace-assumptions t-small">
          {trace.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
        </ul>
      )}

      {/* Sub-traces, so a conjunction shows what each clause contributed. Two
          levels is enough to follow the arithmetic; deeper is noise. */}
      {depth < 2 && trace.children?.map((child, i) => (
        <TraceDetail key={`${child.clause}-${i}`} trace={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function formatInput(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Number.isInteger(value) && Math.abs(value) < 1e6) return value.toLocaleString('en-GB');
  if (Math.abs(value) >= 1e6) return value.toExponential(2);
  if (Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  return value.toFixed(4);
}

/**
 * A one-line summary, for places with no room for the full trace — a plan node's
 * caption, for example.
 */
export function traceSummary(trace: SelectivityTrace): string {
  const assumption = trace.assumptions[0];
  return assumption
    ? `${METHOD_LABELS[trace.method]}: ${assumption}`
    : METHOD_LABELS[trace.method];
}
