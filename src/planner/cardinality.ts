/**
 * Cardinality estimation: turning selectivities into row counts.
 *
 * Every number here is a belief. The executor records the truth beside it and
 * the plan tree draws the distance between the two (DESIGN.md §0).
 */
import { formatExpr } from '../parser/ast.js';
import { distinctCount, type ColumnStatistics, type Statistics } from '../stats/types.js';
import { estimateExpr, estimateJoin, findMultivariate, type EstimationContext } from './selectivity.js';
import { ndistinctKey } from '../stats/multivariate/ndistinct.js';
import type {
  JoinClause, QueryRelation, QuerySpec, Restriction, SelectivityTrace, TableId,
} from './types.js';
import type { Expr } from '../parser/ast.js';

export interface CardinalityEstimate {
  rows: number;
  traces: SelectivityTrace[];
}

export function makeContext(spec: QuerySpec, statistics: Statistics): EstimationContext {
  return {
    statistics,
    relations: new Map(spec.relations.map((r) => [r.alias, r])),
  };
}

/**
 * Rows a scan of one relation produces after its restrictions.
 *
 * The restrictions are estimated as a conjunction rather than one at a time, so
 * a multivariate statistic covering them can apply — which is the difference
 * between the app's before and after.
 */
export function scanCardinality(
  relation: QueryRelation, restrictions: Restriction[], ctx: EstimationContext,
): CardinalityEstimate {
  if (restrictions.length === 0) {
    return { rows: relation.rowCount, traces: [] };
  }
  const combined: Expr = restrictions
    .map((r) => r.expr)
    .reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }));
  const estimate = estimateExpr(combined, ctx);
  return {
    // A qualifying scan never estimates fewer than one row. Postgres does the
    // same, and it matters: a zero would make every plan above it free.
    rows: Math.max(1, relation.rowCount * estimate.selectivity),
    traces: [estimate.trace],
  };
}

/**
 * Rows a join produces.
 *
 * The product of the two inputs times the selectivity of every clause connecting
 * them. Multiple join clauses multiply under independence, which is the same
 * assumption as everywhere else and is labelled the same way.
 */
export function joinCardinality(
  outerRows: number, innerRows: number,
  clauses: JoinClause[],
  outerRelations: TableId[],
  spec: QuerySpec,
  ctx: EstimationContext,
): CardinalityEstimate {
  if (clauses.length === 0) {
    return {
      rows: Math.max(1, outerRows * innerRows),
      traces: [{
        clause: 'cartesian product',
        method: 'default',
        inputs: { outerRows, innerRows },
        result: 1,
        assumptions: ['no clause connects these relations, so every pair of rows is produced'],
      }],
    };
  }

  const traces: SelectivityTrace[] = [];
  let selectivity = 1;
  for (const clause of clauses) {
    const e = joinClauseSelectivity(clause, ctx);
    traces.push(e.trace);
    selectivity *= e.selectivity;
  }
  if (clauses.length > 1) {
    traces.push({
      clause: clauses.map((c) => c.text).join(' AND '),
      method: 'independence',
      inputs: Object.fromEntries(traces.map((t, i) => [`clause${i + 1}`, t.result])),
      result: selectivity,
      assumptions: ['the join clauses are assumed independent of one another'],
      children: [...traces],
    });
  }

  let rows = Math.max(1, outerRows * innerRows * selectivity);

  // A LEFT JOIN emits every outer row, matched or not, so it can never produce
  // fewer rows than its outer side.
  const nullable = clauses.some((c) => spec.nullableSide.has(c.right) || spec.nullableSide.has(c.left));
  if (nullable) {
    const outerIsPreserved = clauses.every((c) => {
      const inner = spec.nullableSide.has(c.right) ? c.right : c.left;
      return !outerRelations.includes(inner);
    });
    if (outerIsPreserved) rows = Math.max(rows, outerRows);
  }

  return { rows, traces };
}

export function joinClauseSelectivity(clause: JoinClause, ctx: EstimationContext) {
  if (!clause.equi) {
    // A non-equality join clause. No join statistics apply, so it is estimated
    // as an ordinary predicate would be.
    return estimateExpr(clause.expr, ctx);
  }
  const left = ctx.relations.get(clause.left);
  const right = ctx.relations.get(clause.right);
  const leftStat = left ? ctx.statistics.tables.get(left.table)?.columns.get(clause.equi.leftColumn) ?? null : null;
  const rightStat = right ? ctx.statistics.tables.get(right.table)?.columns.get(clause.equi.rightColumn) ?? null : null;
  return estimateJoin(leftStat, rightStat, clause.text);
}

/**
 * How many groups will a GROUP BY produce?
 *
 * Independence says the product of each column's distinct count, which for
 * correlated columns is wildly high — and this number sizes a hash aggregate, so
 * overestimating it predicts a spill that will not happen and underestimating it
 * predicts memory that is not there. Multivariate n-distinct is the repair, and
 * this is where it is spent.
 */
export function groupCardinality(
  groupBy: Expr[], inputRows: number, ctx: EstimationContext,
): CardinalityEstimate {
  if (groupBy.length === 0) return { rows: 1, traces: [] };

  const columns: Array<{ table: string; column: string; stat: ColumnStatistics }> = [];
  for (const expr of groupBy) {
    if (expr.kind !== 'column') continue;
    for (const relation of ctx.relations.values()) {
      const stat = ctx.statistics.tables.get(relation.table)?.columns.get(expr.name);
      if (stat && (expr.table === null || expr.table === relation.alias)) {
        columns.push({ table: relation.table, column: expr.name, stat });
        break;
      }
    }
  }
  if (columns.length === 0) {
    return {
      rows: Math.max(1, Math.min(inputRows, Math.sqrt(inputRows))),
      traces: [{
        clause: groupBy.map(formatExpr).join(', '),
        method: 'default',
        inputs: { inputRows },
        result: Math.sqrt(inputRows),
        assumptions: ['no statistics apply to these grouping expressions'],
      }],
    };
  }

  const clause = groupBy.map(formatExpr).join(', ');
  const table = columns[0].table;

  if (columns.length > 1 && columns.every((c) => c.table === table)) {
    const stat = findMultivariate(ctx, table, columns.map((c) => c.column));
    const listed = stat?.nDistinct?.get(ndistinctKey(columns.map((c) => c.column)));
    if (listed !== undefined) {
      const rows = Math.max(1, Math.min(inputRows, listed));
      return {
        rows,
        traces: [{
          clause, method: 'multivariate-ndistinct',
          inputs: {
            combinations: listed,
            independenceWouldSay: columns.reduce((p, c) => p * distinctCount(c.stat), 1),
          },
          result: rows,
          assumptions: [
            `the distinct combinations are counted directly by the multivariate n-distinct statistic on ${stat!.columns.join(', ')}`,
          ],
        }],
      };
    }
  }

  const product = columns.reduce((p, c) => p * distinctCount(c.stat), 1);
  const rows = Math.max(1, Math.min(inputRows, product));
  return {
    rows,
    traces: [{
      clause, method: columns.length > 1 ? 'independence' : 'default',
      inputs: Object.fromEntries(columns.map((c) => [c.column, distinctCount(c.stat)])),
      result: rows,
      assumptions: columns.length > 1
        ? [`independence between ${columns.map((c) => c.column).join(' and ')}, so the distinct counts are multiplied`]
        : ['the distinct count is taken from the column statistics'],
    }],
  };
}
