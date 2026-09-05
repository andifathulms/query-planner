/**
 * Where the error entered (PRD §5.2).
 *
 * The plan tree draws a ratio at every node and the root ratio climbs, and until
 * now the app asserted that "the errors multiply through each join" without ever
 * saying which join. A leaf 3x low under a join that adds 25x of its own is a
 * different diagnosis from a leaf 70x low under joins that are faithful: the
 * first says fix the scan's statistics, the second says the join model is wrong.
 *
 * The decomposition is exact and multiplicative. For a node whose children were
 * estimated at `est` and measured at `act`, the selectivity the planner applied
 * is `estimatedRows / prod(est)`, and applying that same selectivity to the
 * measured inputs gives what the node would have predicted had it been handed
 * the truth. So:
 *
 *   inherited = prod(act) / prod(est)          the error arriving from below
 *   introduced = actualRows / (prod(act) * s)  the error this node added
 *   inherited * introduced = actualRows / estimatedRows
 *
 * A leaf has nothing below it, so its error is all its own. Every quantity here
 * is a ratio of two numbers already on screen; nothing new is measured and
 * nothing is modelled.
 */
import { planChildren, type Plan } from '../planner/types.js';
import type { NodeStats } from '../executor/trace.js';

export interface ErrorSource {
  /** The factor arriving from the children. 1 at a leaf, and 1 when they were right. */
  inherited: number;
  /** The factor this node added on its own. */
  introduced: number;
  /** `inherited * introduced`, which is the node's own estimate error. */
  total: number;
}

/** Guard against a zero row count turning a ratio into infinity. */
const atLeastOne = (n: number): number => Math.max(n, 1);

export function errorSource(plan: Plan, stats: NodeStats | null | undefined,
  all: Map<string, NodeStats>): ErrorSource | null {
  if (!stats) return null;

  const children = planChildren(plan);
  const measured = children.map((c) => all.get(c.id));
  // A node is only decomposable when every child was measured.
  if (measured.some((m) => !m)) return null;

  const estimatedInput = children.reduce((p, c) => p * atLeastOne(c.estimatedRows), 1);
  const actualInput = measured.reduce((p, m) => p * atLeastOne(m!.actualRows), 1);

  const total = atLeastOne(stats.actualRows) / atLeastOne(plan.estimatedRows);
  if (children.length === 0) return { inherited: 1, introduced: total, total };

  const inherited = actualInput / estimatedInput;
  // The rest, by construction, so the two factors always multiply back to the
  // whole. Deriving it rather than recomputing the selectivity keeps the
  // identity exact under floating point.
  const introduced = total / inherited;
  return { inherited, introduced, total };
}

/**
 * The node that added the most error of its own.
 *
 * The diagnosis the tree could not previously give: not "the root is 83x low"
 * but "83x low, and 25x of it entered at this join". Nodes are compared on
 * `introduced` rather than `total`, because `total` is largest at the root by
 * construction and naming the root explains nothing.
 */
export function largestSource(
  root: Plan, all: Map<string, NodeStats>,
): { plan: Plan; source: ErrorSource } | null {
  let best: { plan: Plan; source: ErrorSource } | null = null;
  const visit = (plan: Plan): void => {
    const source = errorSource(plan, all.get(plan.id), all);
    if (source && (!best || magnitude(source.introduced) > magnitude(best.source.introduced))) {
      best = { plan, source };
    }
    for (const child of planChildren(plan)) visit(child);
  };
  visit(root);
  // An over-estimate of 4x is as much of a miss as an under-estimate of 4x, so
  // they are ranked by distance from 1 in either direction.
  return best;
}

/** Distance from a correct estimate, in either direction. */
export function magnitude(factor: number): number {
  return factor >= 1 ? factor : 1 / Math.max(factor, 1e-9);
}
