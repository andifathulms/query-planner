/**
 * Sort.
 *
 * Fully blocking: nothing comes out until everything has gone in. The timeline
 * draws that as a long hollow bar with no output, and it is why a sort under a
 * LIMIT is ruinous.
 */
import { compareValues, Layout, type Compiled, type Row } from '../row.js';
import { BaseOperator, type Operator } from './operator.js';
import type { Instrument } from '../trace.js';

export interface SortKeyEval {
  value: Compiled;
  direction: 'asc' | 'desc';
}

export class Sort extends BaseOperator {
  readonly layout: Layout;
  private buffer: Row[] = [];
  private position = 0;
  private filled = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly input: Operator,
    private readonly keys: SortKeyEval[],
    private readonly workMem: number,
  ) {
    super(planId, instrument);
    this.layout = input.layout;
  }

  open(): void {
    this.instrument.begin();
    this.input.open();
    this.buffer = [];
    this.position = 0;
    this.filled = false;
  }

  next(): Row | null {
    this.instrument.enter();
    if (!this.filled) this.fill();
    if (this.position < this.buffer.length) {
      this.instrument.exit(true);
      return this.buffer[this.position++];
    }
    this.instrument.exit(false);
    this.instrument.finish();
    return null;
  }

  private fill(): void {
    let bytes = 0;
    let spilled = false;
    for (;;) {
      const row = this.input.next();
      if (row === null) break;
      this.buffer.push(row);
      bytes += row.length * 8;
      if (!spilled && bytes > this.workMem) {
        spilled = true;
        this.instrument.countSpill();
      }
    }
    // A stable sort, so equal keys keep their input order. Two plans that sort
    // on the same keys then produce identical row sequences, which is what
    // equivalence.test.ts compares.
    this.buffer.sort((a, b) => {
      for (const key of this.keys) {
        const c = compareValues(key.value(a), key.value(b));
        if (c !== 0) return key.direction === 'asc' ? c : -c;
      }
      return 0;
    });
    this.filled = true;
  }

  close(): void {
    this.input.close();
    this.buffer = [];
  }
}
