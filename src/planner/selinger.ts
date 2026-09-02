/**
 * Selinger dynamic programming over subsets (CLAUDE.md §4).
 *
 * Optimal plans for every single relation, then every pair, then every triple,
 * up to the full set. For n relations that is 2^n - 1 subsets.
 *
 * Two decisions here exist for the lattice rather than for the algorithm:
 *
 * `considered` retains every candidate including the losers. A real planner
 * throws these away; keeping them is the reason the lattice view is possible,
 * and for 8 relations it is 255 cells with a few candidates each, which is
 * nothing. Do not optimise it away.
 *
 * `order` records the exact sequence in which cells were filled, so the lattice
 * animation replays the real search rather than an idealised sweep.
 */
import { formatExpr } from '../parser/ast.js';
import {
  groupAggregateCost, hashAggregateCost, hashJoinCost, limitCost,
  mergeJoinCost, nestedLoopCost, sortCost,
} from './cost.js';
import { groupCardinality, joinCardinality, makeContext, type CardinalityEstimate } from './cardinality.js';
import { accessPaths, nextPlanId, resetPathIds } from './paths.js';
import { indexScanCost } from './cost.js';
import { distinctCount } from '../stats/types.js';
import { interestingOrders, ordersFor, type InterestingOrder } from './orders.js';
import type { EstimationContext } from './selectivity.js';
import type { Statistics } from '../stats/types.js';
import {
  orderKey, satisfies,
  type CostParams, type JoinClause, type Plan, type QuerySpec,
  type ScanPlan, type SortOrder, type TableId,
} from './types.js';

export interface DpCell {
  /** Stable key: the relation aliases, sorted and joined. */
  key: string;
  relations: Set<TableId>;
  level: number;
  /**
   * Null when no plan was built for this subset — the relations in it are not
   * connected by any join clause, so joining them would be a cartesian product.
   * The lattice draws these cells recessed, which is how a reader sees what the
   * cartesian toggle actually excludes.
   */
  best: Plan | null;
  /** Cheapest plan for each interesting order it can produce. */
  bestByOrder: Map<string, { plan: Plan; order: SortOrder; reason: InterestingOrder['reason'] }>;
  /** Every candidate, winners and losers alike. The lattice draws all of them. */
  considered: Plan[];
  /** Why the cell is empty, when it is. */
  skipped: 'disconnected' | null;
}

export interface EnumerationResult {
  cells: DpCell[];
  /** The chosen plan, with sort, aggregate and limit applied on top. */
  winner: Plan;
  /** The join-order winner, before the post-join operators. */
  joinWinner: Plan;
  /** The exact fill order, for the animation. */
  order: DpCell[];
  spec: QuerySpec;
  estimation: EstimationContext;
  stats: {
    /** Every subset in the lattice: 2^n - 1. */
    subsets: number;
    /** Those a plan was actually built for. The rest are disconnected. */
    filledSubsets: number;
    candidates: number;
    ordersKept: number;
    cartesianConsidered: number;
    planningMs: number;
  };
}

export interface EnumerationOptions {
  params: CostParams;
  /** Cartesian products are excluded by default, with a toggle (PRD §4.5). */
  allowCartesian?: boolean;
  /** Setting this false is what orders.test.ts uses to show merge join vanish. */
  retainInterestingOrders?: boolean;
  now?: () => number;
}

