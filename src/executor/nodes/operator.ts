/**
 * The volcano interface: open, next, close (PRD §4.6).
 *
 * Every operator pulls from its children one row at a time, which is what makes
 * pipelining and blocking distinguishable — a blocking operator is simply one
 * whose first `next()` consumes its entire input.
 */
import type { Layout, Row } from '../row.js';
import type { Instrument, NodeStats } from '../trace.js';

export interface Operator {
  readonly layout: Layout;
  readonly instrument: Instrument;
  readonly stats: NodeStats;
  /** The plan node this operator came from, so estimates pair with actuals. */
  readonly planId: string;
  open(): void;
  next(): Row | null;
  close(): void;
}

export abstract class BaseOperator implements Operator {
  abstract readonly layout: Layout;
  constructor(readonly planId: string, readonly instrument: Instrument) {}
  get stats(): NodeStats { return this.instrument.stats; }
  abstract open(): void;
  abstract next(): Row | null;
  abstract close(): void;
}
