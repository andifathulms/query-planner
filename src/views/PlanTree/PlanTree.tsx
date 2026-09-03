/**
 * The plan tree (DESIGN.md §5.2).
 *
 * The chosen plan, drawn in line, root at top. Each node carries the operator in
 * Postgres's own words, the relation, and the estimate/actual span.
 *
 * The span is the node's most important element. Leaves are usually tight; the
 * spans widen as you go up, and that widening is the error compounding. Watching
 * 1.2x at a scan become 8x after one join and 300x at the root is the app's
 * clearest statement of why a small statistics problem becomes a catastrophic
 * plan.
 */
import { useMemo, useRef } from 'react';
import { DEFAULT_LAYOUT, layoutPlan, type LaidOutNode } from './layout.js';
import { OperatorGlyph, OPERATOR_NOTES } from './glyphs.js';
import { Span } from '../../ui/Span.js';
import { cost, directionWord, errorRatio, exact, rows } from '../../ui/format.js';
import { planLabel, type Plan } from '../../planner/types.js';
import type { NodeStats } from '../../executor/trace.js';
import './PlanTree.css';

export interface PlanTreeProps {
  plan: Plan | null;
  stats: Map<string, NodeStats> | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const { nodeWidth, nodeHeight } = DEFAULT_LAYOUT;

export function PlanTree({ plan, stats, selectedId, onSelect }: PlanTreeProps) {
  const layout = useMemo(() => layoutPlan(plan), [plan]);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!plan || !layout.root) {
    return <p className="t-small plan-tree-empty">No plan yet.</p>;
  }

  // One axis domain for the whole tree, so a span's width means the same thing
  // at every node and the widening up the tree is real rather than an artefact
  // of rescaling.
  const values: number[] = [];
  for (const node of layout.nodes) {
    values.push(Math.max(1, node.plan.estimatedRows));
    const actual = stats?.get(node.plan.id)?.actualRows;
    if (actual !== undefined) values.push(Math.max(1, actual));
  }
  const min = 1;
  const max = Math.max(10, ...values);

  const rootStats = stats?.get(plan.id);
  const ratio = rootStats ? errorRatio(plan.estimatedRows, rootStats.actualRows) : null;

