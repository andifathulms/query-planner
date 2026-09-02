/**
 * Interesting orders (CLAUDE.md §4).
 *
 * A sort order is interesting if some later operator could exploit it: a merge
 * join's two sides, a GROUP BY, or the final ORDER BY. A plan is retained if it
 * is cheapest overall *or* cheapest for one of these orders.
 *
 * Without this, merge join never wins — a sorted intermediate is never the
 * cheapest plan for its own subset, so it is discarded before anything can use
 * it — and the app would quietly teach something false. `orders.test.ts` covers
 * the case with retention disabled.
 */
import type { Expr } from '../parser/ast.js';
import type { QuerySpec, SortOrder, TableId } from './types.js';
import { orderKey } from './types.js';

export interface InterestingOrder {
  order: SortOrder;
  /** Why this order is worth keeping. The lattice labels the mark with it. */
  reason: 'merge join' | 'group by' | 'order by';
}

export function interestingOrders(spec: QuerySpec): InterestingOrder[] {
  const out: InterestingOrder[] = [];
  const seen = new Set<string>();
  const add = (order: SortOrder, reason: InterestingOrder['reason']): void => {
    if (order.length === 0) return;
    const key = orderKey(order);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ order, reason });
  };

  // Each side of every equi-join could feed a merge join.
  for (const clause of spec.joins) {
    if (!clause.equi) continue;
    add([{ relation: clause.left, column: clause.equi.leftColumn, direction: 'asc' }], 'merge join');
    add([{ relation: clause.right, column: clause.equi.rightColumn, direction: 'asc' }], 'merge join');
  }

  const grouping = columnOrder(spec.groupBy, spec, 'asc');
  if (grouping) add(grouping, 'group by');

  const ordering = spec.orderBy
    .map((o) => columnKey(o.expr, spec, o.direction))
    .filter((k): k is SortOrder[number] => k !== null);
  if (ordering.length === spec.orderBy.length && ordering.length > 0) add(ordering, 'order by');

  return out;
}

/** The orders a subset of relations can actually produce. */
export function ordersFor(orders: InterestingOrder[], relations: Set<TableId>): InterestingOrder[] {
  return orders.filter((o) => o.order.every((k) => relations.has(k.relation)));
}

function columnOrder(exprs: Expr[], spec: QuerySpec, direction: 'asc' | 'desc'): SortOrder | null {
  const keys = exprs.map((e) => columnKey(e, spec, direction));
  if (keys.some((k) => k === null)) return null;
  return keys as SortOrder;
}

function columnKey(expr: Expr, spec: QuerySpec, direction: 'asc' | 'desc'): SortOrder[number] | null {
  if (expr.kind !== 'column') return null;
  const relation = expr.table !== null
    ? spec.relations.find((r) => r.alias === expr.table)
    : spec.relations[0];
  if (!relation) return null;
  return { relation: relation.alias, column: expr.name, direction };
}

/** Which relations does an order mention? */
export function orderRelations(order: SortOrder): Set<TableId> {
  return new Set(order.map((k) => k.relation));
}
