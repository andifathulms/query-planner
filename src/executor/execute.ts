/**
 * The volcano driver: build an operator tree from a plan, run it, and record
 * what actually happened at every node.
 *
 * Because the estimate and the actual come from one engine, their pairing is
 * exact rather than approximate (PRD §4.6). Real Postgres would give different
 * numbers, which the interface says once, plainly (PRD §6.2).
 */
import { formatExpr, type Expr } from '../parser/ast.js';
import type { Schema } from '../storage/table.js';
import { performanceClock, type Clock } from '../engine/clock.js';
import {
  compile, formatAggregate, isTrue, Layout, type Compiled, type Row, type Value,
} from './row.js';
import { Instrument, type NodeStats } from './trace.js';
import type { Operator } from './nodes/operator.js';
import { IndexScan, ParameterSlot, SeqScan, type IndexAccess } from './nodes/scan.js';
import { HashJoin, MergeJoin, NestedLoop } from './nodes/join.js';
import { Sort, type SortKeyEval } from './nodes/sort.js';
import { aggregateLayout, GroupAggregate, HashAggregate, type AggregateEval } from './nodes/aggregate.js';
import { Limit } from './nodes/limit.js';
import type {
  CostParams, JoinClause, Plan, QuerySpec, ScanPlan, TableId,
} from '../planner/types.js';

export interface ExecutionResult {
  /** Column headings, in projection order. */
  columns: string[];
  /**
   * Where each column came from, as `alias.column`, for display only.
   *
   * `columns` stays what Postgres would return, which for `SELECT k.nama,
   * c.nama` is `nama` twice. That is faithful and it is also unreadable in a
   * grid, so the interface qualifies a heading when the bare name is ambiguous
   * and leaves the engine's own answer alone.
   */
  columnSources: string[];
  rows: Value[][];
  /** Actuals keyed by plan node id, for pairing with the estimates. */
  stats: Map<string, NodeStats>;
  totalMs: number;
  /** Rows the plan produced before projection. */
  producedRows: number;
}

export interface ExecuteOptions {
  params: CostParams;
  clock?: Clock;
  /**
   * Materialise at most this many result rows.
   *
   * A display cap, not a LIMIT: the plan still runs to completion, because the
   * actual row count at every node is the number the whole app is comparing
   * against. Stopping the pipeline here would cap the actuals too, and the plan
   * tree would report an error ratio computed against the cap rather than
   * against the truth.
   */
  maxRows?: number;
}

export function execute(
  plan: Plan, spec: QuerySpec, schema: Schema, options: ExecuteOptions,
): ExecutionResult {
  const clock = options.clock ?? performanceClock;
  const origin = clock.now();
  const instruments = new Map<string, Instrument>();
  const builder = new Builder(spec, schema, options.params, clock, origin, instruments);

  const root = builder.build(plan);
  const projection = builder.projection(root.layout);

  const rows: Value[][] = [];
  const cap = options.maxRows ?? Infinity;
  let produced = 0;
  root.open();
  try {
    for (;;) {
      const row = root.next();
      if (row === null) break;
      produced++;
      // Past the cap the row is counted and discarded. The pipeline keeps
      // running so every node's instrumentation describes the whole execution.
      if (rows.length < cap) rows.push(projection.evaluate(row));
    }
  } finally {
    root.close();
  }

  return {
    columns: projection.columns,
    columnSources: projection.sources,
    rows,
    stats: new Map([...instruments].map(([id, i]) => [id, i.stats])),
    totalMs: clock.now() - origin,
    producedRows: produced,
  };
}

class Builder {
  constructor(
    private readonly spec: QuerySpec,
    private readonly schema: Schema,
    private readonly params: CostParams,
    private readonly clock: Clock,
    private readonly origin: number,
    private readonly instruments: Map<string, Instrument>,
  ) {}

  private instrument(id: string): Instrument {
    const i = new Instrument(this.clock, this.origin);
    this.instruments.set(id, i);
    return i;
  }

  build(plan: Plan): Operator {
    switch (plan.operator) {
      case 'Seq Scan': return this.seqScan(plan);
      case 'Index Scan': return this.indexScan(plan);
      case 'Nested Loop': case 'Hash Join': case 'Merge Join': return this.join(plan);
      case 'Sort': return this.sort(plan);
      case 'HashAggregate': case 'GroupAggregate': return this.aggregate(plan);
      case 'Limit': return this.limit(plan);
    }
  }

  private table(name: string) {
    const t = this.schema.tables.get(name);
    if (!t) throw new Error(`Table ${name} is not loaded`);
    return t;
  }

