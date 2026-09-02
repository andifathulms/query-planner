/**
 * Nested Loop, Hash Join and Merge Join.
 *
 * The three differ in exactly the way the timeline draws: the nested loop emits
 * almost immediately, the hash join emits nothing until its build side is
 * exhausted, and the merge join walks two ordered streams in step.
 *
 * All three must produce identical result sets. equivalence.test.ts is the
 * strongest test in the suite — if a hash join and a merge join disagree, one
 * executor is wrong (PRD §7.3).
 */
import { compareValues, isTrue, Layout, type Compiled, type Row, type Value } from '../row.js';
import { BaseOperator, type Operator } from './operator.js';
import type { Instrument } from '../trace.js';

export type JoinKind = 'inner' | 'left';

/** Rows of nulls for the inner side of an unmatched LEFT JOIN row. */
function nulls(width: number): Row {
  return new Array<Value>(width).fill(null);
}

export class NestedLoop extends BaseOperator {
  readonly layout: Layout;
  private outerRow: Row | null = null;
  private innerOpen = false;
  private matchedCurrentOuter = false;
  private done = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly outer: Operator,
    private readonly inner: Operator,
    private readonly condition: Compiled | null,
    private readonly joinKind: JoinKind,
  ) {
    super(planId, instrument);
    this.layout = outer.layout.concat(inner.layout);
  }

  open(): void {
    this.instrument.begin();
    this.outer.open();
    this.outerRow = null;
    this.done = false;
  }

  next(): Row | null {
    this.instrument.enter();
    for (;;) {
      if (this.done) break;

      if (this.outerRow === null) {
        this.outerRow = this.outer.next();
        if (this.outerRow === null) { this.done = true; break; }
        // The inner side is re-scanned for every outer row. This is the cost the
        // model charges per loop, and it is why an underestimated outer side
        // turns a 200 ms query into forty minutes.
        this.inner.open();
        this.innerOpen = true;
        this.instrument.countLoop();
        this.matchedCurrentOuter = false;
      }

      const innerRow = this.inner.next();
      if (innerRow === null) {
        this.inner.close();
        this.innerOpen = false;
        const outerRow = this.outerRow;
        this.outerRow = null;
        if (this.joinKind === 'left' && !this.matchedCurrentOuter) {
          const joined = [...outerRow, ...nulls(this.inner.layout.width)];
          this.instrument.exit(true);
          return joined;
        }
        continue;
      }

      const joined = [...this.outerRow, ...innerRow];
      if (this.condition === null || isTrue(this.condition(joined))) {
        this.matchedCurrentOuter = true;
        this.instrument.exit(true);
        return joined;
      }
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  close(): void {
    if (this.innerOpen) { this.inner.close(); this.innerOpen = false; }
    this.outer.close();
  }
}

export class HashJoin extends BaseOperator {
  readonly layout: Layout;
  private table = new Map<string, Row[]>();
  private probeRow: Row | null = null;
  private bucket: Row[] = [];
  private bucketIndex = 0;
  private matchedProbe = false;
  private done = false;
  private built = false;

  constructor(
    planId: string, instrument: Instrument,
    /** The side hashed. Blocking: consumed in full before any output. */
    private readonly build: Operator,
    private readonly probe: Operator,
    private readonly buildKey: Compiled,
    private readonly probeKey: Compiled,
    private readonly condition: Compiled | null,
    private readonly joinKind: JoinKind,
    /** Whether the probe side is the outer side, for output column order. */
    private readonly probeIsOuter: boolean,
    private readonly workMem: number,
  ) {
    super(planId, instrument);
    this.layout = probeIsOuter
      ? probe.layout.concat(build.layout)
      : build.layout.concat(probe.layout);
  }

  open(): void {
    this.instrument.begin();
    this.build.open();
    this.probe.open();
    this.table = new Map();
    this.built = false;
    this.done = false;
  }

  /** Consume the entire build side. Nothing is emitted until this completes. */
  private buildTable(): void {
    let bytes = 0;
    let spilled = false;
    for (;;) {
      const row = this.build.next();
      if (row === null) break;
      const key = keyOf(this.buildKey(row));
      // A null join key never matches anything, so it need not be hashed.
      if (key === null) continue;
      const existing = this.table.get(key);
      if (existing) existing.push(row);
      else this.table.set(key, [row]);

      bytes += row.length * 8;
      if (!spilled && bytes > this.workMem) {
        // A real hash join would write batches to disk here. This engine keeps
        // them in memory and records the event, so the timeline can show the
        // spill happening at the moment the build crosses work_mem.
        spilled = true;
        this.instrument.countSpill();
      }
    }
    this.built = true;
  }

  next(): Row | null {
    this.instrument.enter();
    if (!this.built) this.buildTable();

    for (;;) {
      if (this.done) break;

      if (this.probeRow === null) {
        this.probeRow = this.probe.next();
        if (this.probeRow === null) { this.done = true; break; }
        const key = keyOf(this.probeKey(this.probeRow));
        this.bucket = key === null ? [] : (this.table.get(key) ?? []);
        this.bucketIndex = 0;
        this.matchedProbe = false;
      }

      while (this.bucketIndex < this.bucket.length) {
        const buildRow = this.bucket[this.bucketIndex++];
        const joined = this.combine(this.probeRow, buildRow);
        if (this.condition === null || isTrue(this.condition(joined))) {
          this.matchedProbe = true;
          this.instrument.exit(true);
          return joined;
        }
      }

      const probeRow = this.probeRow;
      this.probeRow = null;
      // A LEFT JOIN preserves unmatched rows only when the preserved side is the
      // one being probed; when the outer side was hashed, the null-extension
      // would have to happen over the build side instead, which this executor
      // does not choose (see execute.ts, which only hashes the inner side of a
      // left join).
      if (this.joinKind === 'left' && this.probeIsOuter && !this.matchedProbe) {
        this.instrument.exit(true);
        return this.combine(probeRow, nulls(this.build.layout.width));
      }
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private combine(probeRow: Row, buildRow: Row): Row {
    return this.probeIsOuter ? [...probeRow, ...buildRow] : [...buildRow, ...probeRow];
  }

  close(): void {
    this.build.close();
    this.probe.close();
    this.table = new Map();
  }
}

export class MergeJoin extends BaseOperator {
  readonly layout: Layout;
  private leftRow: Row | null = null;
  private rightRow: Row | null = null;
  /** Rows on the right sharing the current key, for the many-to-many case. */
  private rightGroup: Row[] = [];
  private groupIndex = 0;
  private leftMatched = false;
  private done = false;
  private started = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly left: Operator,
    private readonly right: Operator,
    private readonly leftKey: Compiled,
    private readonly rightKey: Compiled,
    private readonly condition: Compiled | null,
    private readonly joinKind: JoinKind,
  ) {
    super(planId, instrument);
    this.layout = left.layout.concat(right.layout);
  }

  open(): void {
    this.instrument.begin();
    this.left.open();
    this.right.open();
    this.done = false;
    this.started = false;
  }

  next(): Row | null {
    this.instrument.enter();
    if (!this.started) {
      this.leftRow = this.left.next();
      this.rightRow = this.right.next();
      this.started = true;
      this.leftMatched = false;
    }

    for (;;) {
      if (this.done) break;

      // Emit from the group the current left row matched.
      if (this.groupIndex < this.rightGroup.length) {
        const joined = [...this.leftRow!, ...this.rightGroup[this.groupIndex++]];
        if (this.condition === null || isTrue(this.condition(joined))) {
          this.leftMatched = true;
          this.instrument.exit(true);
          return joined;
        }
        continue;
      }

      // The group is exhausted; advance the left side.
      if (this.rightGroup.length > 0) {
        const unmatched = this.joinKind === 'left' && !this.leftMatched ? this.leftRow : null;
        this.leftRow = this.left.next();
        this.leftMatched = false;
        // The group is kept: consecutive left rows can share a key, and each
        // must see every right row for that key. This is the many-to-many case
        // a naive merge join gets wrong.
        if (this.leftRow !== null && sameKey(this.leftKey(this.leftRow), this.groupKey)) {
          this.groupIndex = 0;
        } else {
          this.rightGroup = [];
          this.groupIndex = 0;
        }
        if (unmatched) {
          this.instrument.exit(true);
          return [...unmatched, ...nulls(this.right.layout.width)];
        }
        continue;
      }

      if (this.leftRow === null) { this.done = true; break; }

      const lk = this.leftKey(this.leftRow);
      if (lk === null) {
        // A null key matches nothing; a LEFT JOIN still preserves the row.
        const row = this.leftRow;
        this.leftRow = this.left.next();
        if (this.joinKind === 'left') {
          this.instrument.exit(true);
          return [...row, ...nulls(this.right.layout.width)];
        }
        continue;
      }

      if (this.rightRow === null) {
        if (this.joinKind === 'left') {
          const row = this.leftRow;
          this.leftRow = this.left.next();
          this.instrument.exit(true);
          return [...row, ...nulls(this.right.layout.width)];
        }
        this.done = true;
        break;
      }

      const rk = this.rightKey(this.rightRow);
      if (rk === null) { this.rightRow = this.right.next(); continue; }

      const c = compareValues(lk, rk);
      if (c < 0) {
        const row = this.leftRow;
        this.leftRow = this.left.next();
        if (this.joinKind === 'left') {
          this.instrument.exit(true);
          return [...row, ...nulls(this.right.layout.width)];
        }
        continue;
      }
      if (c > 0) { this.rightRow = this.right.next(); continue; }

      // Keys match. Gather every right row sharing this key.
      this.groupKey = rk;
      this.rightGroup = [];
      while (this.rightRow !== null && sameKey(this.rightKey(this.rightRow), rk)) {
        this.rightGroup.push(this.rightRow);
        this.rightRow = this.right.next();
      }
      this.groupIndex = 0;
      this.leftMatched = false;
    }

    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private groupKey: Value = null;

  close(): void {
    this.left.close();
    this.right.close();
    this.rightGroup = [];
  }
}

function sameKey(a: Value, b: Value): boolean {
  if (a === null || b === null) return false;
  return compareValues(a, b) === 0;
}

/** A hash key. Null means the row's join key was null and can never match. */
export function keyOf(v: Value): string | null {
  return v === null ? null : `${typeof v}:${String(v)}`;
}
