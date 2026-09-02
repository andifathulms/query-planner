/**
 * Resolve a parsed statement into the planner's terms.
 *
 * Splits the WHERE clause into restrictions (one relation) and join clauses
 * (two), which is the split the DP needs: restrictions are pushed into scans and
 * join clauses drive the enumeration.
 */
import {
  columnsIn, conjuncts, formatExpr, hasAggregate,
  type Expr, type SelectStatement,
} from '../parser/ast.js';
import type { Statistics } from '../stats/types.js';
import type { AggregateSpec, JoinClause, QueryRelation, QuerySpec, Restriction, TableId } from './types.js';

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningError';
  }
}

export function resolveQuery(stmt: SelectStatement, statistics: Statistics): QuerySpec {
  const relations: QueryRelation[] = [];
  const byAlias = new Map<string, QueryRelation>();

  const addRelation = (table: string, alias: string): void => {
    const stat = statistics.tables.get(table);
    if (!stat) throw new PlanningError(`Table ${table} does not exist in this dataset`);
    if (byAlias.has(alias)) throw new PlanningError(`Alias ${alias} is used more than once`);
    const relation: QueryRelation = {
      alias, table,
      rowCount: stat.rowCount, pageCount: stat.pageCount, rowWidth: stat.rowWidth,
    };
    relations.push(relation);
    byAlias.set(alias, relation);
  };

  addRelation(stmt.from.table, stmt.from.alias);
  for (const join of stmt.joins) addRelation(join.right.table, join.right.alias);

  // Which relation does each column belong to? An unqualified column names the
  // one relation in scope that has it.
  const relationOf = (table: string | null, column: string): TableId => {
    if (table !== null) {
      const relation = byAlias.get(table);
      if (!relation) throw new PlanningError(`There is no table or alias named ${table} in this query`);
      if (!statistics.tables.get(relation.table)?.columns.has(column)) {
        throw new PlanningError(`Column ${column} does not exist on ${relation.table}`);
      }
      return relation.alias;
    }
    const candidates = relations.filter(
      (r) => statistics.tables.get(r.table)?.columns.has(column),
    );
    if (candidates.length === 0) throw new PlanningError(`Column ${column} does not exist on any table in this query`);
    if (candidates.length > 1) {
      throw new PlanningError(
        `Column ${column} is ambiguous; it exists on ${candidates.map((c) => c.alias).join(' and ')}`,
      );
    }
    return candidates[0].alias;
  };

  const relationsIn = (expr: Expr): Set<TableId> => {
    const set = new Set<TableId>();
    for (const c of columnsIn(expr)) set.add(relationOf(c.table, c.name));
    return set;
  };

  const restrictions: Restriction[] = [];
  const joins: JoinClause[] = [];
  const nullableSide = new Set<TableId>();
  let counter = 0;

  const classify = (expr: Expr, joinType: 'inner' | 'left'): void => {
    const involved = [...relationsIn(expr)];
    const id = `c${counter++}`;
    const text = formatExpr(expr);

    if (involved.length === 1) {
      restrictions.push({ id, relation: involved[0], expr, text });
      return;
    }
    if (involved.length === 2) {
      joins.push({
        id, left: involved[0], right: involved[1],
        equi: asEquiJoin(expr, relationOf),
        expr, text, type: joinType,
      });
      return;
    }
    if (involved.length === 0) {
      // A constant predicate. Attach it to the first relation so it is still
      // evaluated and still costed.
      restrictions.push({ id, relation: relations[0].alias, expr, text });
      return;
    }
    throw new PlanningError(
      `The clause \`${text}\` mentions ${involved.length} tables; only one- and two-table clauses are supported`,
    );
  };

  for (const join of stmt.joins) {
    if (join.type === 'left') nullableSide.add(join.right.alias);
    if (join.on) for (const c of conjuncts(join.on)) classify(c, join.type);
  }
  for (const c of conjuncts(stmt.where)) classify(c, 'inner');

  const aggregates: AggregateSpec[] = [];
  const collectAggregates = (expr: Expr): void => {
    const walk = (n: Expr): void => {
      if (n.kind === 'aggregate') {
        const label = formatExpr(n);
        if (!aggregates.some((a) => a.label === label)) {
          aggregates.push({ name: n.name, argument: n.argument, label });
        }
        return;
      }
      switch (n.kind) {
        case 'binary': walk(n.left); walk(n.right); break;
        case 'unary': walk(n.operand); break;
        case 'between': walk(n.operand); walk(n.low); walk(n.high); break;
        case 'in': walk(n.operand); n.values.forEach(walk); break;
        case 'isnull': walk(n.operand); break;
        default: break;
      }
    };
    walk(expr);
  };
  for (const item of stmt.select) collectAggregates(item.expr);
  if (stmt.having) collectAggregates(stmt.having);

  if (stmt.having && stmt.groupBy.length === 0 && aggregates.length === 0) {
    throw new PlanningError('HAVING requires GROUP BY or an aggregate');
  }
  for (const item of stmt.select) {
    if (stmt.groupBy.length > 0 && !hasAggregate(item.expr)) {
      const text = formatExpr(item.expr);
      if (!stmt.groupBy.some((g) => formatExpr(g) === text)) {
        throw new PlanningError(
          `\`${text}\` must appear in GROUP BY or be used in an aggregate`,
        );
      }
    }
  }

  // Validate every column reference now, so errors name the column rather than
  // surfacing as an undefined halfway through execution.
  const validate = (expr: Expr): void => { relationsIn(expr); };
  for (const item of stmt.select) validate(item.expr);
  for (const g of stmt.groupBy) validate(g);
  for (const o of stmt.orderBy) validate(o.expr);
  if (stmt.having) validate(stmt.having);

  return {
    relations,
    restrictions,
    joins,
    nullableSide,
    projection: stmt.select,
    star: stmt.star,
    groupBy: stmt.groupBy,
    aggregates,
    having: stmt.having,
    orderBy: stmt.orderBy,
    limit: stmt.limit,
  };
}

/** Is this clause `a.x = b.y`? Only such clauses can drive a hash or merge join. */
function asEquiJoin(
  expr: Expr, relationOf: (table: string | null, column: string) => TableId,
): JoinClause['equi'] {
  if (expr.kind !== 'binary' || expr.op !== '=') return null;
  if (expr.left.kind !== 'column' || expr.right.kind !== 'column') return null;
  const l = relationOf(expr.left.table, expr.left.name);
  const r = relationOf(expr.right.table, expr.right.name);
  if (l === r) return null;
  return { leftColumn: expr.left.name, rightColumn: expr.right.name };
}

/** Order the equi-join columns to match a (left, right) relation pair. */
export function orientEqui(
  clause: JoinClause, left: TableId,
): { leftColumn: string; rightColumn: string } | null {
  if (!clause.equi) return null;
  return clause.left === left
    ? clause.equi
    : { leftColumn: clause.equi.rightColumn, rightColumn: clause.equi.leftColumn };
}