  private seqScan(plan: ScanPlan): Operator {
    const table = this.table(plan.relation.table);
    const layout = new Layout(table.columns.map((c) => ({ relation: plan.relation.alias, column: c.name })));
    return new SeqScan(
      plan.id, this.instrument(plan.id), table, plan.relation.alias,
      plan.filters.map((f) => compile(f.expr, layout)),
    );
  }

  private indexScan(plan: ScanPlan, slot?: ParameterSlot): Operator {
    const table = this.table(plan.relation.table);
    const index = this.schema.indexes.get(`${plan.relation.table}.${plan.index!.column}`);
    if (!index) throw new Error(`Index on ${plan.relation.table}.${plan.index!.column} is not loaded`);
    const layout = new Layout(table.columns.map((c) => ({ relation: plan.relation.alias, column: c.name })));

    const access = plan.parameterizedBy && slot
      ? { access: { kind: 'parameter' as const, slot }, driven: [] }
      : indexAccess(plan.indexQuals?.map((q) => q.expr) ?? [], plan.index!.column);
    // Any qual the index could not drive with becomes a filter, so the scan
    // still returns exactly the rows the plan promised.
    const undriven = (plan.indexQuals ?? []).filter((_, i) => !access.driven.includes(i));
    const filters = [...undriven, ...plan.filters].map((f) => compile(f.expr, layout));

    return new IndexScan(
      plan.id, this.instrument(plan.id), table, plan.relation.alias, index, access.access, filters,
    );
  }

  private join(plan: Plan & { operator: 'Nested Loop' | 'Hash Join' | 'Merge Join' }): Operator {
    const outer = this.build(plan.outer);

    // A parameterized inner index scan needs the slot the loop will write, so
    // it is built here rather than by the generic dispatch.
    const binding = plan.inner.operator === 'Index Scan' && plan.inner.parameterizedBy
      ? plan.inner.parameterizedBy
      : null;
    const slot = binding ? new ParameterSlot() : undefined;
    const inner = binding
      ? this.indexScan(plan.inner as ScanPlan, slot)
      : this.build(plan.inner);
    const joined = outer.layout.concat(inner.layout);

    // Every clause connecting the two subtrees is applied here. The planner
    // costed one of them; all of them must still be evaluated or the result is
    // wrong, which equivalence.test.ts would catch immediately.
    const clauses = this.spec.joins.filter(
      (c) => connects(c, plan.outer.relations, plan.inner.relations),
    );
    const kind = clauses.some((c) => c.type === 'left') ? 'left' as const : 'inner' as const;

    if (plan.operator === 'Nested Loop') {
      // The clause the parameter already enforces need not be re-checked per
      // row; the index returned only matching rows.
      const residualClauses = binding
        ? clauses.filter((c) => !enforcedByParameter(c, binding, plan.inner.relations))
        : clauses;
      const condition = residualClauses.length === 0
        ? null
        : compile(conjoin(residualClauses.map((c) => c.expr)), joined);
      const parameter = binding && slot
        ? {
            slot,
            key: compile(
              { kind: 'column', table: binding.relation, name: binding.column },
              outer.layout,
            ),
          }
        : null;
      return new NestedLoop(
        plan.id, this.instrument(plan.id), outer, inner, condition, kind, parameter,
      );
    }

    const equi = clauses.find((c) => c.equi);
    if (!equi || !equi.equi) {
      // The planner should not have produced a hash or merge join without an
      // equi-join clause. Falling back keeps the result correct rather than
      // silently dropping rows.
      const condition = clauses.length === 0 ? null : compile(conjoin(clauses.map((c) => c.expr)), joined);
      return new NestedLoop(plan.id, this.instrument(plan.id), outer, inner, condition, kind);
    }

    const outerHasLeft = plan.outer.relations.includes(equi.left);
    const outerColumn = outerHasLeft ? equi.equi.leftColumn : equi.equi.rightColumn;
    const innerColumn = outerHasLeft ? equi.equi.rightColumn : equi.equi.leftColumn;
    const outerRelation = outerHasLeft ? equi.left : equi.right;
    const innerRelation = outerHasLeft ? equi.right : equi.left;

    const outerKey = compile(
      { kind: 'column', table: outerRelation, name: outerColumn }, outer.layout,
    );
    const innerKey = compile(
      { kind: 'column', table: innerRelation, name: innerColumn }, inner.layout,
    );

    // Clauses beyond the one driving the join are residual conditions.
    const residual = clauses.filter((c) => c !== equi);
    const condition = residual.length === 0
      ? null
      : compile(conjoin(residual.map((c) => c.expr)), joined);

    if (plan.operator === 'Hash Join') {
      // The plan says which side is hashed, and the executor honours it: the
      // node's claimed output order follows from that choice, and a merge join
      // above would be fed unsorted input if the executor chose differently.
      // A LEFT JOIN must hash the inner side regardless, so the preserved outer
      // side is the one probed and unmatched rows can be null-extended.
      const buildInner = kind === 'left'
        ? true
        : plan.buildInner ?? (plan.inner.estimatedRows <= plan.outer.estimatedRows);
      const build = buildInner ? inner : outer;
      const probe = buildInner ? outer : inner;
      return new HashJoin(
        plan.id, this.instrument(plan.id), build, probe,
        buildInner ? innerKey : outerKey,
        buildInner ? outerKey : innerKey,
        condition, kind, buildInner, this.params.work_mem,
      );
    }

    return new MergeJoin(
      plan.id, this.instrument(plan.id), outer, inner, outerKey, innerKey, condition, kind,
    );
  }

