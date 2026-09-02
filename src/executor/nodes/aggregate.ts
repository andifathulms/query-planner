/**
 * HashAggregate and GroupAggregate.
 *
 * Both compute the same answer. HashAggregate is blocking and takes any input
 * order; GroupAggregate needs its input sorted on the grouping columns and
 * pipelines through it, emitting a group as soon as its last row arrives.
 */
import { compareValues, isTrue, Layout, type Compiled, type Row, type Value } from '../row.js';
import { BaseOperator, type Operator } from './operator.js';
import type { Instrument } from '../trace.js';
import type { AggregateName } from '../../parser/ast.js';

export interface AggregateEval {
  name: AggregateName;
  /** null for count(*). */
  argument: Compiled | null;
  label: string;
}

/** Running state for one aggregate within one group. */
interface Accumulator {
  count: number;
  sum: number;
  min: Value;
  max: Value;
  sawNonNull: boolean;
}

function newAccumulator(): Accumulator {
  return { count: 0, sum: 0, min: null, max: null, sawNonNull: false };
}

function accumulate(acc: Accumulator, spec: AggregateEval, row: Row): void {
  if (spec.argument === null) { acc.count++; return; } // count(*)
  const v = spec.argument(row);
  // Every aggregate except count(*) ignores nulls, as SQL requires.
  if (v === null) return;
  acc.sawNonNull = true;
  acc.count++;
  if (typeof v === 'number') acc.sum += v;
  if (acc.min === null || compareValues(v, acc.min) < 0) acc.min = v;
  if (acc.max === null || compareValues(v, acc.max) > 0) acc.max = v;
}

function finalise(acc: Accumulator, spec: AggregateEval): Value {
  switch (spec.name) {
    case 'count': return acc.count;
    // sum and avg over an empty group are null, not zero.
    case 'sum': return acc.sawNonNull ? acc.sum : null;
    case 'avg': return acc.sawNonNull && acc.count > 0 ? acc.sum / acc.count : null;
    case 'min': return acc.min;
    case 'max': return acc.max;
  }
}

/** Layout of an aggregate's output: the grouping columns, then the aggregates. */
export function aggregateLayout(
  groupBindings: Array<{ relation: string; column: string }>,
  aggregates: AggregateEval[],
): Layout {
  return new Layout([
    ...groupBindings,
    ...aggregates.map((a) => ({ relation: '', column: a.label })),
  ]);
}

interface GroupState {
  key: Value[];
  accumulators: Accumulator[];
}

export class HashAggregate extends BaseOperator {
  readonly layout: Layout;
  private groups = new Map<string, GroupState>();
  private emitted: Row[] = [];
  private position = 0;
  private filled = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly input: Operator,
    private readonly groupBy: Compiled[],
    private readonly aggregates: AggregateEval[],
    private readonly having: Compiled | null,
    outputLayout: Layout,
    private readonly workMem: number,
  ) {
    super(planId, instrument);
    this.layout = outputLayout;
  }

  open(): void {
    this.instrument.begin();
    this.input.open();
    this.groups = new Map();
    this.emitted = [];
    this.position = 0;
    this.filled = false;
  }

  next(): Row | null {
    this.instrument.enter();
    if (!this.filled) this.fill();
    if (this.position < this.emitted.length) {
      this.instrument.exit(true);
      return this.emitted[this.position++];
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private fill(): void {
    let spilled = false;
    for (;;) {
      const row = this.input.next();
      if (row === null) break;
      const key = this.groupBy.map((g) => g(row));
      const hash = key.map(stringify).join(' ');
      let group = this.groups.get(hash);
      if (!group) {
        group = { key, accumulators: this.aggregates.map(newAccumulator) };
        this.groups.set(hash, group);
      }
      for (let i = 0; i < this.aggregates.length; i++) {
        accumulate(group.accumulators[i], this.aggregates[i], row);
      }
      if (!spilled && this.groups.size * 64 > this.workMem) {
        spilled = true;
        this.instrument.countSpill();
      }
    }

    // With no GROUP BY there is still exactly one group, even over no rows:
    // `SELECT count(*) FROM t` must return 0, not nothing.
    if (this.groupBy.length === 0 && this.groups.size === 0) {
      this.groups.set('', { key: [], accumulators: this.aggregates.map(newAccumulator) });
    }

    for (const group of this.groups.values()) {
      const out = [...group.key, ...group.accumulators.map((a, i) => finalise(a, this.aggregates[i]))];
      if (this.having === null || isTrue(this.having(out))) this.emitted.push(out);
    }
    this.filled = true;
  }

  close(): void {
    this.input.close();
    this.groups = new Map();
    this.emitted = [];
  }
}

export class GroupAggregate extends BaseOperator {
  readonly layout: Layout;
  private current: GroupState | null = null;
  private done = false;
  private started = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly input: Operator,
    private readonly groupBy: Compiled[],
    private readonly aggregates: AggregateEval[],
    private readonly having: Compiled | null,
    outputLayout: Layout,
  ) {
    super(planId, instrument);
    this.layout = outputLayout;
  }

  open(): void {
    this.instrument.begin();
    this.input.open();
    this.current = null;
    this.done = false;
    this.started = false;
  }

  next(): Row | null {
    this.instrument.enter();
    for (;;) {
      if (this.done) break;

      const row = this.input.next();
      this.started = true;

      if (row === null) {
        this.done = true;
        const finished = this.emit();
        if (finished) { this.instrument.exit(true); return finished; }
        break;
      }

      const key = this.groupBy.map((g) => g(row));
      if (this.current === null) {
        this.current = { key, accumulators: this.aggregates.map(newAccumulator) };
      } else if (!sameKey(this.current.key, key)) {
        // The input is sorted, so a change of key means the group is complete
        // and can be emitted at once. That is the pipelining a hash aggregate
        // cannot do, and it is why a group aggregate has almost no startup cost.
        const finished = this.emit();
        this.current = { key, accumulators: this.aggregates.map(newAccumulator) };
        for (let i = 0; i < this.aggregates.length; i++) {
          accumulate(this.current.accumulators[i], this.aggregates[i], row);
        }
        if (finished) { this.instrument.exit(true); return finished; }
        continue;
      }
      for (let i = 0; i < this.aggregates.length; i++) {
        accumulate(this.current.accumulators[i], this.aggregates[i], row);
      }
    }

    // The ungrouped case over an empty input still produces one row.
    if (this.groupBy.length === 0 && !this.started) {
      this.started = true;
      this.current = { key: [], accumulators: this.aggregates.map(newAccumulator) };
      const finished = this.emit();
      if (finished) { this.instrument.exit(true); return finished; }
    }

    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  /**
   * Emit the completed group, or null when HAVING rejects it.
   *
   * Returning null for a rejected group is safe because `next` loops: the caller
   * never sees the difference between "no group yet" and "group filtered out".
   */
  private emit(): Row | null {
    const group = this.current;
    this.current = null;
    if (!group) return null;
    const out = [...group.key, ...group.accumulators.map((a, i) => finalise(a, this.aggregates[i]))];
    if (this.having !== null && !isTrue(this.having(out))) return null;
    return out;
  }

  close(): void { this.input.close(); }
}

function sameKey(a: Value[], b: Value[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null && b[i] === null) continue;
    if (a[i] === null || b[i] === null) return false;
    if (compareValues(a[i], b[i]) !== 0) return false;
  }
  return true;
}

function stringify(v: Value): string {
  return v === null ? 'null' : `${typeof v}:${String(v)}`;
}