export function enumerate(
  spec: QuerySpec, statistics: Statistics, options: EnumerationOptions,
): EnumerationResult {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const started = now();
  const retain = options.retainInterestingOrders !== false;

  resetPathIds();
  const estimation = makeContext(spec, statistics);
  const orders = interestingOrders(spec);
  const ctx = { spec, statistics, estimation, params: options.params, orders };

  const cells = new Map<string, DpCell>();
  const fillOrder: DpCell[] = [];
  let cartesianConsidered = 0;

  // ── Level 1: access paths ──────────────────────────────────────────────────
  for (const relation of spec.relations) {
    const candidates = accessPaths(relation, ctx);
    const cell = makeCell(new Set([relation.alias]), 1, candidates, orders, retain);
    cells.set(cell.key, cell);
    fillOrder.push(cell);
  }

  // ── Levels 2..n: joins ─────────────────────────────────────────────────────
  const aliases = spec.relations.map((r) => r.alias);
  for (let level = 2; level <= aliases.length; level++) {
    for (const subset of subsetsOfSize(aliases, level)) {
      const relations = new Set(subset);
      const candidates: Plan[] = [];

      // Every way of splitting this subset into an already-solved pair.
      for (const [left, right] of splits(subset)) {
        const leftCell = cells.get(setKey(left));
        const rightCell = cells.get(setKey(right));
        if (!leftCell || !rightCell) continue;

        const clauses = connectingClauses(spec, left, right);
        if (clauses.length === 0) {
          cartesianConsidered++;
          if (!options.allowCartesian) continue;
        }

        // The cardinality depends on the relations being joined, not on the
        // physical plans chosen for them, so it is estimated once per split
        // rather than once per plan pair. That is both correct and the
        // difference between planning eight tables in 40 ms and 300 ms.
        const outerPlans = plansOf(leftCell);
        const innerPlans = plansOf(rightCell);
        if (outerPlans.length === 0 || innerPlans.length === 0) continue;
        const cardinality = joinCardinality(
          outerPlans[0].estimatedRows, innerPlans[0].estimatedRows,
          clauses, outerPlans[0].relations, spec, estimation,
        );

        for (const outer of outerPlans) {
          for (const inner of innerPlans) {
            candidates.push(...joinPlans(
              outer, inner, clauses, cardinality, options.params, spec, statistics,
            ));
          }
        }
      }

      const cell = makeCell(relations, level, candidates, orders, retain);
      cells.set(cell.key, cell);
      // An empty cell is still part of the lattice, but there is nothing to
      // animate resolving, so it is not part of the fill order.
      if (cell.best) fillOrder.push(cell);
    }
  }

  const root = cells.get(setKey(aliases));
  if (!root || !root.best) {
    throw new Error(
      'No plan connects every table in the query. Add a join condition, or allow cartesian products.',
    );
  }

  // The top of the plan chooses among the root cell's retained plans, because a
  // plan already in the right order may beat a cheaper one that needs sorting.
  const finished = plansOf(root).map((p) => finishPlan(p, spec, estimation, options.params));
  finished.sort((a, b) => a.cost.total - b.cost.total);
  const winner = finished[0];

  let candidateCount = 0;
  let ordersKept = 0;
  let filled = 0;
  for (const cell of cells.values()) {
    candidateCount += cell.considered.length;
    ordersKept += cell.bestByOrder.size;
    if (cell.best) filled++;
  }

  return {
    cells: [...cells.values()],
    winner,
    joinWinner: root.best,
    order: fillOrder,
    spec,
    estimation,
    stats: {
      subsets: cells.size,
      filledSubsets: filled,
      candidates: candidateCount,
      ordersKept,
      cartesianConsidered,
      planningMs: now() - started,
    },
  };
}

// ── Cell construction ────────────────────────────────────────────────────────

function makeCell(
  relations: Set<TableId>, level: number, candidates: Plan[],
  orders: InterestingOrder[], retain: boolean,
): DpCell {
  const sorted = [...candidates].sort((a, b) => a.cost.total - b.cost.total);
  const best = sorted[0] ?? null;
  if (!best) {
    return {
      key: setKey([...relations]), relations, level,
      best: null, bestByOrder: new Map(), considered: [], skipped: 'disconnected',
    };
  }

  const bestByOrder = new Map<string, { plan: Plan; order: SortOrder; reason: InterestingOrder['reason'] }>();
  if (retain) {
    for (const interesting of ordersFor(orders, relations)) {
      const key = orderKey(interesting.order);
      for (const plan of sorted) {
        if (plan.order && satisfies(plan.order, interesting.order)) {
          // Retaining a plan that is already the overall winner adds nothing.
          if (plan !== best) {
            bestByOrder.set(key, { plan, order: interesting.order, reason: interesting.reason });
          }
          break;
        }
      }
    }
  }

  return {
    key: setKey([...relations]), relations, level,
    best, bestByOrder, considered: sorted, skipped: null,
  };
}

/** The plans a cell offers to the level above: its winner and its retained orders. */
function plansOf(cell: DpCell): Plan[] {
  if (!cell.best) return [];
  const out: Plan[] = [cell.best];
  for (const { plan } of cell.bestByOrder.values()) if (!out.includes(plan)) out.push(plan);
  return out;
}

// ── Join plan generation ─────────────────────────────────────────────────────

/**
 * Is this outer/inner assignment legal?
 *
 * A LEFT JOIN is not commutative: the preserved side must be the outer one. With
 * the sides swapped the join would null-extend the wrong relation and return a
 * different answer, which is what equivalence.test.ts caught.
 */
function validJoinOrder(
  clauses: JoinClause[], inner: Plan, spec: QuerySpec,
): boolean {
  for (const clause of clauses) {
    if (clause.type !== 'left') continue;
    const nullable = spec.nullableSide.has(clause.right) ? clause.right : clause.left;
    if (!inner.relations.includes(nullable)) return false;
  }
  return true;
}

