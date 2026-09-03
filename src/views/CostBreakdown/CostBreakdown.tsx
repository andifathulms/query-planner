/**
 * The cost breakdown (DESIGN.md §5.5, PRD §5.5).
 *
 * Every candidate plan for the selected lattice cell, as horizontal stacked bars
 * decomposed into the terms the cost model produced. The view renders
 * `CostBreakdown.terms` directly and never recomputes anything — the display and
 * the computation are one object.
 *
 * I/O terms are hatched and CPU terms solid, so the two kinds separate without
 * spending hue. Bars are positioned rather than reordered in the DOM, so when a
 * cost parameter moves they slide past each other and the moment one overtakes
 * another is visible. That overtake is the plan flip.
 */
import { useMemo } from 'react';
import { OperatorGlyph } from '../PlanTree/glyphs.js';
import { cost as formatCost, exact, plural } from '../../ui/format.js';
import { SIMPLIFICATIONS } from '../../planner/index.js';
import { planChildren, type Plan } from '../../planner/types.js';
import type { DpCell } from '../../planner/selinger.js';
import './CostBreakdown.css';

const ROW_H = 26;
const LABEL_W = 172;
/** Room at the right for the total, so a full-length bar never runs under it. */
const TOTAL_W = 46;

export interface CostBreakdownProps {
  cell: DpCell | null;
  /** Shown when no cell is selected, so the panel is never empty. */
  fallback: Plan | null;
}

export function CostBreakdown({ cell, fallback }: CostBreakdownProps) {
  const candidates = useMemo(() => {
    if (cell?.considered.length) return cell.considered.slice(0, 24);
    return fallback ? [fallback] : [];
  }, [cell, fallback]);

  if (candidates.length === 0) {
    return <p className="t-small cost-breakdown-empty">No candidates to show.</p>;
  }

  const max = Math.max(...candidates.map((c) => c.cost.total));
  const winner = candidates[0];

  // Rows keep their identity across re-sorts: the element for a plan stays the
  // same element and moves, rather than being replaced by a different plan's.
  const ranked = [...candidates].sort((a, b) => a.cost.total - b.cost.total);
  const positions = new Map(ranked.map((p, i) => [p.id, i]));

  const kinds = new Set(candidates.flatMap((c) => c.cost.terms.map((t) => t.kind)));

  return (
    <div className="cost-breakdown">
      <div className="cost-breakdown-head">
        <p className="t-small">
          {cell
            ? `${[...cell.relations].sort().join('')} · ${exact(cell.considered.length)} `
              + `${plural(cell.considered.length, 'candidate')}`
              + (cell.considered.length > candidates.length ? `, showing ${candidates.length}` : '')
            : 'the chosen plan'}
        </p>
        <div className="cost-breakdown-legend t-micro" aria-hidden="true">
          {kinds.has('io') && (
            <span><svg width={10} height={10}><rect width={10} height={10} className="term-io" /></svg> I/O</span>
          )}
          {kinds.has('cpu') && (
            <span><svg width={10} height={10}><rect width={10} height={10} className="term-cpu" /></svg> CPU</span>
          )}
        </div>
      </div>

      <div className="cost-breakdown-bars" style={{ height: ranked.length * ROW_H }}>
        <svg width="100%" height={ranked.length * ROW_H} role="table" aria-label="Candidate plans by cost">
          <defs>
            {/* A fine hatch rather than a second hue: I/O and CPU must be
                separable in a screenshot, and hue is spoken for. */}
            <pattern id="io-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={4} height={4} fill="var(--surface-sunken)" />
              <line x1={0} y1={0} x2={0} y2={4} stroke="var(--ink-mid)" strokeWidth={1.2} />
            </pattern>
          </defs>

          {candidates.map((plan) => (
            <Bar
              key={plan.id}
              plan={plan}
              y={(positions.get(plan.id) ?? 0) * ROW_H}
              max={max}
              isWinner={plan === winner}
            />
          ))}
        </svg>
      </div>

      <p className="t-small cost-breakdown-note">
        {SIMPLIFICATIONS[noteKeyFor(winner)]}
      </p>
    </div>
  );
}

