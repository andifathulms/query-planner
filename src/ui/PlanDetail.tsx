/**
 * The detail for a selected plan node (DESIGN.md §5.2).
 *
 * Selecting a node opens its selectivity trace: the method used, the inputs, and
 * the assumptions listed by name. Beside it, the cost decomposition and the
 * statement of where this model differs from Postgres — next to the number it
 * affects, not on an about page.
 */
import { OperatorGlyph, OPERATOR_NOTES } from '../views/PlanTree/glyphs.js';
import { TraceDetail } from './TraceDetail.js';
import { cost as formatCost, directionWord, errorRatio, exact, ms, plural } from './format.js';
import { SIMPLIFICATIONS } from '../planner/index.js';
import { planLabel, type Plan } from '../planner/types.js';
import type { NodeStats } from '../executor/trace.js';
import './PlanDetail.css';

export interface PlanDetailProps {
  plan: Plan | null;
  stats: NodeStats | null;
  onClose: () => void;
}

export function PlanDetail({ plan, stats, onClose }: PlanDetailProps) {
  if (!plan) {
    return (
      <p className="t-small plan-detail-empty">
        Select a plan node to see how its estimate was made.
      </p>
    );
  }

  const ratio = stats ? errorRatio(plan.estimatedRows, stats.actualRows) : null;

  return (
    <div className="plan-detail">
      <div className="plan-detail-head">
        <OperatorGlyph operator={plan.operator} />
        <h3 className="t-data plan-detail-title">{planLabel(plan)}</h3>
        <button type="button" className="control plan-detail-close" onClick={onClose}>
          close
        </button>
      </div>

      <p className="t-small plan-detail-note">{OPERATOR_NOTES[plan.operator]}</p>

      <dl className="plan-detail-figures t-data">
        <div>
          <dt className="t-small">estimated</dt>
          <dd>{exact(plan.estimatedRows)} {plural(plan.estimatedRows, 'row')}</dd>
        </div>
        {stats && (
          <div>
            <dt className="t-small">actual</dt>
            <dd>{exact(stats.actualRows)} {plural(stats.actualRows, 'row')}</dd>
          </div>
        )}
        {ratio && ratio.direction !== 'exact' && (
          <div>
            <dt className="t-small">error</dt>
            <dd className={ratio.direction === 'under' ? 'is-under' : undefined}>
              {ratio.label} {directionWord(ratio.direction)}
            </dd>
          </div>
        )}
        <div>
          <dt className="t-small">cost</dt>
          <dd>{formatCost(plan.cost.startup)} … {formatCost(plan.cost.total)}</dd>
        </div>
        <div>
          <dt className="t-small">width</dt>
          <dd>{plan.rowWidth} bytes</dd>
        </div>
        {stats && stats.loops > 1 && (
          <div>
            <dt className="t-small">loops</dt>
            <dd>{exact(stats.loops)}</dd>
          </div>
        )}
        {stats && stats.firstRowTimeMs !== null && (
          <div>
            <dt className="t-small">first row</dt>
            <dd>{ms(stats.firstRowTimeMs)}</dd>
          </div>
        )}
        {stats && stats.spills > 0 && (
          <div>
            <dt className="t-small">spills</dt>
            <dd className="is-under">{stats.spills}</dd>
          </div>
        )}
      </dl>

      <h4 className="t-small plan-detail-section">Cost</h4>
      <ul className="plan-detail-terms t-data">
        {plan.cost.terms.map((term, i) => (
          <li key={i}>
            <span className={`plan-detail-kind t-micro ${term.kind}`}>{term.kind}</span>
            <span className="plan-detail-term-label">{term.label}</span>
            <span className="plan-detail-term-value">{formatCost(term.value)}</span>
          </li>
        ))}
      </ul>

      {plan.traces.length > 0 && (
        <>
          <h4 className="t-small plan-detail-section">How the estimate was made</h4>
          {plan.traces.map((trace, i) => <TraceDetail key={i} trace={trace} />)}
        </>
      )}

      <p className="t-micro plan-detail-simplification">
        {SIMPLIFICATIONS[simplificationFor(plan)]}
      </p>
    </div>
  );
}

function simplificationFor(plan: Plan): string {
  switch (plan.operator) {
    case 'Index Scan': return 'indexScan';
    case 'Seq Scan': return 'seqScan';
    case 'Nested Loop': return 'nestedLoop';
    case 'Hash Join': return 'hashJoin';
    case 'Merge Join': return 'mergeJoin';
    case 'Sort': return 'sort';
    case 'HashAggregate':
    case 'GroupAggregate': return 'parallel';
    default: return 'parallel';
  }
}