function joinPlans(
  outer: Plan, inner: Plan, clauses: JoinClause[],
  cardinality: CardinalityEstimate, params: CostParams, spec: QuerySpec,
  statistics: Statistics,
): Plan[] {
  if (!validJoinOrder(clauses, inner, spec)) return [];
  const relations = [...outer.relations, ...inner.relations];
  const { rows, traces } = cardinality;
  const rowWidth = outer.rowWidth + inner.rowWidth;
  const joinType = clauses.some((c) => c.type === 'left') ? 'left' as const : 'inner' as const;
  const clause = clauses[0] ?? null;
  const out: Plan[] = [];

  const base = {
    estimatedRows: rows, rowWidth, relations, traces,
    clause, joinType, filters: [] as never[],
  };

  // Nested loop. Always available, pipelines, and the one that suffers when the
  // outer cardinality is underestimated.
  out.push({
    ...base,
    id: nextPlanId('join'),
    operator: 'Nested Loop',
    outer, inner,
    cost: nestedLoopCost(outer.cost, outer.estimatedRows, inner.cost, inner.estimatedRows, params),
    order: outer.order,
  });

  // Nested loop with a parameterized inner index scan: one index lookup per
  // outer row rather than a full rescan. This is the plan a real optimiser
  // reaches for on a foreign key, and it is the one that becomes a catastrophe
  // when the outer cardinality is underestimated.
  const parameterized = parameterizedInner(outer, inner, clauses, statistics, params);
  if (parameterized) {
    out.push({
      ...base,
      id: nextPlanId('join'),
      operator: 'Nested Loop',
      outer, inner: parameterized,
      cost: nestedLoopCost(
        outer.cost, outer.estimatedRows,
        parameterized.cost, parameterized.estimatedRows, params,
      ),
      order: outer.order,
    });
  }

  const equis = clauses.filter((c) => c.equi);
  if (equis.length > 0) {
    // Both hash orientations. Building the smaller side is the usual heuristic,
    // but a probe row costs more than a build row here, so the larger-build
    // orientation sometimes wins — and a heuristic that skipped it would make
    // the DP disagree with exhaustive search, which is exactly what
    // enumeration.test.ts checks.
    for (const buildInner of [true, false]) {
      const build = buildInner ? inner : outer;
      const probe = buildInner ? outer : inner;
      const hash = hashJoinCost(
        build.cost, build.estimatedRows, build.estimatedRows * build.rowWidth,
        probe.cost, probe.estimatedRows, params,
      );
      out.push({
        ...base,
        id: nextPlanId('join'),
        operator: 'Hash Join',
        outer, inner, buildInner,
          // Pass the cost object through rather than rebuilding it: spreading it
        // would force the lazy `terms` getter for every candidate.
        cost: hash,
        // A hash join destroys any ordering: rows come out in probe order, which
        // is the probe side's order only if the probe side is the outer one.
        order: probe === outer ? outer.order : null,
      });
    }

    // Merge join. Both sides must be ordered on the join columns; a sort is
    // added where they are not. This is where retained orders pay off — with
    // retention off, the sorted plans were discarded and both sorts are charged.
    const merge = mergeJoinPlan(outer, inner, equis, base, params);
    if (merge) out.push(merge);
  }

  return out;
}

function mergeJoinPlan(
  outer: Plan, inner: Plan, equis: JoinClause[],
  base: Omit<Plan & { operator: 'Nested Loop' }, 'id' | 'operator' | 'outer' | 'inner' | 'cost' | 'order'>,
  params: CostParams,
): Plan | null {
  // Pick the clause whose columns both sides can actually be sorted on.
  for (const clause of equis) {
    const outerSide = orientEquiFor(clause, outer.relations);
    const innerSide = orientEquiFor(clause, inner.relations);
    if (!outerSide || !innerSide) continue;

    const outerOrder: SortOrder = [outerSide];
    const innerOrder: SortOrder = [innerSide];

    // Where a side already carries the order — because an index scan produced
    // it, or because a retained plan below preserved it — the sort disappears.
    // With retention off, those plans were discarded and both sorts are paid.
    const left = ensureSorted(outer, outerOrder, params);
    const right = ensureSorted(inner, innerOrder, params);

    const cost = mergeJoinCost(left.plan.cost, outer.estimatedRows, right.plan.cost, inner.estimatedRows, params);
    return {
      ...base,
      id: nextPlanId('join'),
      operator: 'Merge Join',
      outer: left.plan,
      inner: right.plan,
      cost,
      // A merge join preserves the merge key's order.
      order: outerOrder,
    };
  }
  return null;
}

