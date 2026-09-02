/**
 * Execution instrumentation.
 *
 * `firstRowTimeMs` is what makes pipelining visible: a nested loop's first row
 * arrives almost immediately, a hash join's only after the build completes, and
 * that difference is the entire content of the timeline view (CLAUDE.md §5).
 *
 * Time is sampled rather than read per row. Calling a clock once per tuple would
 * cost more than the operators being measured and would change the answer.
 */
import type { Clock } from '../engine/clock.js';

/** Read the clock every this many rows. */
const SAMPLE_INTERVAL = 256;

export interface NodeStats {
  actualRows: number;
  actualTimeMs: number;
  loops: number;
  spills: number;
  /** When the first row emerged, relative to execution start. */
  firstRowTimeMs: number | null;
  /** When this node started work, relative to execution start. */
  startTimeMs: number | null;
  /** When it finished, relative to execution start. */
  endTimeMs: number | null;
}

export function emptyStats(): NodeStats {
  return {
    actualRows: 0, actualTimeMs: 0, loops: 0, spills: 0,
    firstRowTimeMs: null, startTimeMs: null, endTimeMs: null,
  };
}

/**
 * Per-node timing, sampled.
 *
 * `enter`/`exit` bracket the work a node does inside one `next()` call. The
 * clock is read on the first row (so the startup period is exact, which is the
 * number the timeline needs) and then only every SAMPLE_INTERVAL rows, with the
 * elapsed time attributed across the interval.
 */
export class Instrument {
  readonly stats: NodeStats = emptyStats();
  private sinceSample = 0;
  private enteredAt = 0;

  constructor(private readonly clock: Clock, private readonly origin: number) {}

  /** Called when the operator starts running, before any row is produced. */
  begin(): void {
    if (this.stats.startTimeMs === null) {
      this.stats.startTimeMs = this.clock.now() - this.origin;
    }
  }

  enter(): void {
    this.sinceSample++;
    if (this.stats.actualRows === 0 || this.sinceSample >= SAMPLE_INTERVAL) {
      this.enteredAt = this.clock.now();
    }
  }

  /** Called with the row the operator produced, or null when it is exhausted. */
  exit(produced: boolean): void {
    if (produced) {
      this.stats.actualRows++;
      if (this.stats.firstRowTimeMs === null) {
        this.stats.firstRowTimeMs = this.clock.now() - this.origin;
      }
    }
    if (this.sinceSample >= SAMPLE_INTERVAL || this.stats.actualRows <= 1) {
      const elapsed = this.clock.now() - this.enteredAt;
      // Attribute the sampled interval's cost to the whole interval.
      this.stats.actualTimeMs += elapsed;
      this.sinceSample = 0;
    }
  }

  finish(): void {
    this.stats.endTimeMs = this.clock.now() - this.origin;
  }

  countLoop(): void { this.stats.loops++; }
  countSpill(): void { this.stats.spills++; }
}
