/** The AST for the accepted SQL subset (PRD §4.1). */

export type Value = string | number | boolean | null;

export type BinaryOp =
  | '=' | '<' | '<=' | '>' | '>=' | '<>'
  | '+' | '-' | '*' | '/'
  | 'AND' | 'OR';

export interface ColumnRef {
  kind: 'column';
  table: string | null; // qualifier, before alias resolution
  name: string;
}

export interface Literal {
  kind: 'literal';
  value: Value;
}

export interface Binary {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface Unary {
  kind: 'unary';
  op: 'NOT' | '-';
  operand: Expr;
}

export interface Between {
  kind: 'between';
  operand: Expr;
  low: Expr;
  high: Expr;
  negated: boolean;
}

export interface InList {
  kind: 'in';
  operand: Expr;
  values: Expr[];
  negated: boolean;
}

export interface IsNull {
  kind: 'isnull';
  operand: Expr;
  negated: boolean;
}

export type AggregateName = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Aggregate {
  kind: 'aggregate';
  name: AggregateName;
  /** null for count(*) */
  argument: Expr | null;
}

export type Expr =
  | ColumnRef | Literal | Binary | Unary | Between | InList | IsNull | Aggregate;

export interface SelectItem {
  expr: Expr;
  alias: string | null;
}

export interface TableRef {
  table: string;
  alias: string;
}

export type JoinType = 'inner' | 'left';

export interface Join {
  type: JoinType;
  right: TableRef;
  on: Expr | null; // null only for a comma-join (cartesian)
}

export interface OrderByItem {
  expr: Expr;
  direction: 'asc' | 'desc';
}

export interface SelectStatement {
  kind: 'select';
  select: SelectItem[];
  star: boolean;
  from: TableRef;
  joins: Join[];
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderByItem[];
  limit: number | null;
}

/** Flatten an AND tree into its conjuncts. Used everywhere downstream. */
export function conjuncts(e: Expr | null): Expr[] {
  if (!e) return [];
  if (e.kind === 'binary' && e.op === 'AND') {
    return [...conjuncts(e.left), ...conjuncts(e.right)];
  }
  return [e];
}

/** Render an expression back to SQL. Traces and node labels print this. */
export function formatExpr(e: Expr): string {
  switch (e.kind) {
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name;
    case 'literal':
      if (e.value === null) return 'NULL';
      if (typeof e.value === 'string') return `'${e.value}'`;
      return String(e.value);
    case 'binary':
      return `${formatExpr(e.left)} ${e.op} ${formatExpr(e.right)}`;
    case 'unary':
      return e.op === 'NOT' ? `NOT ${formatExpr(e.operand)}` : `-${formatExpr(e.operand)}`;
    case 'between':
      return `${formatExpr(e.operand)}${e.negated ? ' NOT' : ''} BETWEEN ${formatExpr(e.low)} AND ${formatExpr(e.high)}`;
    case 'in':
      return `${formatExpr(e.operand)}${e.negated ? ' NOT' : ''} IN (${e.values.map(formatExpr).join(', ')})`;
    case 'isnull':
      return `${formatExpr(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL`;
    case 'aggregate':
      return `${e.name}(${e.argument ? formatExpr(e.argument) : '*'})`;
  }
}

export function columnsIn(e: Expr): ColumnRef[] {
  const out: ColumnRef[] = [];
  const walk = (n: Expr): void => {
    switch (n.kind) {
      case 'column': out.push(n); break;
      case 'literal': break;
      case 'binary': walk(n.left); walk(n.right); break;
      case 'unary': walk(n.operand); break;
      case 'between': walk(n.operand); walk(n.low); walk(n.high); break;
      case 'in': walk(n.operand); n.values.forEach(walk); break;
      case 'isnull': walk(n.operand); break;
      case 'aggregate': if (n.argument) walk(n.argument); break;
    }
  };
  walk(e);
  return out;
}

export function hasAggregate(e: Expr): boolean {
  if (e.kind === 'aggregate') return true;
  return columnsInAggregateScan(e);
  function columnsInAggregateScan(n: Expr): boolean {
    switch (n.kind) {
      case 'binary': return hasAggregate(n.left) || hasAggregate(n.right);
      case 'unary': return hasAggregate(n.operand);
      case 'between': return hasAggregate(n.operand) || hasAggregate(n.low) || hasAggregate(n.high);
      case 'in': return hasAggregate(n.operand) || n.values.some(hasAggregate);
      case 'isnull': return hasAggregate(n.operand);
      default: return false;
    }
  }
}