  private sort(plan: Plan & { operator: 'Sort' }): Operator {
    const input = this.build(plan.input);
    const keys: SortKeyEval[] = plan.sortKeys.map((k) => ({
      value: compile({ kind: 'column', table: k.relation, name: k.column }, input.layout),
      direction: k.direction,
    }));
    return new Sort(plan.id, this.instrument(plan.id), input, keys, this.params.work_mem);
  }

  private aggregate(plan: Plan & { operator: 'HashAggregate' | 'GroupAggregate' }): Operator {
    const input = this.build(plan.input);
    const groupBy = plan.groupBy.map((g) => compile(g, input.layout));
    const aggregates: AggregateEval[] = plan.aggregates.map((a) => ({
      name: a.name,
      argument: a.argument ? compile(a.argument, input.layout) : null,
      label: a.label,
    }));

    // The output row is the grouping values followed by the aggregate values,
    // and HAVING is evaluated against that row rather than against the input.
    const groupBindings = plan.groupBy.map((g, i) => bindingFor(g, input.layout, i));
    const layout = aggregateLayout(groupBindings, aggregates);
    const slot = (label: string): number | undefined => {
      const i = aggregates.findIndex((a) => a.label === label);
      return i < 0 ? undefined : groupBindings.length + i;
    };
    const having = plan.having ? compile(plan.having, layout, slot) : null;

    if (plan.operator === 'HashAggregate') {
      return new HashAggregate(
        plan.id, this.instrument(plan.id), input, groupBy, aggregates, having, layout,
        this.params.work_mem,
      );
    }
    return new GroupAggregate(
      plan.id, this.instrument(plan.id), input, groupBy, aggregates, having, layout,
    );
  }

  private limit(plan: Plan & { operator: 'Limit' }): Operator {
    return new Limit(plan.id, this.instrument(plan.id), this.build(plan.input), plan.count);
  }

  /** Compile the SELECT list against the root operator's layout. */
  projection(layout: Layout): {
    columns: string[]; sources: string[]; evaluate: (row: Row) => Value[];
  } {
    if (this.spec.star) {
      // SELECT * follows the order the query named the tables in, not the order
      // the plan happened to join them. Otherwise two plans for one query would
      // return the same rows with their columns permuted, which is a different
      // answer to anyone reading it — and would make equivalence.test.ts compare
      // the wrong things.
      const bindings = this.spec.relations.flatMap(
        (relation) => layout.columns.filter((c) => c.relation === relation.alias),
      );
      const positions = bindings.map((b) => layout.indexOf(b.relation, b.column));
      const columns = bindings.map((c) => `${c.relation}.${c.column}`);
      return { columns, sources: columns, evaluate: (row) => positions.map((i) => row[i]) };
    }

    // Above an aggregate the row already holds the aggregate results, so a
    // reference to `count(*)` reads a slot rather than evaluating anything.
    const slot = (label: string): number | undefined => {
      const i = layout.columns.findIndex((c) => c.relation === '' && c.column === label);
      return i < 0 ? undefined : i;
    };

    const compiled = this.spec.projection.map((item) => compile(item.expr, layout, slot));
    const columns = this.spec.projection.map(
      (item, i) => item.alias
        ?? (item.expr.kind === 'aggregate' ? formatAggregate(item.expr) : null)
        ?? (item.expr.kind === 'column' ? item.expr.name : `column${i + 1}`),
    );
    const sources = this.spec.projection.map(
      (item, i) => (item.expr.kind === 'column' && item.expr.table
        ? `${item.expr.table}.${item.expr.name}`
        : columns[i]),
    );
    return { columns, sources, evaluate: (row) => compiled.map((c) => c(row)) };
  }
}

function bindingFor(expr: Expr, layout: Layout, fallbackIndex: number): { relation: string; column: string } {
  if (expr.kind === 'column') {
    const i = layout.indexOf(expr.table, expr.name);
    return layout.columns[i];
  }
  return { relation: '', column: `group${fallbackIndex + 1}` };
}

