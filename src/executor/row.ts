/**
 * Rows, layouts, and expression evaluation.
 *
 * A row is a flat `Value[]`. A `Layout` says which position holds which
 * relation's column, so a join is an array concatenation and a column reference
 * is an array index. Expressions are compiled against a layout once, at open
 * time, rather than interpreted per row — the executor runs millions of rows and
 * the instrumentation must not dominate the measurement (CLAUDE.md §5).
 */
import { compareValues, type Value } from '../storage/table.js';
import type { Expr } from '../parser/ast.js';
import type { TableId } from '../planner/types.js';

export type Row = Value[];

export interface ColumnBinding {
  relation: TableId;
  column: string;
}

export class Layout {
  private readonly positions = new Map<string, number>();
  /** Unqualified names that resolve to exactly one column. */
  private readonly unqualified = new Map<string, number | null>();

  constructor(readonly columns: ColumnBinding[]) {
    columns.forEach((c, i) => {
      this.positions.set(`${c.relation}.${c.column}`, i);
      if (this.unqualified.has(c.column)) this.unqualified.set(c.column, null);
      else this.unqualified.set(c.column, i);
    });
  }

  get width(): number { return this.columns.length; }

  indexOf(relation: string | null, column: string): number {
    if (relation !== null) {
      const i = this.positions.get(`${relation}.${column}`);
      if (i === undefined) throw new Error(`Column ${relation}.${column} is not in scope`);
      return i;
    }
    const i = this.unqualified.get(column);
    if (i === undefined) throw new Error(`Column ${column} is not in scope`);
    if (i === null) throw new Error(`Column ${column} is ambiguous`);
    return i;
  }

  concat(other: Layout): Layout {
    return new Layout([...this.columns, ...other.columns]);
  }
}

export type Compiled = (row: Row) => Value;

/**
 * Compile an expression against a layout.
 *
 * Aggregates are resolved by `aggregateSlot`, which the aggregate operators
 * supply — inside a HAVING or a projection above a GROUP BY, `count(*)` is a
 * position in the group's output row, not something to evaluate per input row.
 */
export function compile(
  expr: Expr, layout: Layout, aggregateSlot?: (label: string) => number | undefined,
): Compiled {
  switch (expr.kind) {
    case 'literal': {
      const v = expr.value;
      return () => v;
    }
    case 'column': {
      const i = layout.indexOf(expr.table, expr.name);
      return (row) => row[i];
    }
    case 'aggregate': {
      const slot = aggregateSlot?.(formatAggregate(expr));
      if (slot === undefined) throw new Error(`Aggregate ${formatAggregate(expr)} is not available here`);
      return (row) => row[slot];
    }
    case 'unary': {
      const operand = compile(expr.operand, layout, aggregateSlot);
      if (expr.op === 'NOT') return (row) => negate(operand(row));
      return (row) => {
        const v = operand(row);
        return typeof v === 'number' ? -v : null;
      };
    }
    case 'isnull': {
      const operand = compile(expr.operand, layout, aggregateSlot);
      return expr.negated
        ? (row) => operand(row) !== null
        : (row) => operand(row) === null;
    }
    case 'between': {
      const operand = compile(expr.operand, layout, aggregateSlot);
      const low = compile(expr.low, layout, aggregateSlot);
      const high = compile(expr.high, layout, aggregateSlot);
      return (row) => {
        const v = operand(row);
        const l = low(row), h = high(row);
        if (v === null || l === null || h === null) return null;
        const inside = compareValues(v, l) >= 0 && compareValues(v, h) <= 0;
        return expr.negated ? !inside : inside;
      };
    }
    case 'in': {
      const operand = compile(expr.operand, layout, aggregateSlot);
      const values = expr.values.map((v) => compile(v, layout, aggregateSlot));
      return (row) => {
        const v = operand(row);
        if (v === null) return null;
        let found = false;
        let sawNull = false;
        for (const c of values) {
          const candidate = c(row);
          if (candidate === null) { sawNull = true; continue; }
          if (compareValues(v, candidate) === 0) { found = true; break; }
        }
        // SQL three-valued logic: `x IN (1, NULL)` is NULL when x is not 1.
        if (!found && sawNull) return null;
        return expr.negated ? !found : found;
      };
    }
    case 'binary':
      return compileBinary(expr, layout, aggregateSlot);
  }
}

function compileBinary(
  expr: Expr & { kind: 'binary' }, layout: Layout,
  aggregateSlot?: (label: string) => number | undefined,
): Compiled {
  const left = compile(expr.left, layout, aggregateSlot);
  const right = compile(expr.right, layout, aggregateSlot);

  switch (expr.op) {
    case 'AND':
      return (row) => and(left(row), right(row));
    case 'OR':
      return (row) => or(left(row), right(row));
    case '=': return comparison(left, right, (c) => c === 0);
    case '<>': return comparison(left, right, (c) => c !== 0);
    case '<': return comparison(left, right, (c) => c < 0);
    case '<=': return comparison(left, right, (c) => c <= 0);
    case '>': return comparison(left, right, (c) => c > 0);
    case '>=': return comparison(left, right, (c) => c >= 0);
    case '+': return arithmetic(left, right, (a, b) => a + b);
    case '-': return arithmetic(left, right, (a, b) => a - b);
    case '*': return arithmetic(left, right, (a, b) => a * b);
    case '/': return arithmetic(left, right, (a, b) => (b === 0 ? NaN : a / b));
  }
}

function comparison(left: Compiled, right: Compiled, test: (c: number) => boolean): Compiled {
  return (row) => {
    const a = left(row), b = right(row);
    // NULL compared to anything is NULL, never true and never false.
    if (a === null || b === null) return null;
    return test(compareValues(a, b));
  };
}

function arithmetic(left: Compiled, right: Compiled, op: (a: number, b: number) => number): Compiled {
  return (row) => {
    const a = left(row), b = right(row);
    if (typeof a !== 'number' || typeof b !== 'number') return null;
    const r = op(a, b);
    return Number.isNaN(r) ? null : r;
  };
}

/** SQL three-valued logic. */
function and(a: Value, b: Value): Value {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function or(a: Value, b: Value): Value {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

function negate(v: Value): Value {
  return v === null ? null : !v;
}

/** A WHERE clause keeps a row only when the predicate is true, not when it is null. */
export function isTrue(v: Value): boolean {
  return v === true;
}

export function formatAggregate(expr: Expr & { kind: 'aggregate' }): string {
  return `${expr.name}(${expr.argument ? formatSimple(expr.argument) : '*'})`;
}

function formatSimple(e: Expr): string {
  if (e.kind === 'column') return e.table ? `${e.table}.${e.name}` : e.name;
  if (e.kind === 'literal') {
    if (e.value === null) return 'NULL';
    return typeof e.value === 'string' ? `'${e.value}'` : String(e.value);
  }
  if (e.kind === 'binary') return `${formatSimple(e.left)} ${e.op} ${formatSimple(e.right)}`;
  return '?';
}

export { compareValues };
export type { Value };