function Bar({
  plan, y, max, isWinner,
}: { plan: Plan; y: number; max: number; isWinner: boolean }) {
  const terms = plan.cost.terms;
  const total = plan.cost.total;
  const scale = (v: number): number => (max <= 0 ? 0 : (v / max) * 100);

  let offset = 0;
  const segments = terms.map((term) => {
    const width = scale(Math.max(0, term.value));
    const segment = { ...term, x: offset, width };
    offset += width;
    return segment;
  });

  const label = `${describe(plan)}, cost ${formatCost(total)}`;

  return (
    <g
      className={`cost-bar-row${isWinner ? ' is-winner' : ''}`}
      transform={`translate(0, ${y})`}
      role="row"
      aria-label={label}
    >
      <title>{`${label}\n${terms.map((t) => `${t.label}: ${formatCost(t.value)}`).join('\n')}`}</title>

      {/* The winner carries a marker at the left (§5.5). */}
      {isWinner && <rect className="cost-bar-marker" x={0} y={5} width={3} height={ROW_H - 12} />}

      <g transform="translate(8, 5)">
        <OperatorGlyph operator={plan.operator} size={11} />
      </g>
      <text className="t-micro cost-bar-label" x={24} y={ROW_H / 2 + 2}>{describe(plan)}</text>

      {/* A nested <svg> rather than a <g>, because a percentage inside a group
          resolves against the whole viewport: the longest bar was drawn 172 px
          wider than the panel and ran underneath its own total. Nesting
          establishes a viewport of the track's real width, so the percentages
          mean what they say and the overflow is clipped. */}
      <svg
        className="cost-bar-track"
        x={LABEL_W}
        y={0}
        height={ROW_H}
        width={`calc(100% - ${LABEL_W + TOTAL_W}px)`}
      >
        {segments.map((s, i) => (
          <rect
            key={i}
            className={s.kind === 'io' ? 'term-io' : 'term-cpu'}
            x={`${s.x}%`}
            y={6}
            width={`${s.width}%`}
            height={ROW_H - 14}
          />
        ))}
      </svg>

      <text className="t-micro cost-bar-total" x="100%" dx={-2} y={ROW_H / 2 + 2}>
        {formatCost(total)}
      </text>
    </g>
  );
}

/** A compact description: the operator, and what it is joining or reading. */
function describe(plan: Plan): string {
  switch (plan.operator) {
    case 'Seq Scan':
    case 'Index Scan':
      return `${plan.operator} ${plan.relation.alias}`;
    case 'Nested Loop':
    case 'Hash Join':
    case 'Merge Join':
      return `${plan.operator} ${sides(plan)}`;
    default:
      return plan.operator;
  }
}

function sides(plan: Plan): string {
  const [outer, inner] = planChildren(plan);
  return `${leaves(outer)} × ${leaves(inner)}`;
}

function leaves(plan: Plan): string {
  const children = planChildren(plan);
  if (children.length === 0) {
    return plan.operator === 'Seq Scan' || plan.operator === 'Index Scan'
      ? plan.relation.alias : '?';
  }
  return children.map(leaves).join('');
}

/**
 * Which simplification note belongs beside these numbers.
 *
 * The statement sits next to the number it affects, not on an about page
 * (CLAUDE.md §10).
 */
function noteKeyFor(plan: Plan): string {
  switch (plan.operator) {
    case 'Index Scan': return 'indexScan';
    case 'Seq Scan': return 'seqScan';
    case 'Nested Loop': return 'nestedLoop';
    case 'Hash Join': return 'hashJoin';
    case 'Merge Join': return 'mergeJoin';
    case 'Sort': return 'sort';
    default: return 'parallel';
  }
}
