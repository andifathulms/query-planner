/**
 * Selectivity estimation, following the Postgres model closely (CLAUDE.md §2).
 *
 * Closely, because the audience will recognise it and the whole value of the app
 * depends on a reader mapping what they see here onto real EXPLAIN output.
 *
 * Every function here returns a `SelectivityTrace` alongside its number. The
 * views render the trace and never recompute — the display and the computation
 * are one object.
 */
import {
  columnsIn, conjuncts, formatExpr, type Expr,
} from '../parser/ast.js';
import { locate } from '../stats/histogram.js';
import { keyOf } from '../stats/mcv.js';
import { dependencyKey } from '../stats/multivariate/dependencies.js';
import { lookupCombination, listedFrequency } from '../stats/multivariate/mcv-multi.js';
import {
  distinctCount, mcvTotal,
  type ColumnStatistics, type MultivariateStatistics, type Statistics, type Value,
} from '../stats/types.js';
import type { QueryRelation, SelectivityTrace } from './types.js';

/** Postgres's fallback selectivities, when the statistics say nothing useful. */
export const DEFAULT_EQ_SELECTIVITY = 0.005;
export const DEFAULT_RANGE_SELECTIVITY = 1 / 3;
export const DEFAULT_SELECTIVITY = 0.005;

export interface EstimationContext {
  statistics: Statistics;
  /** alias → relation, so a column reference can be resolved to a table. */
  relations: Map<string, QueryRelation>;
}

