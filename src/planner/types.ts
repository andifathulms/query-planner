/**
 * Planner types.
 *
 * Nothing here reaches storage. The planner receives a `Statistics` object and a
 * resolved query, and everything it believes is derived from those two
 * (CLAUDE.md §3).
 */
import type { Expr, JoinType, OrderByItem, SelectItem, Value } from '../parser/ast.js';
import type { AggregateName } from '../parser/ast.js';

export type TableId = string; // the alias, which is unique within a query

export interface QueryRelation {
  alias: TableId;
  table: string;
  rowCount: number;
  pageCount: number;
  rowWidth: number;
}

/** A WHERE clause that mentions exactly one relation. */
export interface Restriction {
  id: string;
  relation: TableId;
  expr: Expr;
  text: string;
}

/** A clause that connects two relations. Only equi-joins can drive hash or merge. */
export interface JoinClause {
  id: string;
  left: TableId;
  right: TableId;
  /** Column on each side, when this is a plain equi-join. */
  equi: { leftColumn: string; rightColumn: string } | null;
  expr: Expr;
  text: string;
  type: JoinType;
}

export interface AggregateSpec {
  name: AggregateName;
  argument: Expr | null;
  label: string;
}

/** The query, resolved against the schema and split into the planner's terms. */
export interface QuerySpec {
  relations: QueryRelation[];
  restrictions: Restriction[];
  joins: JoinClause[];
  /** Relations that must appear on the inner side of a left join, keyed by alias. */
  nullableSide: Set<TableId>;
  projection: SelectItem[];
  star: boolean;
  groupBy: Expr[];
  aggregates: AggregateSpec[];
  having: Expr | null;
  orderBy: OrderByItem[];
  limit: number | null;
}

// ── Sort orders ──────────────────────────────────────────────────────────────

export interface SortKey {
  relation: TableId;
  column: string;
  direction: 'asc' | 'desc';
}

export type SortOrder = SortKey[];

export function orderKey(order: SortOrder): string {
  return order.map((k) => `${k.relation}.${k.column}:${k.direction}`).join(',');
}

/** Does `order` already satisfy `wanted`? A prefix match is enough. */
export function satisfies(order: SortOrder, wanted: SortOrder): boolean {
  if (wanted.length > order.length) return false;
  return wanted.every((k, i) =>
    order[i].relation === k.relation && order[i].column === k.column
    && order[i].direction === k.direction);
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/**
 * Costs are (startup, total) pairs, not scalars (CLAUDE.md §3). LIMIT selects on
 * startup cost, and a scalar model could not express why `LIMIT 10` wants a
 * different plan.
 */
export interface CostBreakdown {
  startup: number;
  total: number;
  terms: Array<{ label: string; value: number; kind: 'io' | 'cpu' }>;
}

export interface CostParams {
  seq_page_cost: number;
  random_page_cost: number;
  cpu_tuple_cost: number;
  cpu_index_tuple_cost: number;
  cpu_operator_cost: number;
  /** Bytes. */
  work_mem: number;
  /** Bytes. */
  effective_cache_size: number;
}

export const DEFAULT_COST_PARAMS: CostParams = {
  seq_page_cost: 1.0,
  random_page_cost: 4.0,
  cpu_tuple_cost: 0.01,
  cpu_index_tuple_cost: 0.005,
  cpu_operator_cost: 0.0025,
  work_mem: 4 * 1024 * 1024,
  effective_cache_size: 4 * 1024 * 1024 * 1024,
};

// ── Selectivity traces ───────────────────────────────────────────────────────

export type SelectivityMethod =
  | 'mcv' | 'histogram' | 'default' | 'independence'
  | 'dependency' | 'multivariate-mcv' | 'multivariate-ndistinct' | 'join'
  | 'nullfrac' | 'disjunction' | 'negation';

/**
 * Every selectivity computation returns one of these (CLAUDE.md §2). The
 * histogram and correlation views render it and never recompute — the display
 * and the computation are one object.
 */
export interface SelectivityTrace {
  clause: string;
  method: SelectivityMethod;
  inputs: Record<string, number>;
  result: number;
  assumptions: string[];
  /** Sub-traces, for conjunctions and disjunctions. */
  children?: SelectivityTrace[];
}

// ── Plans ────────────────────────────────────────────────────────────────────

export type ScanKind = 'Seq Scan' | 'Index Scan';
export type JoinKind = 'Nested Loop' | 'Hash Join' | 'Merge Join';
export type OperatorName =
  | ScanKind | JoinKind | 'Sort' | 'HashAggregate' | 'GroupAggregate' | 'Limit';

interface PlanBase {
  id: string;
  operator: OperatorName;
  cost: CostBreakdown;
  /** The planner's belief. The executor records the truth beside it. */
  estimatedRows: number;
  rowWidth: number;
  /** The order this node's output is known to be in, if any. */
  order: SortOrder | null;
  /** Relations covered by this subtree. */
  relations: TableId[];
  traces: SelectivityTrace[];
}

export interface ScanPlan extends PlanBase {
  operator: ScanKind;
  relation: QueryRelation;
  /** Restrictions evaluated by this scan. */
  filters: Restriction[];
  /** For an index scan: the index used, and the quals it drove with. */
  index?: { column: string; entries: number; height: number; pages: number };
  indexQuals?: Restriction[];
}

export interface JoinPlan extends PlanBase {
  operator: JoinKind;
  outer: Plan;
  inner: Plan;
  /**
   * Hash Join only: whether the inner side is the one hashed.
   *
   * The executor must honour this rather than re-deciding, because the node's
   * `order` is derived from it — a hash join emits in probe order, so choosing
   * the other orientation would silently break the ordering a merge join above
   * it was planned to rely on.
   */
  buildInner?: boolean;
  clause: JoinClause | null;
  joinType: JoinType;
  /** Restrictions applied above the join. */
  filters: Restriction[];
}

export interface SortPlan extends PlanBase {
  operator: 'Sort';
  input: Plan;
  sortKeys: SortOrder;
  /** Estimated bytes to sort. Drives the spill decision. */
  bytes: number;
}

export interface AggregatePlan extends PlanBase {
  operator: 'HashAggregate' | 'GroupAggregate';
  input: Plan;
  groupBy: Expr[];
  aggregates: AggregateSpec[];
  having: Expr | null;
  groups: number;
}

export interface LimitPlan extends PlanBase {
  operator: 'Limit';
  input: Plan;
  count: number;
}

export type Plan = ScanPlan | JoinPlan | SortPlan | AggregatePlan | LimitPlan;

export function planChildren(plan: Plan): Plan[] {
  switch (plan.operator) {
    case 'Seq Scan': case 'Index Scan': return [];
    case 'Nested Loop': case 'Hash Join': case 'Merge Join':
      return [plan.outer, plan.inner];
    default: return [plan.input];
  }
}

export function walkPlan(plan: Plan, visit: (p: Plan, depth: number) => void, depth = 0): void {
  visit(plan, depth);
  for (const child of planChildren(plan)) walkPlan(child, visit, depth + 1);
}

export function planLabel(plan: Plan): string {
  switch (plan.operator) {
    case 'Seq Scan':
    case 'Index Scan':
      return `${plan.operator} on ${plan.relation.table}${plan.relation.alias !== plan.relation.table ? ` ${plan.relation.alias}` : ''}`;
    default:
      return plan.operator;
  }
}

export type { Value };
