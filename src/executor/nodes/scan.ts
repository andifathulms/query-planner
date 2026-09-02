/**
 * Seq Scan and Index Scan.
 *
 * The index scan pulls row ids lazily from the B-tree generator, so a LIMIT
 * above it genuinely stops the scan early. That early termination is not a
 * detail — it is why LIMIT changes which plan is right (PRD §5.7).
 */
import type { Table } from '../../storage/table.js';
import type { BTreeIndex } from '../../storage/btree.js';
import { Layout, isTrue, type Compiled, type Row } from '../row.js';
import { BaseOperator } from './operator.js';
import type { Instrument } from '../trace.js';

export class SeqScan extends BaseOperator {
  readonly layout: Layout;
  private position = 0;
  private readonly rowCount: number;

  constructor(
    planId: string, instrument: Instrument,
    private readonly table: Table,
    alias: string,
    private readonly filters: Compiled[],
  ) {
    super(planId, instrument);
    this.layout = new Layout(table.columns.map((c) => ({ relation: alias, column: c.name })));
    this.rowCount = table.rowCount;
  }

  open(): void {
    this.position = 0;
    this.instrument.begin();
  }

  next(): Row | null {
    this.instrument.enter();
    while (this.position < this.rowCount) {
      const row = this.table.row(this.position++);
      if (this.passes(row)) {
        this.instrument.exit(true);
        return row;
      }
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private passes(row: Row): boolean {
    for (const f of this.filters) if (!isTrue(f(row))) return false;
    return true;
  }

  close(): void { this.position = this.rowCount; }
}

/** How the index scan should be driven. */
export type IndexAccess =
  | { kind: 'all' }
  /**
   * The key comes from the nested loop above, rebound before each open.
   * The slot is shared with the join, which writes it per outer row.
   */
  | { kind: 'parameter'; slot: ParameterSlot }
  | { kind: 'equality'; value: import('../row.js').Value }
  | { kind: 'in'; values: import('../row.js').Value[] }
  | {
      kind: 'range';
      low: import('../row.js').Value | null; lowInclusive: boolean;
      high: import('../row.js').Value | null; highInclusive: boolean;
    };

/** A one-value binding a nested loop writes and its inner index scan reads. */
export class ParameterSlot {
  value: import('../row.js').Value = null;
}

export class IndexScan extends BaseOperator {
  readonly layout: Layout;
  private ids: Iterator<number> | null = null;

  constructor(
    planId: string, instrument: Instrument,
    private readonly table: Table,
    alias: string,
    private readonly index: BTreeIndex,
    private readonly access: IndexAccess,
    private readonly filters: Compiled[],
  ) {
    super(planId, instrument);
    this.layout = new Layout(table.columns.map((c) => ({ relation: alias, column: c.name })));
  }

  open(): void {
    this.instrument.begin();
    this.ids = this.makeIterator();
  }

  private makeIterator(): Iterator<number> {
    const a = this.access;
    switch (a.kind) {
      case 'all': return this.index.ordered();
      case 'parameter': return this.index.lookup(a.slot.value)[Symbol.iterator]();
      case 'equality': return this.index.lookup(a.value)[Symbol.iterator]();
      case 'in': {
        // Each value's ids in key order, concatenated in value order, so the
        // scan still emits in index order overall.
        const index = this.index;
        const sorted = [...a.values].sort((x, y) =>
          (x === null ? 1 : y === null ? -1 : x < y ? -1 : x > y ? 1 : 0));
        return (function* () {
          for (const v of sorted) yield* index.lookup(v);
        })();
      }
      case 'range':
        return this.index.range(a.low, a.lowInclusive, a.high, a.highInclusive);
    }
  }

  next(): Row | null {
    this.instrument.enter();
    const iterator = this.ids;
    if (iterator) {
      for (;;) {
        const step = iterator.next();
        if (step.done) break;
        const row = this.table.row(step.value);
        if (this.passes(row)) {
          this.instrument.exit(true);
          return row;
        }
      }
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private passes(row: Row): boolean {
    for (const f of this.filters) if (!isTrue(f(row))) return false;
    return true;
  }

  close(): void {
    // Closing the generator is what stops a partially consumed index scan.
    this.ids?.return?.(undefined);
    this.ids = null;
  }
}