/** Did the parameter binding already enforce this clause? */
function enforcedByParameter(
  clause: JoinClause,
  binding: { relation: TableId; column: string },
  innerRelations: TableId[],
): boolean {
  if (!clause.equi) return false;
  const innerIsLeft = innerRelations.includes(clause.left);
  const outerRelation = innerIsLeft ? clause.right : clause.left;
  const outerColumn = innerIsLeft ? clause.equi.rightColumn : clause.equi.leftColumn;
  return outerRelation === binding.relation && outerColumn === binding.column;
}

function connects(clause: JoinClause, left: TableId[], right: TableId[]): boolean {
  const l = new Set(left), r = new Set(right);
  return (l.has(clause.left) && r.has(clause.right)) || (l.has(clause.right) && r.has(clause.left));
}

function conjoin(exprs: Expr[]): Expr {
  return exprs.reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }));
}

/**
 * Turn the index quals into a b-tree access.
 *
 * Only the quals the tree can actually drive with are consumed; `driven` names
 * them so the caller can turn the rest into filters. Combining a lower and an
 * upper bound into one range is what makes `BETWEEN` a single descent.
 */
export function indexAccess(
  quals: Expr[], column: string,
): { access: IndexAccess; driven: number[] } {
  let low: Value | null = null, lowInclusive = true;
  let high: Value | null = null, highInclusive = true;
  let equality: Value | undefined;
  let inList: Value[] | undefined;
  const driven: number[] = [];

  const apply = (bound: Bound): void => {
    switch (bound.kind) {
      case 'eq': equality = bound.value; break;
      case 'in': inList = bound.values; break;
      case 'ge': if (low === null || bound.value! > low) { low = bound.value!; lowInclusive = true; } break;
      case 'gt': if (low === null || bound.value! >= low) { low = bound.value!; lowInclusive = false; } break;
      case 'le': if (high === null || bound.value! < high) { high = bound.value!; highInclusive = true; } break;
      case 'lt': if (high === null || bound.value! <= high) { high = bound.value!; highInclusive = false; } break;
    }
  };

  quals.forEach((qual, i) => {
    // BETWEEN drives the tree as a single range, which is what makes it one
    // descent rather than a full scan with a filter.
    if (qual.kind === 'between' && !qual.negated
      && qual.operand.kind === 'column' && qual.operand.name === column
      && qual.low.kind === 'literal' && qual.high.kind === 'literal') {
      driven.push(i);
      apply({ kind: 'ge', value: qual.low.value });
      apply({ kind: 'le', value: qual.high.value });
      return;
    }
    const bound = boundOf(qual, column);
    if (!bound) return;
    driven.push(i);
    apply(bound);
  });

  if (equality !== undefined) return { access: { kind: 'equality', value: equality }, driven };
  if (inList !== undefined) return { access: { kind: 'in', values: inList }, driven };
  if (low !== null || high !== null) {
    return { access: { kind: 'range', low, lowInclusive, high, highInclusive }, driven };
  }
  return { access: { kind: 'all' }, driven: [] };
}

type Bound =
  | { kind: 'eq' | 'ge' | 'gt' | 'le' | 'lt'; value: Value; values?: undefined }
  | { kind: 'in'; values: Value[]; value?: undefined };

function boundOf(expr: Expr, column: string): Bound | null {
  const isColumn = (e: Expr): boolean => e.kind === 'column' && e.name === column;

  if (expr.kind === 'binary' && expr.left.kind === 'column' && expr.right.kind === 'literal') {
    if (!isColumn(expr.left)) return null;
    return operatorBound(expr.op, expr.right.value);
  }
  if (expr.kind === 'binary' && expr.right.kind === 'column' && expr.left.kind === 'literal') {
    if (!isColumn(expr.right)) return null;
    return operatorBound(flip(expr.op), expr.left.value);
  }
  if (expr.kind === 'in' && isColumn(expr.operand) && !expr.negated
    && expr.values.every((v) => v.kind === 'literal')) {
    return { kind: 'in', values: expr.values.map((v) => (v as Expr & { kind: 'literal' }).value) };
  }
  return null;
}

function operatorBound(op: string, value: Value): Bound | null {
  switch (op) {
    case '=': return { kind: 'eq', value };
    case '>=': return { kind: 'ge', value };
    case '>': return { kind: 'gt', value };
    case '<=': return { kind: 'le', value };
    case '<': return { kind: 'lt', value };
    default: return null;
  }
}

function flip(op: string): string {
  return op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : op === '>=' ? '<=' : op;
}

export { formatExpr, isTrue };
export type { Compiled, NodeStats };
