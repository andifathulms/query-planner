/**
 * The arithmetic a selectivity trace performed, written out.
 *
 * The trace printed two inputs, a method label and an answer:
 *
 *   k.kota = 'Kupang' AND k.provinsi = '...'  [independence]  1 in 12,082
 *   clause1 0.0089   clause2 0.0093
 *
 * and left the reader to know that "independence" means multiply, and to do the
 * multiplication themselves to connect the three numbers. That step is the app's
 * entire thesis (PRD §2) and it was the one step never shown.
 *
 * The formula is derived here rather than emitted by the estimator, and then
 * **checked against the result the estimator actually produced**. If the
 * arithmetic written here does not reproduce that number, nothing is displayed.
 * A missing formula is a gap; a wrong one would be a lie, and this is the one
 * place in the app where a reader is invited to check the working by hand.
 */
import type { SelectivityTrace } from '../planner/types.js';

export interface Formula {
  /** The operation, with its operands, as it would be written out. */
  expression: string;
  /** True when evaluating it reproduces the trace's own result. */
  verified: boolean;
}

/** Relative tolerance, to absorb the clamping the estimator applies at the ends. */
const TOLERANCE = 1e-6;

const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(TOLERANCE, Math.abs(b) * TOLERANCE);

/** Enough significant figures that the product visibly lands on the result. */
function operand(v: number): string {
  if (v === 0) return '0';
  if (v >= 0.001) return String(Number(v.toPrecision(3)));
  return v.toExponential(2);
}

/**
 * The arithmetic for a trace, or null when this method has no single expression
 * worth writing out (a most-common-value lookup is a table read, not a sum).
 */
export function formulaFor(trace: SelectivityTrace): Formula | null {
  const clauses = Object.entries(trace.inputs)
    .filter(([k]) => /^clause\d+$/.test(k))
    .map(([, v]) => v);

  switch (trace.method) {
    case 'independence': {
      if (clauses.length < 2) return null;
      const product = clauses.reduce((a, b) => a * b, 1);
      return {
        expression: clauses.map(operand).join(' × '),
        verified: close(product, trace.result),
      };
    }
    case 'disjunction': {
      const { left, right } = trace.inputs;
      if (left === undefined || right === undefined) return null;
      // Inclusive-or: the overlap would otherwise be counted twice.
      return {
        expression: `${operand(left)} + ${operand(right)} − ${operand(left)} × ${operand(right)}`,
        verified: close(left + right - left * right, trace.result),
      };
    }
    case 'negation': {
      const { inner, equality, nullFraction } = trace.inputs;
      if (inner !== undefined) {
        return { expression: `1 − ${operand(inner)}`, verified: close(1 - inner, trace.result) };
      }
      if (equality !== undefined && nullFraction !== undefined) {
        // A row that is NULL satisfies neither `= x` nor `<> x`.
        return {
          expression: `1 − ${operand(equality)} − ${operand(nullFraction)}`,
          verified: close(1 - equality - nullFraction, trace.result),
        };
      }
      return null;
    }
    case 'histogram': {
      const {
        histogramFraction, histogramShare, mcvInRange,
        mcvTotal, nullFraction, remainingDistinct,
      } = trace.inputs;

      // A range: whole buckets plus the linear interpolation inside the partial
      // one, scaled to the share of rows the histogram actually describes, plus
      // any most-common value that falls in range. PRD §5.4 promises this is
      // printed so it can be checked by hand.
      if (histogramFraction !== undefined && histogramShare !== undefined) {
        const mcv = mcvInRange ?? 0;
        return {
          expression: `${operand(histogramFraction)} × ${operand(histogramShare)}`
            + (mcv > 0 ? ` + ${operand(mcv)}` : ''),
          verified: close(histogramFraction * histogramShare + mcv, trace.result),
        };
      }

      // An equality on a value the most-common list does not carry: whatever
      // frequency is left over, spread across the distinct values left over.
      if (mcvTotal !== undefined && nullFraction !== undefined
        && remainingDistinct !== undefined && remainingDistinct !== 0) {
        return {
          expression: `(1 − ${operand(mcvTotal)} − ${operand(nullFraction)}) ÷ ${operand(remainingDistinct)}`,
          verified: close((1 - mcvTotal - nullFraction) / remainingDistinct, trace.result),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The rule a method applies, in one line, cited where it is applied.
 *
 * Not a glossary: each line names the rule that produced the number on the same
 * row, and says where the rule comes from. Methods whose `assumptions` already
 * state the rule in full are absent rather than repeated.
 */
export const METHOD_RULES: Partial<Record<SelectivityTrace['method'], string>> = {
  independence: 'Postgres multiplies the selectivities of AND-ed clauses unless a '
    + 'multivariate statistic covers them. That is the assumption this app is about.',
  disjunction: 'Selectivities of OR-ed clauses are added, then the overlap is subtracted '
    + 'once, which itself assumes the two are independent.',
  mcv: 'Values in the most-common-value list carry a measured frequency, so no model is '
    + 'involved. Values outside it share whatever frequency is left over.',
  histogram: 'Equi-depth buckets each hold about the same number of rows, so a range is '
    + 'counted in whole buckets and interpolated linearly inside the partial ones.',
  dependency: 'A functional dependency says one column determines another, so the second '
    + 'clause contributes only the fraction of its selectivity the dependency leaves.',
  'multivariate-mcv': 'A multivariate most-common-value list stores the frequency of the '
    + 'combination itself, so no independence assumption is needed for it.',
  join: 'A join is estimated as one over the larger distinct count, which assumes every '
    + 'value on the smaller side finds a match.',
};