export interface Estimate {
  selectivity: number;
  trace: SelectivityTrace;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Selectivity of a boolean expression against one relation.
 *
 * Conjunctions are handled as a group rather than pairwise, because the
 * multivariate repairs apply to a set of clauses at once.
 */
export function estimateExpr(expr: Expr, ctx: EstimationContext): Estimate {
  const parts = conjuncts(expr);
  if (parts.length > 1) return estimateConjunction(parts, ctx);
  return estimateAtom(expr, ctx);
}

function estimateAtom(expr: Expr, ctx: EstimationContext): Estimate {
  switch (expr.kind) {
    case 'binary':
      if (expr.op === 'OR') return estimateDisjunction(expr, ctx);
      if (expr.op === 'AND') return estimateConjunction(conjuncts(expr), ctx);
      return estimateComparison(expr.op, expr.left, expr.right, ctx);
    case 'isnull':
      return estimateIsNull(expr.operand, expr.negated, ctx);
    case 'between':
      return estimateBetween(expr, ctx);
    case 'in':
      return estimateIn(expr, ctx);
    case 'unary':
      if (expr.op === 'NOT') {
        const inner = estimateExpr(expr.operand, ctx);
        return {
          selectivity: 1 - inner.selectivity,
          trace: {
            clause: formatExpr(expr), method: 'negation',
            inputs: { inner: inner.selectivity },
            result: 1 - inner.selectivity,
            assumptions: ['NOT is estimated as one minus the inner selectivity, which ignores nulls'],
            children: [inner.trace],
          },
        };
      }
      return fallback(expr, 'A non-boolean expression is estimated at the default selectivity');
    default:
      return fallback(expr, 'No statistics apply to this expression');
  }
}

function fallback(expr: Expr, assumption: string): Estimate {
  return {
    selectivity: DEFAULT_SELECTIVITY,
    trace: {
      clause: formatExpr(expr), method: 'default',
      inputs: { default: DEFAULT_SELECTIVITY },
      result: DEFAULT_SELECTIVITY,
      assumptions: [assumption],
    },
  };
}

// ── Equality ─────────────────────────────────────────────────────────────────

/**
 * Equality against a constant.
 *
 * In the MCV list: its frequency directly, which is the accurate case.
 * Otherwise the remainder is spread evenly over the values the list does not
 * name — an assumption that a skewed column punishes, which is why the MCV list
 * exists at all.
 */
export function estimateEquality(
  stat: ColumnStatistics, value: Value, clause: string,
): Estimate {
  const listed = stat.mcv.find((e) => keyOf(e.value) === keyOf(value));
  if (listed) {
    return {
      selectivity: listed.frequency,
      trace: {
        clause, method: 'mcv',
        inputs: { frequency: listed.frequency, mcvEntries: stat.mcv.length },
        result: listed.frequency,
        assumptions: [`${formatValue(value)} is in the most-common-values list, so its frequency is used directly`],
      },
    };
  }

  const mcvSum = mcvTotal(stat);
  const distinct = distinctCount(stat);
  const remaining = distinct - stat.mcv.length;
  if (remaining <= 0) {
    // Every distinct value is named in the MCV list and this is not one of them.
    return {
      selectivity: 0,
      trace: {
        clause, method: 'mcv',
        inputs: { mcvEntries: stat.mcv.length, nDistinct: distinct },
        result: 0,
        assumptions: ['The most-common-values list names every distinct value and this is not one of them'],
      },
    };
  }

  const selectivity = clamp01((1 - mcvSum - stat.nullFraction) / remaining);
  return {
    selectivity,
    trace: {
      clause, method: 'histogram',
      inputs: {
        mcvTotal: mcvSum, nullFraction: stat.nullFraction,
        nDistinct: distinct, mcvEntries: stat.mcv.length,
        remainingDistinct: remaining,
      },
      result: selectivity,
      assumptions: [
        `${formatValue(value)} is not in the most-common-values list`,
        'the values outside that list are assumed uniformly distributed',
      ],
    },
  };
}

// ── Ranges ───────────────────────────────────────────────────────────────────

/**
 * A range predicate.
 *
 * Locate the bound in the histogram, count whole buckets, interpolate the
 * partial one linearly, then add the MCV entries that fall in range — those are
 * not described by the histogram and would otherwise be lost.
 */
export function estimateRange(
  stat: ColumnStatistics,
  op: '<' | '<=' | '>' | '>=',
  value: Value,
  clause: string,
): Estimate {
  if (stat.histogram.length < 2) {
    // No histogram. When the MCV list covers every distinct value — which is
    // what a column with few distinct values gets, and why no histogram was
    // built — the answer is the sum of the listed frequencies in range, and it
    // is exact rather than an assumption.
    const listed = mcvTotal(stat);
    if (stat.mcv.length > 0 && listed + stat.nullFraction > 0.99) {
      let inRange = 0;
      for (const e of stat.mcv) if (matches(e.value, op, value)) inRange += e.frequency;
      return {
        selectivity: clamp01(inRange),
        trace: {
          clause, method: 'mcv',
          inputs: { mcvEntries: stat.mcv.length, mcvInRange: inRange, mcvTotal: listed },
          result: clamp01(inRange),
          assumptions: [
            `the most-common-values list covers every value of this column, so the matching frequencies are summed directly`,
          ],
        },
      };
    }
    return {
      selectivity: DEFAULT_RANGE_SELECTIVITY,
      trace: {
        clause, method: 'default',
        inputs: { default: DEFAULT_RANGE_SELECTIVITY },
        result: DEFAULT_RANGE_SELECTIVITY,
        assumptions: ['No histogram was collected for this column, so the default range selectivity applies'],
      },
    };
  }

  const position = locate(stat.histogram, value);
  const below = op === '<' || op === '<=';
  const histogramFraction = below ? position.fraction : 1 - position.fraction;

  // The histogram describes only the non-MCV, non-null rows.
  const mcvSum = mcvTotal(stat);
  const histogramShare = Math.max(0, 1 - mcvSum - stat.nullFraction);

  let mcvInRange = 0;
  for (const e of stat.mcv) if (matches(e.value, op, value)) mcvInRange += e.frequency;

  const selectivity = clamp01(histogramFraction * histogramShare + mcvInRange);
  return {
    selectivity,
    trace: {
      clause, method: 'histogram',
      inputs: {
        bucket: position.bucket,
        buckets: stat.histogram.length - 1,
        withinBucket: position.within,
        histogramFraction,
        histogramShare,
        mcvInRange,
        nullFraction: stat.nullFraction,
      },
      result: selectivity,
      assumptions: [
        `bucket ${position.bucket + 1} of ${stat.histogram.length - 1} is partially covered, interpolated linearly at ${(position.within * 100).toFixed(1)}%`,
        'values are assumed uniformly distributed inside each bucket',
      ],
    },
  };
}

function matches(v: Value, op: '<' | '<=' | '>' | '>=', bound: Value): boolean {
  if (v === null || bound === null) return false;
  if (op === '<') return v < bound;
  if (op === '<=') return v <= bound;
  if (op === '>') return v > bound;
  return v >= bound;
}

// ── Conjunction: the app's subject ───────────────────────────────────────────

/**
 * A conjunction of clauses.
 *
 * With no multivariate statistics this multiplies. That is the independence
 * assumption, and it is the thing the app is about, so it is implemented plainly
 * and labelled `independence` in the trace rather than quietly improved.
 *
 * The repairs are tried in Postgres's own order: a multivariate MCV list first,
 * since it records the answer rather than a rule; then functional dependencies;
 * then independence for whatever is left over.
 */
export function estimateConjunction(parts: Expr[], ctx: EstimationContext): Estimate {
  const clause = parts.map(formatExpr).join(' AND ');
  const children = parts.map((p) => estimateAtom(p, ctx));

  const equalities = parts.map((p, i) => ({ part: p, index: i, eq: asColumnEquality(p, ctx) }))
    .filter((e): e is { part: Expr; index: number; eq: ColumnEquality } => e.eq !== null);

  if (equalities.length >= 2) {
    // A statistic need only cover a subset of the equalities. It corrects that
    // subset; whatever it does not cover still multiplies under independence.
    const stat = findMultivariate(
      ctx,
      equalities[0].eq.relation.table,
      equalities.map((e) => e.eq.column),
    );
    if (stat) {
      const covered = equalities.filter((e) => stat.columns.includes(e.eq.column));
      if (covered.length >= 2) {
        const eqs = covered.map((e) => e.eq);
        const indices = covered.map((e) => e.index);
        if (stat.mcv) {
          const applied = applyMultivariateMcv(stat, eqs, indices, children, parts, clause);
          if (applied) return applied;
        }
        if (stat.dependencies) {
          const applied = applyDependencies(stat, eqs, children, indices, parts, clause);
          if (applied) return applied;
        }
      }
    }
  }

  const selectivity = children.reduce((s, c) => s * c.selectivity, 1);
  const columnNames = uniqueColumnNames(parts);
  return {
    selectivity,
    trace: {
      clause, method: 'independence',
      inputs: Object.fromEntries(children.map((c, i) => [`clause${i + 1}`, c.selectivity])),
      result: selectivity,
      assumptions: [
        columnNames.length >= 2
          ? `independence between ${listWords(columnNames)}`
          : 'independence between the clauses',
      ],
      children: children.map((c) => c.trace),
    },
  };
}

interface ColumnEquality {
  relation: QueryRelation;
  column: string;
  value: Value;
  stat: ColumnStatistics | null;
}

function asColumnEquality(expr: Expr, ctx: EstimationContext): ColumnEquality | null {
  if (expr.kind !== 'binary' || expr.op !== '=') return null;
  const sides = orientComparison(expr.left, expr.right);
  if (!sides) return null;
  const resolved = resolveColumn(ctx, sides.column);
  if (!resolved) return null;
  return {
    relation: resolved.relation, column: sides.column.name,
    value: sides.value, stat: resolved.stat,
  };
}

/**
 * A multivariate MCV list covering the combination.
 *
 * If the exact combination is listed, its frequency is the answer outright — no
 * assumption at all, which is why this is the most powerful of the three
 * repairs. If it is not listed, the listed combinations are subtracted out and
 * independence is applied to the remainder, which is a smaller error than
 * independence over the whole column.
 */
function applyMultivariateMcv(
  stat: MultivariateStatistics,
  equalities: ColumnEquality[],
  indices: number[],
  children: Estimate[],
  parts: Expr[],
  clause: string,
): Estimate | null {
  if (!stat.mcv) return null;
  const order = stat.columns.map((c) => equalities.find((e) => e.column === c));
  if (order.some((e) => e === undefined)) return null;
  const values = order.map((e) => e!.value);

  // Clauses outside the statistic still multiply in, under independence.
  let uncovered = 1;
  for (let i = 0; i < parts.length; i++) if (!indices.includes(i)) uncovered *= children[i].selectivity;

  const listed = lookupCombination(stat.mcv, values);
  if (listed) {
    return {
      selectivity: clamp01(listed.frequency * uncovered),
      trace: {
        clause, method: 'multivariate-mcv',
        inputs: {
          frequency: listed.frequency,
          baseFrequency: listed.baseFrequency,
          ratio: listed.baseFrequency > 0 ? listed.frequency / listed.baseFrequency : 0,
        },
        result: clamp01(listed.frequency * uncovered),
        assumptions: [
          `this combination is listed in the multivariate MCV on ${stat.columns.join(', ')}, so no independence assumption is made`,
          `independence would have predicted ${formatFraction(listed.baseFrequency)}`,
        ],
        children: children.map((c) => c.trace),
      },
    };
  }

  const covered = listedFrequency(stat.mcv);
  const independent = indices.reduce((s, i) => s * children[i].selectivity, 1);
  const selectivity = clamp01(independent * Math.max(0, 1 - covered) * uncovered);
  return {
    selectivity,
    trace: {
      clause, method: 'multivariate-mcv',
      inputs: { listedTotal: covered, independent, result: selectivity },
      result: selectivity,
      assumptions: [
        `this combination is not listed in the multivariate MCV on ${stat.columns.join(', ')}`,
        `the ${formatFraction(covered)} of rows the list accounts for is subtracted out, then independence is assumed over the rest`,
      ],
      children: children.map((c) => c.trace),
    },
  };
}

/**
 * Functional dependencies.
 *
 * For `a = x AND b = y` where a determines b with degree d:
 *
 *   sel = sel(a) * (d + (1 - d) * sel(b))
 *
 * At d = 1 the second predicate contributes nothing, which is the correct answer
 * when a really does determine b. At d = 0 it reduces exactly to independence.
 */
function applyDependencies(
  stat: MultivariateStatistics,
  equalities: ColumnEquality[],
  children: Estimate[],
  indices: number[],
  parts: Expr[],
  clause: string,
): Estimate | null {
  if (!stat.dependencies) return null;

  // Order the clauses so the strongest determinant is applied first; each later
  // clause is then weakened by the degree to which an earlier one implies it.
  const items = equalities.map((eq, i) => ({
    eq,
    selectivity: children[indices[i]].selectivity,
  }));

  let best: { order: number[]; selectivity: number; applied: Array<{ from: string; to: string; degree: number }> } | null = null;
  for (let first = 0; first < items.length; first++) {
    const order = [first, ...items.map((_, i) => i).filter((i) => i !== first)];
    let selectivity = items[order[0]].selectivity;
    const applied: Array<{ from: string; to: string; degree: number }> = [];
    for (let k = 1; k < order.length; k++) {
      const to = items[order[k]];
      let d = 0;
      let from = '';
      for (let j = 0; j < k; j++) {
        const candidate = stat.dependencies.get(dependencyKey([items[order[j]].eq.column], to.eq.column)) ?? 0;
        if (candidate > d) { d = candidate; from = items[order[j]].eq.column; }
      }
      selectivity *= d + (1 - d) * to.selectivity;
      if (d > 0) applied.push({ from, to: to.eq.column, degree: d });
    }
    // The strongest dependency chain gives the largest estimate, and the
    // independence estimate is the floor. Prefer the chain that corrects most.
    if (best === null || selectivity > best.selectivity) best = { order, selectivity, applied };
  }
  if (!best || best.applied.length === 0) return null;

  // Clauses the dependency did not cover still multiply in, under independence.
  let selectivity = best.selectivity;
  for (let i = 0; i < parts.length; i++) {
    if (!indices.includes(i)) selectivity *= children[i].selectivity;
  }

  return {
    selectivity: clamp01(selectivity),
    trace: {
      clause, method: 'dependency',
      inputs: Object.fromEntries([
        ...best.applied.map((a) => [`${a.from}=>${a.to}`, a.degree] as const),
        ['result', clamp01(selectivity)] as const,
      ]),
      result: clamp01(selectivity),
      assumptions: best.applied.map((a) =>
        `${a.from} determines ${a.to} with degree ${a.degree.toFixed(3)}, so ${a.to} contributes `
        + `${a.degree >= 0.999 ? 'nothing' : `only ${((1 - a.degree) * 100).toFixed(1)}% of its own selectivity`}`),
      children: children.map((c) => c.trace),
    },
  };
}

// ── Disjunction ──────────────────────────────────────────────────────────────

function estimateDisjunction(expr: Expr & { kind: 'binary' }, ctx: EstimationContext): Estimate {
  const left = estimateExpr(expr.left, ctx);
  const right = estimateExpr(expr.right, ctx);
  // Inclusion-exclusion under independence.
  const selectivity = clamp01(left.selectivity + right.selectivity - left.selectivity * right.selectivity);
  return {
    selectivity,
    trace: {
      clause: formatExpr(expr), method: 'disjunction',
      inputs: { left: left.selectivity, right: right.selectivity },
      result: selectivity,
      assumptions: ['the two sides are assumed independent, so the overlap is their product'],
      children: [left.trace, right.trace],
    },
  };
}

// ── The remaining atoms ──────────────────────────────────────────────────────

function estimateComparison(
  op: string, left: Expr, right: Expr, ctx: EstimationContext,
): Estimate {
  const clause = formatExpr({ kind: 'binary', op: op as never, left, right });
  const sides = orientComparison(left, right);
  if (!sides) return fallback({ kind: 'binary', op: op as never, left, right }, 'Neither side is a column with statistics');

  const stat = resolveColumn(ctx, sides.column)?.stat ?? null;
  if (!stat) {
    return fallback({ kind: 'binary', op: op as never, left, right }, 'No statistics have been collected for this column');
  }

  const effectiveOp = sides.flipped ? flip(op) : op;
  switch (effectiveOp) {
    case '=': return estimateEquality(stat, sides.value, clause);
    case '<>': {
      const eq = estimateEquality(stat, sides.value, clause);
      const selectivity = clamp01(1 - eq.selectivity - stat.nullFraction);
      return {
        selectivity,
        trace: {
          clause, method: 'negation',
          inputs: { equality: eq.selectivity, nullFraction: stat.nullFraction },
          result: selectivity,
          assumptions: ['nulls do not satisfy <>, so the null fraction is excluded as well'],
          children: [eq.trace],
        },
      };
    }
    case '<': case '<=': case '>': case '>=':
      return estimateRange(stat, effectiveOp, sides.value, clause);
    default:
      return fallback({ kind: 'binary', op: op as never, left, right }, `The operator ${op} has no selectivity function`);
  }
}

function estimateIsNull(operand: Expr, negated: boolean, ctx: EstimationContext): Estimate {
  const clause = formatExpr({ kind: 'isnull', operand, negated });
  if (operand.kind !== 'column') return fallback(operand, 'IS NULL is only estimated for a plain column');
  const stat = resolveColumn(ctx, operand)?.stat ?? null;
  if (!stat) return fallback(operand, 'No statistics have been collected for this column');

  const selectivity = negated ? 1 - stat.nullFraction : stat.nullFraction;
  return {
    selectivity,
    trace: {
      clause, method: 'nullfrac',
      inputs: { nullFraction: stat.nullFraction },
      result: selectivity,
      assumptions: [`the null fraction is measured directly from the sample, with no assumption`],
    },
  };
}

/**
 * BETWEEN.
 *
 * The two bounds constrain the same column, so they are perfectly dependent and
 * multiplying their selectivities would understate the result badly — `x
 * BETWEEN 1 AND 10` on a column spanning 1..100 is 10%, not the 90% x 10% = 9%
 * that independence gives, and the error grows as the range narrows. Postgres
 * has a special case for exactly this, and so does this: the answer is the
 * difference between the two histogram positions.
 */
function estimateBetween(expr: Expr & { kind: 'between' }, ctx: EstimationContext): Estimate {
  const clause = formatExpr(expr);
  if (expr.operand.kind !== 'column' || expr.low.kind !== 'literal' || expr.high.kind !== 'literal') {
    return fallback(expr, 'BETWEEN is only estimated for a plain column against two constants');
  }
  const stat = resolveColumn(ctx, expr.operand)?.stat ?? null;
  if (!stat) return fallback(expr, 'No statistics have been collected for this column');

  const atLeast = estimateRange(stat, '>=', expr.low.value, `${formatExpr(expr.operand)} >= ${formatValue(expr.low.value)}`);
  const atMost = estimateRange(stat, '<=', expr.high.value, `${formatExpr(expr.operand)} <= ${formatValue(expr.high.value)}`);

  if (atLeast.trace.method === 'default' || atMost.trace.method === 'default') {
    // Neither bound could be located, so the span between them is meaningless —
    // subtracting two guesses would give zero rather than an estimate. Postgres
    // uses a dedicated default for a bounded range, which is what applies here.
    const selectivity = expr.negated ? 1 - DEFAULT_RANGE_SELECTIVITY : DEFAULT_RANGE_SELECTIVITY;
    return {
      selectivity,
      trace: {
        clause, method: 'default',
        inputs: { default: DEFAULT_RANGE_SELECTIVITY },
        result: selectivity,
        assumptions: ['neither bound could be located in the statistics, so the default range selectivity applies'],
        children: [atLeast.trace, atMost.trace],
      },
    };
  }

  // Both fractions are measured from the same statistics, so the overlap is the
  // span between them rather than a product.
  const span = clamp01(atLeast.selectivity + atMost.selectivity - (1 - stat.nullFraction));
  const selectivity = expr.negated ? clamp01(1 - span - stat.nullFraction) : span;

  return {
    selectivity,
    trace: {
      clause, method: 'histogram',
      inputs: {
        atLeastLow: atLeast.selectivity,
        atMostHigh: atMost.selectivity,
        nullFraction: stat.nullFraction,
      },
      result: selectivity,
      assumptions: [
        'both bounds are located in the same histogram, so the answer is the span between them',
        'multiplying the two bounds would assume they are independent, which they are not — they constrain one column',
      ],
      children: [atLeast.trace, atMost.trace],
    },
  };
}

function estimateIn(expr: Expr & { kind: 'in' }, ctx: EstimationContext): Estimate {
  const clause = formatExpr(expr);
  if (expr.operand.kind !== 'column') return fallback(expr, 'IN is only estimated for a plain column');
  const stat = resolveColumn(ctx, expr.operand)?.stat ?? null;
  if (!stat) return fallback(expr, 'No statistics have been collected for this column');

  // A list of equalities on one column is mutually exclusive, so the
  // selectivities add rather than combining by inclusion-exclusion.
  const children: SelectivityTrace[] = [];
  let total = 0;
  for (const v of expr.values) {
    if (v.kind !== 'literal') continue;
    const e = estimateEquality(stat, v.value, formatExpr({ kind: 'binary', op: '=', left: expr.operand, right: v }));
    children.push(e.trace);
    total += e.selectivity;
  }
  const selectivity = clamp01(expr.negated ? 1 - total - stat.nullFraction : total);
  return {
    selectivity,
    trace: {
      clause, method: children.every((c) => c.method === 'mcv') ? 'mcv' : 'histogram',
      inputs: { values: expr.values.length, sum: total },
      result: selectivity,
      assumptions: ['the listed values are mutually exclusive, so their selectivities are summed'],
      children,
    },
  };
}

// ── Joins ────────────────────────────────────────────────────────────────────

/**
 * Join selectivity: 1 / max(nDistinct_left, nDistinct_right).
 *
 * The standard estimate, and it assumes every value on the smaller side has a
 * match on the larger — a containment assumption that a foreign key satisfies
 * and an arbitrary pair of columns does not.
 *
 * When both sides carry MCV lists the overlap between them is measured directly
 * for the listed values, which is a real improvement on skewed join keys.
 */
export function estimateJoin(
  left: ColumnStatistics | null,
  right: ColumnStatistics | null,
  clause: string,
): Estimate {
  if (!left || !right) {
    return {
      selectivity: DEFAULT_EQ_SELECTIVITY,
      trace: {
        clause, method: 'default',
        inputs: { default: DEFAULT_EQ_SELECTIVITY },
        result: DEFAULT_EQ_SELECTIVITY,
        assumptions: ['One side of the join has no statistics'],
      },
    };
  }

  const dLeft = distinctCount(left);
  const dRight = distinctCount(right);
  const base = 1 / Math.max(dLeft, dRight, 1);

  const nullAdjust = (1 - left.nullFraction) * (1 - right.nullFraction);

  if (left.mcv.length > 0 && right.mcv.length > 0) {
    // Matched MCV pairs contribute their exact product; the unmatched remainder
    // falls back to the uniform estimate over the values not in either list.
    const rightByValue = new Map(right.mcv.map((e) => [keyOf(e.value), e.frequency]));
    let matched = 0;
    let matchedLeft = 0;
    let matchedRight = 0;
    for (const e of left.mcv) {
      const f = rightByValue.get(keyOf(e.value));
      if (f !== undefined) {
        matched += e.frequency * f;
        matchedLeft += e.frequency;
        matchedRight += f;
      }
    }
    const restLeft = Math.max(0, 1 - left.nullFraction - matchedLeft);
    const restRight = Math.max(0, 1 - right.nullFraction - matchedRight);
    const restDistinct = Math.max(1, Math.max(dLeft, dRight) - left.mcv.length);
    const selectivity = clamp01(matched + (restLeft * restRight) / restDistinct);
    return {
      selectivity,
      trace: {
        clause, method: 'join',
        inputs: {
          nDistinctLeft: dLeft, nDistinctRight: dRight,
          mcvOverlap: matched, uniformPart: (restLeft * restRight) / restDistinct,
          uniform: base,
        },
        result: selectivity,
        assumptions: [
          'the most-common-value lists on both sides are matched pairwise, which is exact for those values',
          'the remaining values are assumed uniform and every value on the smaller side is assumed to have a match',
        ],
      },
    };
  }

  const selectivity = clamp01(base * nullAdjust);
  return {
    selectivity,
    trace: {
      clause, method: 'join',
      inputs: { nDistinctLeft: dLeft, nDistinctRight: dRight, nullAdjust },
      result: selectivity,
      assumptions: [
        'join selectivity is one over the larger distinct count',
        'every value on the smaller side is assumed to have a match on the larger — true for a foreign key, an assumption otherwise',
      ],
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function columnStat(
  ctx: EstimationContext, relation: QueryRelation, column: string,
): ColumnStatistics | null {
  return ctx.statistics.tables.get(relation.table)?.columns.get(column) ?? null;
}

/**
 * Resolve a column reference to its relation.
 *
 * An unqualified column names whichever relation in scope carries it. The
 * statistics know each table's columns, so this stays on the planner's side of
 * the boundary — no storage is consulted.
 */
export function resolveColumn(
  ctx: EstimationContext, ref: { table: string | null; name: string },
): { relation: QueryRelation; stat: ColumnStatistics | null } | null {
  if (ref.table !== null) {
    const relation = ctx.relations.get(ref.table);
    if (!relation) return null;
    return { relation, stat: columnStat(ctx, relation, ref.name) };
  }
  let found: QueryRelation | null = null;
  for (const relation of ctx.relations.values()) {
    if (ctx.statistics.tables.get(relation.table)?.columns.has(ref.name)) {
      // Ambiguous across relations: the planner cannot choose, so estimate at
      // the default rather than guess at one of them.
      if (found) return null;
      found = relation;
    }
  }
  if (!found) return null;
  return { relation: found, stat: columnStat(ctx, found, ref.name) };
}

/**
 * The statistic that best covers a set of columns.
 *
 * A statistic applies when the query mentions at least two of its columns and
 * mentions all of them — a statistic on (kota, provinsi) says nothing useful
 * about a query that constrains only kota. Among applicable statistics the one
 * covering the most columns wins, since it makes the fewest assumptions.
 */
export function findMultivariate(
  ctx: EstimationContext, table: string, columns: string[],
): MultivariateStatistics | null {
  const wanted = new Set(columns);
  let best: MultivariateStatistics | null = null;
  for (const s of ctx.statistics.multivariate) {
    if (s.table !== table) continue;
    if (!s.columns.every((c) => wanted.has(c))) continue;
    if (s.columns.length < 2) continue;
    if (!best || s.columns.length > best.columns.length) best = s;
  }
  return best;
}

interface Oriented {
  column: Extract<Expr, { kind: 'column' }>;
  value: Value;
  flipped: boolean;
}

/** Put the column on the left and the literal on the right. */
function orientComparison(left: Expr, right: Expr): Oriented | null {
  if (left.kind === 'column' && right.kind === 'literal') {
    return { column: left, value: right.value, flipped: false };
  }
  if (right.kind === 'column' && left.kind === 'literal') {
    return { column: right, value: left.value, flipped: true };
  }
  return null;
}

function flip(op: string): string {
  return op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : op === '>=' ? '<=' : op;
}

function uniqueColumnNames(parts: Expr[]): string[] {
  const seen = new Set<string>();
  for (const p of parts) for (const c of columnsIn(p)) seen.add(c.name);
  return [...seen];
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  return typeof v === 'string' ? `'${v}'` : String(v);
}

export function formatFraction(f: number): string {
  if (f === 0) return '0';
  if (f >= 0.01) return `${(f * 100).toFixed(2)}%`;
  return `1 in ${Math.round(1 / f).toLocaleString('en')}`;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
