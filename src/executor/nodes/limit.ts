/**
 * Limit.
 *
 * It closes its input as soon as it has enough rows, which is what makes early
 * termination real rather than notional: an index scan beneath a LIMIT stops
 * pulling from the B-tree, and a pipelining plan therefore does far less work
 * than a blocking one under the same LIMIT.
 */
import type { Layout, Row } from '../row.js';
import { BaseOperator, type Operator } from './operator.js';
import type { Instrument } from '../trace.js';

export class Limit extends BaseOperator {
  readonly layout: Layout;
  private produced = 0;
  private closed = false;

  constructor(
    planId: string, instrument: Instrument,
    private readonly input: Operator,
    private readonly count: number,
  ) {
    super(planId, instrument);
    this.layout = input.layout;
  }

  open(): void {
    this.instrument.begin();
    this.input.open();
    this.produced = 0;
    this.closed = false;
  }

  next(): Row | null {
    this.instrument.enter();
    if (this.produced >= this.count) {
      if (!this.closed) { this.input.close(); this.closed = true; }
      this.instrument.exit(false);
      this.instrument.finish();
      return null;
    }
    const row = this.input.next();
    if (row === null) {
      this.instrument.exit(false);
      this.instrument.finish();
      return null;
    }
    this.produced++;
    this.instrument.exit(true);
    return row;
  }

  close(): void {
    if (!this.closed) { this.input.close(); this.closed = true; }
  }
}
