/**
 * Columnar storage with stable row ids.
 *
 * Columnar because statistics are collected per column and the sample view
 * (§5.6) highlights rows by id; a row id is an index into every column array,
 * which makes both cheap.
 */
export type Value = string | number | boolean | null;

export type ColumnType = 'int' | 'float' | 'text' | 'bool';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** Average stored width in bytes. Feeds the width estimates in the cost model. */
  width: number;
}

/** Rows are addressed by id, which is their physical position. */
export type RowId = number;

export class Table {
  readonly columns: ColumnDef[];
  /** One array per column, parallel and indexed by row id. */
  readonly data: Value[][];
  private readonly index: Map<string, number>;

  constructor(readonly name: string, columns: ColumnDef[], data: Value[][]) {
    this.columns = columns;
    this.data = data;
    this.index = new Map(columns.map((c, i) => [c.name, i]));
    const lengths = new Set(data.map((c) => c.length));
    if (lengths.size > 1) throw new Error(`${name}: columns have different lengths`);
  }

  get rowCount(): number { return this.data.length === 0 ? 0 : this.data[0].length; }

  columnIndex(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`Column ${name} does not exist on ${this.name}`);
    return i;
  }

  column(name: string): Value[] { return this.data[this.columnIndex(name)]; }

  value(row: RowId, column: string): Value { return this.data[this.columnIndex(column)][row]; }

  row(id: RowId): Value[] { return this.data.map((c) => c[id]); }

  /** Average bytes per row. The cost model turns this into a page count. */
  get rowWidth(): number {
    return this.columns.reduce((s, c) => s + c.width, 0);
  }

  /** Pages the table occupies, at the conventional 8 KB page. */
  get pageCount(): number {
    return Math.max(1, Math.ceil((this.rowCount * this.rowWidth) / 8192));
  }
}

export interface Schema {
  id: string;
  label: string;
  tables: Map<string, Table>;
  /** Indexes keyed by `table.column`. */
  indexes: Map<string, import('./btree.js').BTreeIndex>;
}

export function compareValues(a: Value, b: Value): number {
  // Nulls sort last, as Postgres does by default for ASC.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  const as = String(a), bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