/**
 * An inner index scan bound to the outer row's join key, if one is available.
 *
 * Only a bare single-relation scan qualifies: the parameter has to reach an
 * index directly, and a subtree with a join or a sort in it has nowhere to put
 * the binding. The returned node's cost and row count describe ONE loop.
 */
function parameterizedInner(
  outer: Plan, inner: Plan, clauses: JoinClause[],
  statistics: Statistics, params: CostParams,
): ScanPlan | null {
  if (inner.operator !== 'Seq Scan' && inner.operator !== 'Index Scan') return null;
  if (inner.parameterizedBy) return null;
  const relation = inner.relation;

  for (const clause of clauses) {
    if (!clause.equi) continue;
    const innerIsLeft = clause.left === relation.alias;
    const innerColumn = innerIsLeft ? clause.equi.leftColumn : clause.equi.rightColumn;
    const outerRelation = innerIsLeft ? clause.right : clause.left;
    const outerColumn = innerIsLeft ? clause.equi.rightColumn : clause.equi.leftColumn;
    if (!outer.relations.includes(outerRelation)) continue;

    const index = statistics.indexes.get(`${relation.table}.${innerColumn}`);
    const stat = statistics.tables.get(relation.table)?.columns.get(innerColumn);
    if (!index || !stat) continue;

    // Rows matching one outer value: the table divided by the key's distinct
    // count. One for a primary key, more for a non-unique column.
    const perLoop = Math.max(1, relation.rowCount / distinctCount(stat));

    return {
      id: nextPlanId('scan'),
      operator: 'Index Scan',
      relation,
      filters: inner.filters,
      index: { column: innerColumn, entries: index.entries, height: index.height, pages: index.pages },
      indexQuals: [],
      parameterizedBy: { relation: outerRelation, column: outerColumn },
      cost: indexScanCost({
        // One descent and one leaf page per lookup.
        indexPages: 1,
        indexHeight: index.height,
        indexTuples: perLoop,
        rows: perLoop,
        tableRows: relation.rowCount,
        tablePages: relation.pageCount,
        correlation: stat.correlation,
        quals: inner.filters.length,
      }, params),
      estimatedRows: perLoop,
      rowWidth: relation.rowWidth,
      // The output is ordered within one loop only, which is no ordering the
      // plan above can rely on.
      order: null,
      relations: [relation.alias],
      traces: inner.traces,
    };
  }
  return null;
}

function orientEquiFor(clause: JoinClause, relations: TableId[]): SortOrder[number] | null {
  if (!clause.equi) return null;
  if (relations.includes(clause.left)) {
    return { relation: clause.left, column: clause.equi.leftColumn, direction: 'asc' };
  }
  if (relations.includes(clause.right)) {
    return { relation: clause.right, column: clause.equi.rightColumn, direction: 'asc' };
  }
  return null;
}

/** Add a Sort above `plan` unless its output already carries `order`. */
export function ensureSorted(
  plan: Plan, order: SortOrder, params: CostParams,
): { plan: Plan; wasSorted: boolean } {
  if (plan.order && satisfies(plan.order, order)) return { plan, wasSorted: false };
  const bytes = plan.estimatedRows * plan.rowWidth;
  const cost = sortCost(plan.cost, plan.estimatedRows, bytes, params);
  return {
    wasSorted: true,
    plan: {
      id: nextPlanId('sort'),
      operator: 'Sort',
      input: plan,
      sortKeys: order,
      bytes,
      cost,
      estimatedRows: plan.estimatedRows,
      rowWidth: plan.rowWidth,
      order,
      relations: plan.relations,
      traces: [],
    },
  };
}

// ── The top of the plan ──────────────────────────────────────────────────────

/**
 * Apply GROUP BY, HAVING, ORDER BY and LIMIT above a join tree.
 *
 * Exported because it applies to any candidate, not only the winner: the cost
 * breakdown compares complete plans, and equivalence.test.ts executes every
 * candidate the search produced, top included.
 */
