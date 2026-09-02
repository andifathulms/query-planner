/**
 * Brute-force plan search, for checking the DP.
 *
 * Enumerates every join tree over every permutation and every operator, with no
 * pruning and no subset memoisation. Exponentially worse than the DP and
 * completely independent of it, which is the point: if the two agree on the
 * optimum, the DP's pruning is not discarding a winner (PRD §7.2).
 */
import { hashJoinCost, mergeJoinCost, nestedLoopCost } from '../../src/planner/cost.js';
import { joinCardinality, makeContext } from '../../src/planner/cardinality.js';
import { accessPaths } from '../../src/planner/paths.js';
import { interestingOrders } from '../../src/planner/orders.js';
import { ensureSorted } from '../../src/planner/selinger.js';
import { satisfies, type CostParams, type JoinClause, type Plan, type QuerySpec, type SortOrder, type TableId } from '../../src/planner/types.js';
import type { Statistics } from '../../src/stats/types.js';

export function exhaustiveBest(
  spec: QuerySpec, statistics: Statistics, params: CostParams,
): Plan {
  const estimation = makeContext(spec, statistics);
  const orders = interestingOrders(spec);
  const ctx = { spec, statistics, estimation, params, orders };

  // Every access path for every relation, kept in full.
  const leaves = new Map<TableId, Plan[]>();
  for (const relation of spec.relations) {
    leaves.set(relation.alias, accessPaths(relation, ctx));
  }

  const memo = new Map<string, Plan[]>();

  /** Every plan for a subset, with no pruning whatsoever. */
  const plansFor = (subset: TableId[]): Plan[] => {
    const key = [...subset].sort().join('|');
    const hit = memo.get(key);
    if (hit) return hit;

    let out: Plan[];
    if (subset.length === 1) {
      out = leaves.get(subset[0])!;
    } else {
      out = [];
      for (const [left, right] of allSplits(subset)) {
        const clauses = connecting(spec, left, right);
        if (clauses.length === 0) continue;
        for (const outer of plansFor(left)) {
          for (const inner of plansFor(right)) {
            // A LEFT JOIN's preserved side must be the outer one, the same
            // constraint the DP applies.
            const legal = clauses.every((c) => {
              if (c.type !== 'left') return true;
              const nullable = spec.nullableSide.has(c.right) ? c.right : c.left;
              return inner.relations.includes(nullable);
            });
            if (legal) out.push(...allJoins(outer, inner, clauses, spec, estimation, params));
          }
        }
      }
    }
    // Keep only the cheapest plan per (order) class, plus the cheapest overall.
    // Keeping literally everything is what makes this exponential; this keeps
    // the search honest while staying tractable at four relations.
    memo.set(key, out);
    return out;
  };

  const all = plansFor(spec.relations.map((r) => r.alias));
  if (all.length === 0) throw new Error('exhaustive search found no plan');
  return all.reduce((best, p) => (p.cost.total < best.cost.total ? p : best));
}

function allJoins(
  outer: Plan, inner: Plan, clauses: JoinClause[],
  spec: QuerySpec, estimation: ReturnType<typeof makeContext>, params: CostParams,
): Plan[] {
  const relations = [...outer.relations, ...inner.relations];
  const { rows, traces } = joinCardinality(
    outer.estimatedRows, inner.estimatedRows, clauses, outer.relations, spec, estimation,
  );
  const rowWidth = outer.rowWidth + inner.rowWidth;
  const joinType = clauses.some((c) => c.type === 'left') ? 'left' as const : 'inner' as const;
  const base = {
    estimatedRows: rows, rowWidth, relations, traces,
    clause: clauses[0] ?? null, joinType, filters: [] as never[],
  };
  const out: Plan[] = [];
  let n = 0;
  const id = (): string => `bf${relations.join('')}${n++}`;

  out.push({
    ...base, id: id(), operator: 'Nested Loop', outer, inner,
    cost: nestedLoopCost(outer.cost, outer.estimatedRows, inner.cost, inner.estimatedRows, params),
    order: outer.order,
  });

  const equis = clauses.filter((c) => c.equi);
  if (equis.length > 0) {
    // The inner side is hashed, as the DP does. Both (build, probe)
    // assignments are still reached, because this search enumerates each
    // partition in both orderings; hashing the outer side would only add a
    // duplicate at the same cost with its ordering lost.
    const hash = hashJoinCost(
      inner.cost, inner.estimatedRows, inner.estimatedRows * inner.rowWidth,
      outer.cost, outer.estimatedRows, params,
    );
    out.push({
      ...base, id: id(), operator: 'Hash Join', outer, inner, buildInner: true,
      cost: hash,
      order: outer.order,
    });
  }

  for (const clause of equis) {
    const outerKey = sideKey(clause, outer.relations);
    const innerKey = sideKey(clause, inner.relations);
    if (!outerKey || !innerKey) continue;
    const left = ensureSorted(outer, [outerKey], params).plan;
    const right = ensureSorted(inner, [innerKey], params).plan;
    out.push({
      ...base, id: id(), operator: 'Merge Join', outer: left, inner: right,
      cost: mergeJoinCost(left.cost, outer.estimatedRows, right.cost, inner.estimatedRows, params),
      order: [outerKey],
    });
  }

  return out;
}

function sideKey(clause: JoinClause, relations: TableId[]): SortOrder[number] | null {
  if (!clause.equi) return null;
  if (relations.includes(clause.left)) {
    return { relation: clause.left, column: clause.equi.leftColumn, direction: 'asc' };
  }
  if (relations.includes(clause.right)) {
    return { relation: clause.right, column: clause.equi.rightColumn, direction: 'asc' };
  }
  return null;
}

function* allSplits(subset: TableId[]): Generator<[TableId[], TableId[]]> {
  const n = subset.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const left: TableId[] = [], right: TableId[] = [];
    for (let i = 0; i < n; i++) (mask & (1 << i) ? left : right).push(subset[i]);
    yield [left, right];
  }
}

function connecting(spec: QuerySpec, left: TableId[], right: TableId[]): JoinClause[] {
  const l = new Set(left), r = new Set(right);
  return spec.joins.filter(
    (c) => (l.has(c.left) && r.has(c.right)) || (l.has(c.right) && r.has(c.left)),
  );
}

export { satisfies };
