/**
 * Access path generation: every way to read one relation.
 *
 * A sequential scan always, plus an index scan for every index whose column an
 * equality or range restriction constrains, plus an index scan used purely for
 * its ordering when that ordering is interesting.
 *
 * All of them are returned, losers included. The lattice draws the density of
 * candidates, so throwing them away here would empty level 1 of the picture.
 */
import { formatExpr, type Expr } from '../parser/ast.js';
import { indexScanCost, seqScanCost } from './cost.js';
import { scanCardinality } from './cardinality.js';
import { estimateExpr, type EstimationContext } from './selectivity.js';
import type { InterestingOrder } from './orders.js';
import type {
  CostParams, QueryRelation, QuerySpec, ScanPlan, SortOrder,
} from './types.js';
import type { Statistics } from '../stats/types.js';

let pathCounter = 0;
export function resetPathIds(): void { pathCounter = 0; }
function nextId(prefix: string): string { return `${prefix}${pathCounter++}`; }

export interface PathContext {
  spec: QuerySpec;
  statistics: Statistics;
  estimation: EstimationContext;
  params: CostParams;
  orders: InterestingOrder[];
}

export function accessPaths(relation: QueryRelation, ctx: PathContext): ScanPlan[] {
  const restrictions = ctx.spec.restrictions.filter((r) => r.relation === relation.alias);
  const { rows, traces } = scanCardinality(relation, restrictions, ctx.estimation);
  const paths: ScanPlan[] = [];

  paths.push({
    id: nextId('scan'),
    operator: 'Seq Scan',
    relation,
    filters: restrictions,
    cost: seqScanCost(relation.pageCount, relation.rowCount, restrictions.length, ctx.params),
    estimatedRows: rows,
    rowWidth: relation.rowWidth,
    // A sequential scan reads in physical order, which is not a logical order
    // the planner can rely on.
    order: null,
    relations: [relation.alias],
    traces,
  });

  for (const index of ctx.statistics.indexes.values()) {
    if (index.table !== relation.table) continue;
    const stat = ctx.statistics.tables.get(relation.table)?.columns.get(index.column);
    if (!stat) continue;

    const indexable = restrictions.filter((r) => constrains(r.expr, index.column, relation.alias));
    const order: SortOrder = [{ relation: relation.alias, column: index.column, direction: 'asc' }];
    const orderIsInteresting = ctx.orders.some(
      (o) => o.order.length >= 1
        && o.order[0].relation === relation.alias && o.order[0].column === index.column,
    );

    // An index with no useful qual is worth reading only for its ordering, and
    // then only if something above could use that ordering.
    if (indexable.length === 0 && !orderIsInteresting) continue;

    // Only the index quals reduce what the index scan reads; the remaining
    // restrictions are filters applied after the heap fetch.
    const indexSelectivity = indexable.length === 0
      ? 1
      : estimateExpr(conjoin(indexable.map((r) => r.expr)), ctx.estimation).selectivity;
    const indexRows = Math.max(1, relation.rowCount * indexSelectivity);
    const filters = restrictions.filter((r) => !indexable.includes(r));

    paths.push({
      id: nextId('scan'),
      operator: 'Index Scan',
      relation,
      filters,
      index: { column: index.column, entries: index.entries, height: index.height, pages: index.pages },
      indexQuals: indexable,
      cost: indexScanCost({
        indexPages: Math.max(1, Math.ceil(index.pages * indexSelectivity)),
        indexHeight: index.height,
        indexTuples: indexRows,
        rows: indexRows,
        tableRows: relation.rowCount,
        tablePages: relation.pageCount,
        correlation: stat.correlation,
        quals: filters.length,
      }, ctx.params),
      // The scan reads the index in key order, so its output carries that order
      // — which is the whole reason a merge join can ever avoid a sort.
      estimatedRows: rows,
      rowWidth: relation.rowWidth,
      order,
      relations: [relation.alias],
      traces,
    });
  }

  return paths;
}

/** Does this restriction constrain `column` in a way a b-tree can drive? */
function constrains(expr: Expr, column: string, alias: string): boolean {
  const refersToColumn = (e: Expr): boolean =>
    e.kind === 'column' && e.name === column && (e.table === null || e.table === alias);

  switch (expr.kind) {
    case 'binary':
      if (!['=', '<', '<=', '>', '>='].includes(expr.op)) return false;
      return (refersToColumn(expr.left) && expr.right.kind === 'literal')
        || (refersToColumn(expr.right) && expr.left.kind === 'literal');
    case 'between':
      return refersToColumn(expr.operand)
        && expr.low.kind === 'literal' && expr.high.kind === 'literal' && !expr.negated;
    case 'in':
      return refersToColumn(expr.operand)
        && expr.values.every((v) => v.kind === 'literal') && !expr.negated;
    default:
      return false;
  }
}

export function conjoin(exprs: Expr[]): Expr {
  return exprs.reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }));
}

export function describeScan(plan: ScanPlan): string {
  if (plan.operator === 'Index Scan' && plan.index) {
    const quals = plan.indexQuals?.map((q) => formatExpr(q.expr)).join(' AND ');
    return `Index Scan using ${plan.relation.table}_${plan.index.column}_idx${quals ? ` (${quals})` : ' for ordering'}`;
  }
  return 'Seq Scan';
}

export function nextPlanId(prefix: string): string { return nextId(prefix); }