  return (
    <div className="plan-tree">
      <div className="plan-tree-canvas scroll-x">
        <svg
          ref={svgRef}
          width={layout.width}
          height={layout.height + 8}
          role="tree"
          aria-label="The chosen plan"
          className="plan-tree-svg"
          onKeyDown={(e) => handleKeys(e, layout.nodes, selectedId, onSelect)}
          tabIndex={0}
        >
          {/* Edges first, so nodes sit on top of them. */}
          <g className="plan-tree-edges">
            {layout.nodes.filter((n) => n.parent).map((n) => (
              <path
                key={`edge-${n.plan.id}`}
                d={edgePath(n)}
                fill="none"
                stroke="var(--line)"
                strokeWidth={1}
              />
            ))}
          </g>

          {layout.nodes.map((node) => (
            <PlanNode
              key={node.plan.id}
              node={node}
              stats={stats?.get(node.plan.id) ?? null}
              min={min}
              max={max}
              selected={node.plan.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </svg>
      </div>

      {ratio && (
        /* The verdict block (DESIGN.md §4.1, §5.2). The finding gets a frame:
           the ratio at display size, the direction in words, and the assumption
           that produced it named. Bordered on the leading edge only, in --warn
           when the estimate was low, so it reads as a verdict rather than as one
           more card. */
        <div className={`plan-tree-verdict${ratio.direction === 'under' ? ' is-under' : ''}`}>
          <div className="t-display plan-tree-verdict-figure" aria-hidden="true">
            {ratio.label}
          </div>
          <div className="plan-tree-verdict-body">
            <p className="t-body">
              {ratio.direction === 'exact'
                ? 'The root estimate matched the actual row count.'
                : `The root ${directionWord(ratio.direction)} by ${ratio.label}: `
                  + `${exact(plan.estimatedRows)} estimated, ${exact(rootStats!.actualRows)} actual.`}
            </p>
            {ratio.direction === 'under' && (
              <p className="t-small plan-tree-warn">
                An under-estimate is the dangerous direction. It is what makes a planner
                choose a nested loop it cannot afford.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanNode({
  node, stats, min, max, selected, onSelect,
}: {
  node: LaidOutNode;
  stats: NodeStats | null;
  min: number;
  max: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const plan = node.plan;
  const x = node.x - nodeWidth / 2;
  const ratio = stats ? errorRatio(plan.estimatedRows, stats.actualRows) : null;
  const spilled = (stats?.spills ?? 0) > 0;

  const description = `${planLabel(plan)}, estimated ${exact(plan.estimatedRows)} rows`
    + (stats ? `, actual ${exact(stats.actualRows)} rows, ${ratio!.label} ${directionWord(ratio!.direction)}` : '')
    + `, cost ${cost(plan.cost.total)}`;

  return (
    <g
      className={`plan-node${selected ? ' is-selected' : ''}`}
      transform={`translate(${x}, ${node.y})`}
      role="treeitem"
      aria-selected={selected}
      aria-level={node.depth + 1}
      aria-label={description}
      data-node-id={plan.id}
      tabIndex={-1}
      onClick={() => onSelect(selected ? null : plan.id)}
    >
      <title>{`${planLabel(plan)}: ${OPERATOR_NOTES[plan.operator]}`}</title>
      <rect
        className="plan-node-box"
        width={nodeWidth}
        height={nodeHeight}
        rx={2}
      />

      <g transform="translate(8, 8)">
        <OperatorGlyph operator={plan.operator} />
      </g>

      <text className="t-data plan-node-title" x={28} y={17}>{plan.operator}</text>
      <text className="t-micro plan-node-sub" x={28} y={29}>
        {clip(subtitle(plan), SUBTITLE_CHARS)}
      </text>

      {/* The span, local to the node but on the tree's shared axis. */}
      <g transform={`translate(8, ${nodeHeight - 17})`}>
        <Span
          believed={Math.max(1, plan.estimatedRows)}
          actual={stats ? Math.max(1, stats.actualRows) : null}
          min={min}
          max={max}
          width={nodeWidth - 58}
          height={11}
        />
      </g>
      <text className="t-micro plan-node-ratio" x={nodeWidth - 8} y={nodeHeight - 8}>
        {ratio ? ratio.label : rows(plan.estimatedRows)}
      </text>

      {spilled && (
        <g transform={`translate(${nodeWidth - 12}, 10)`}>
          <title>{`${stats!.spills} spill over work_mem`}</title>
          <circle r={3} fill="var(--warn)" />
        </g>
      )}
    </g>
  );
}

/**
 * Characters of `--t-micro` mono that fit between the glyph and the node's right
 * edge. Geist Mono at 10 px advances 6 px, and the box is 168 px with the text
 * starting at 28: (168 - 28 - 8) / 6.
 *
 * A parameterized index scan's subtitle — "on kecamatan · id = k.kecamatan_id" —
 * is half again as long as that, and SVG text does not wrap or clip on its own.
 */
const SUBTITLE_CHARS = 22;

/** Truncate to fit. The full text stays in the node's title and its detail. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function subtitle(plan: Plan): string {
  switch (plan.operator) {
    case 'Seq Scan':
    case 'Index Scan': {
      const on = `on ${plan.relation.table}`;
      if (plan.operator === 'Index Scan' && plan.parameterizedBy) {
        return `${on} · ${plan.index?.column} = ${plan.parameterizedBy.relation}.${plan.parameterizedBy.column}`;
      }
      if (plan.operator === 'Index Scan' && plan.index) return `${on} · ${plan.index.column}`;
      return on;
    }
    case 'Sort':
      return plan.sortKeys.map((k) => `${k.relation}.${k.column}`).join(', ');
    case 'HashAggregate':
    case 'GroupAggregate':
      return `${rows(plan.groups)} groups`;
    case 'Limit':
      return `${plan.count} rows`;
    default:
      return plan.clause ? plan.clause.text : 'no condition';
  }
}

function edgePath(node: LaidOutNode): string {
  const parent = node.parent!;
  const x1 = node.x;
  const y1 = node.y;
  const x2 = parent.x;
  const y2 = parent.y + nodeHeight;
  const midY = (y1 + y2) / 2;
  // An orthogonal elbow rather than a curve: this is a technical drawing, and a
  // right angle reads as structure where a bezier reads as decoration.
  return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
}

/**
 * Keyboard traversal (PRD §8.8): up and down move between levels, left and
 * right between siblings.
 */
function handleKeys(
  event: React.KeyboardEvent,
  nodes: LaidOutNode[],
  selectedId: string | null,
  onSelect: (id: string | null) => void,
): void {
  const current = nodes.find((n) => n.plan.id === selectedId) ?? nodes[0];
  if (!current) return;

  let next: LaidOutNode | undefined;
  switch (event.key) {
    case 'ArrowUp': next = current.parent ?? undefined; break;
    case 'ArrowDown': next = current.children[0]; break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const siblings = current.parent?.children ?? [current];
      const i = siblings.indexOf(current);
      next = siblings[i + (event.key === 'ArrowRight' ? 1 : -1)];
      break;
    }
    case 'Escape': onSelect(null); event.preventDefault(); return;
    default: return;
  }
  if (next) {
    onSelect(next.plan.id);
    event.preventDefault();
  }
}