export function finishPlan(
  joined: Plan, spec: QuerySpec, estimation: EstimationContext, params: CostParams,
): Plan {
  let plan = joined;

  if (spec.groupBy.length > 0 || spec.aggregates.length > 0) {
    const { rows: groups, traces } = groupCardinality(spec.groupBy, plan.estimatedRows, estimation);
    const groupOrder = groupSortOrder(spec);

    const candidates: Plan[] = [];

    // Hash aggregate: blocking, and it spills if the group table is too big.
    const hash = hashAggregateCost(
      plan.cost, plan.estimatedRows, groups, groups * plan.rowWidth,
      spec.aggregates.length, params,
    );
    candidates.push({
      id: nextPlanId('agg'), operator: 'HashAggregate',
      input: plan, groupBy: spec.groupBy, aggregates: spec.aggregates,
      having: spec.having, groups,
        // Pass the cost object through rather than rebuilding it: spreading it
        // would force the lazy `terms` getter for every candidate.
        cost: hash,
      estimatedRows: groups, rowWidth: plan.rowWidth,
      order: null, relations: plan.relations, traces,
    });

    // Group aggregate: needs sorted input, but pipelines once it has it. Free
    // when the join tree already produced the grouping order.
    if (groupOrder) {
      const sorted = ensureSorted(plan, groupOrder, params);
      const group = groupAggregateCost(sorted.plan.cost, plan.estimatedRows, groups, spec.aggregates.length, params);
      candidates.push({
        id: nextPlanId('agg'), operator: 'GroupAggregate',
        input: sorted.plan, groupBy: spec.groupBy, aggregates: spec.aggregates,
        having: spec.having, groups,
        cost: group,
        estimatedRows: groups, rowWidth: plan.rowWidth,
        order: groupOrder, relations: plan.relations, traces,
      });
    }

    candidates.sort((a, b) => a.cost.total - b.cost.total);
    plan = candidates[0];
  }

  if (spec.orderBy.length > 0) {
    const wanted = orderByOrder(spec);
    if (wanted) plan = ensureSorted(plan, wanted, params).plan;
  }

  if (spec.limit !== null) {
    plan = {
      id: nextPlanId('limit'), operator: 'Limit',
      input: plan, count: spec.limit,
      cost: limitCost(plan.cost, plan.estimatedRows, spec.limit),
      estimatedRows: Math.min(plan.estimatedRows, spec.limit),
      rowWidth: plan.rowWidth,
      order: plan.order, relations: plan.relations, traces: [],
    };
  }

  return plan;
}

function groupSortOrder(spec: QuerySpec): SortOrder | null {
  const keys: SortOrder = [];
  for (const e of spec.groupBy) {
    if (e.kind !== 'column') return null;
    const relation = e.table !== null
      ? spec.relations.find((r) => r.alias === e.table)
      : spec.relations[0];
    if (!relation) return null;
    keys.push({ relation: relation.alias, column: e.name, direction: 'asc' });
  }
  return keys.length > 0 ? keys : null;
}

function orderByOrder(spec: QuerySpec): SortOrder | null {
  const keys: SortOrder = [];
  for (const o of spec.orderBy) {
    const expr = o.expr;
    if (expr.kind !== 'column') return null;
    const relation = expr.table !== null
      ? spec.relations.find((r) => r.alias === expr.table)
      : spec.relations[0];
    if (!relation) return null;
    keys.push({ relation: relation.alias, column: expr.name, direction: o.direction });
  }
  return keys.length > 0 ? keys : null;
}

// ── Subset machinery ─────────────────────────────────────────────────────────

export function setKey(relations: TableId[]): string {
  return [...relations].sort().join('|');
}

function* subsetsOfSize(items: TableId[], size: number): Generator<TableId[]> {
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    if (popcount(mask) !== size) continue;
    const subset: TableId[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(items[i]);
    yield subset;
  }
}

/**
 * Every way to split a subset into two non-empty halves.
 *
 * Both orderings are produced, because a join is not symmetric here: which side
 * builds the hash and which side drives the nested loop changes the cost.
 */
function* splits(subset: TableId[]): Generator<[TableId[], TableId[]]> {
  const n = subset.length;
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const left: TableId[] = [];
    const right: TableId[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) left.push(subset[i]);
      else right.push(subset[i]);
    }
    yield [left, right];
  }
}

function connectingClauses(spec: QuerySpec, left: TableId[], right: TableId[]): JoinClause[] {
  const l = new Set(left);
  const r = new Set(right);
  return spec.joins.filter(
    (c) => (l.has(c.left) && r.has(c.right)) || (l.has(c.right) && r.has(c.left)),
  );
}

function popcount(n: number): number {
  let c = 0;
  while (n) { n &= n - 1; c++; }
  return c;
}

/** Human-readable relation set, for lattice cell labels. */
export function cellLabel(relations: Set<TableId>): string {
  return [...relations].sort().join('');
}

export { formatExpr };
