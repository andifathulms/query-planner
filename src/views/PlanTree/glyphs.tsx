/**
 * Operator glyphs (DESIGN.md §5.2).
 *
 * Operators are distinguished by a glyph, never by colour. Spending hue on nine
 * operators would leave nothing for the distinction the app is actually about,
 * and hue here means believed or true and nothing else.
 *
 * A bar for a scan, a converging pair for a join, a stack for a sort.
 */
import type { OperatorName } from '../../planner/types.js';

export function OperatorGlyph({ operator, size = 14 }: { operator: OperatorName; size?: number }) {
  const s = size;
  const stroke = 'var(--ink)';
  const common = { stroke, strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' as const };

  switch (operator) {
    // A bar: reading a relation straight through.
    case 'Seq Scan':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <rect x={2} y={2} width={10} height={10} {...common} />
          <line x1={2} y1={5.5} x2={12} y2={5.5} {...common} />
          <line x1={2} y1={8.5} x2={12} y2={8.5} {...common} />
        </svg>
      );
    // The same bar, entered from one side: a descent into a sorted structure.
    case 'Index Scan':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <rect x={2} y={2} width={10} height={10} {...common} />
          <path d="M4 4 L10 7 L4 10" {...common} />
        </svg>
      );
    // A converging pair: two streams meeting. The three joins differ in how the
    // streams are drawn, not in colour.
    case 'Nested Loop':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2 L7 7 L2 12" {...common} />
          <circle cx={10.5} cy={7} r={2.5} {...common} />
        </svg>
      );
    case 'Hash Join':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2 L7 7 L2 12" {...common} />
          <line x1={9} y1={3} x2={9} y2={11} {...common} />
          <line x1={12} y1={3} x2={12} y2={11} {...common} />
          <line x1={8} y1={5.5} x2={13} y2={5.5} {...common} />
          <line x1={8} y1={8.5} x2={13} y2={8.5} {...common} />
        </svg>
      );
    case 'Merge Join':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2 L7 7 L2 12" {...common} />
          <path d="M12 2 L8 7 L12 12" {...common} />
        </svg>
      );
    // A stack: rows accumulated, then released in order.
    case 'Sort':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <line x1={2} y1={3.5} x2={12} y2={3.5} {...common} />
          <line x1={2} y1={7} x2={9} y2={7} {...common} />
          <line x1={2} y1={10.5} x2={6} y2={10.5} {...common} />
        </svg>
      );
    case 'HashAggregate':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <circle cx={4.5} cy={4.5} r={2.2} {...common} />
          <circle cx={9.5} cy={4.5} r={2.2} {...common} />
          <path d="M4.5 8 L7 11.5 L9.5 8" {...common} />
        </svg>
      );
    case 'GroupAggregate':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <line x1={2} y1={3} x2={12} y2={3} {...common} />
          <line x1={2} y1={6} x2={12} y2={6} {...common} />
          <path d="M4 9 L7 12 L10 9" {...common} />
        </svg>
      );
    // A gate: everything above this line is discarded.
    case 'Limit':
      return (
        <svg width={s} height={s} viewBox="0 0 14 14" aria-hidden="true">
          <line x1={2} y1={4} x2={12} y2={4} {...common} />
          <line x1={2} y1={7} x2={12} y2={7} {...common} strokeDasharray="2 2" />
          <line x1={2} y1={10} x2={12} y2={10} {...common} strokeDasharray="2 2" />
        </svg>
      );
  }
}

/**
 * A short description of what the operator does, for the node's title and for
 * screen readers.
 */
export const OPERATOR_NOTES: Record<OperatorName, string> = {
  'Seq Scan': 'Reads every page of the relation in physical order.',
  'Index Scan': 'Descends the index, then fetches the matching heap rows.',
  'Nested Loop': 'Restarts the inner side for every outer row. Pipelines: the first row arrives almost immediately.',
  'Hash Join': 'Builds a hash table from one side, then probes it with the other. Blocking: nothing is emitted until the build finishes.',
  'Merge Join': 'Walks two ordered streams in step. Requires both inputs sorted on the join key.',
  Sort: 'Blocking: nothing is emitted until every row has arrived.',
  HashAggregate: 'Groups by hashing. Blocking, and it spills when the group table exceeds work_mem.',
  GroupAggregate: 'Groups a sorted input. Pipelines: a group is emitted as soon as its last row arrives.',
  Limit: 'Stops its input as soon as it has enough rows.',
};
