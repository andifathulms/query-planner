/**
 * The paired span (DESIGN.md §0, §2.2).
 *
 * The design has exactly one job: make the gap physical. Never two numbers side
 * by side for the reader to divide — always a believed mark, a true mark, and
 * the drawn distance between them, so estimation error is a length you see
 * before you read anything.
 *
 * Believed is hollow and dashed, the way a proposal is drawn on a plan. True is
 * solid and filled, the way an as-built is marked up. The distinction survives
 * with no colour vision, at 3 px, and in a screenshot.
 */

export interface SpanProps {
  believed: number;
  /** null while the query has not been executed. */
  actual: number | null;
  /** Domain of the local axis. Both values are clamped into it. */
  min: number;
  max: number;
  width: number;
  height?: number;
  /** Drawn as a caption beneath, when there is room. */
  label?: string;
}

/**
 * A log axis, because the errors this app is about span orders of magnitude. On
 * a linear axis a 300× error and a 3000× error look the same: both pinned to the
 * far end.
 */
export function logScale(value: number, min: number, max: number, width: number): number {
  const lo = Math.log10(Math.max(min, 1e-6));
  const hi = Math.log10(Math.max(max, min * 10));
  const v = Math.log10(Math.min(Math.max(value, min), max));
  return ((v - lo) / (hi - lo)) * width;
}

export function Span({ believed, actual, min, max, width, height = 12, label }: SpanProps) {
  const b = logScale(believed, min, max, width);
  const a = actual === null ? null : logScale(actual, min, max, width);
  const mid = height / 2;

  // The gap is filled in the colour of whichever side is wrong: blue when the
  // estimate is low, ochre when it is high. Under-estimates are the dangerous
  // ones, so the two must not look alike.
  const underestimated = a !== null && a > b;
  const gapClass = underestimated ? 'gap-under' : 'gap-over';

  return (
    <g className="span" aria-hidden="true">
      {/* The axis itself, so a mark near zero still has something to sit on. */}
      <line x1={0} y1={mid} x2={width} y2={mid} stroke="var(--rule)" strokeWidth={1} />

      {a !== null && Math.abs(a - b) > 0.5 && (
        <rect
          className={gapClass}
          x={Math.min(a, b)}
          y={1}
          width={Math.abs(a - b)}
          height={height - 2}
        />
      )}

      {/* Believed: hollow, dashed, 1.5 px. */}
      <rect className="mark-believed" x={b - 3} y={1.5} width={6} height={height - 3} rx={1} />

      {/* True: solid, filled, no stroke. */}
      {a !== null && <rect className="mark-true" x={a - 2} y={2} width={4} height={height - 4} rx={1} />}

      {label && (
        <text className="t-micro" x={width + 6} y={mid + 3} fill="var(--ink-mid)">{label}</text>
      )}
    </g>
  );
}

/**
 * A legend for the encoding. Shown once, near the top of the derivation, so the
 * reader meets the two marks before the tree full of them.
 */
export function SpanLegend() {
  return (
    <div className="span-legend t-small">
      <svg width={54} height={12} aria-hidden="true">
        <rect className="mark-believed" x={4} y={1.5} width={6} height={9} rx={1} />
        <line x1={13} y1={6} x2={39} y2={6} stroke="var(--rule)" />
        <rect className="mark-true" x={42} y={2} width={4} height={8} rx={1} />
      </svg>
      <span>estimated</span>
      <span aria-hidden="true">·</span>
      <span>actual</span>
    </div>
  );
}
