/**
 * Functional dependency degrees, as `CREATE STATISTICS ... (dependencies)`.
 *
 * The degree of "a determines b" is the fraction of row pairs that agree on `a`
 * and also agree on `b`. At 1, knowing `a` tells you `b` exactly and the second
 * predicate in a conjunction contributes nothing. At 0 it reduces to
 * independence, which is what makes this the direct repair for the app's thesis
 * (PRD §2, §4.3).
 *
 * Postgres computes this over every ordered pair of columns in the group, in
 * both directions, because determination is not symmetric: a kelurahan
 * determines its provinsi, but a provinsi does not determine a kelurahan.
 */
import { keyOf } from '../mcv.js';
import type { Value } from '../types.js';

export function dependencyKey(from: string[], to: string): string {
  return `${from.join(',')}=>${to}`;
}

/**
 * Degrees for every single-column determinant in the group, both directions.
 *
 * `rows` is the sample, one array per column, in the order of `columns`.
 */
export function computeDependencies(columns: string[], rows: Value[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (let a = 0; a < columns.length; a++) {
    for (let b = 0; b < columns.length; b++) {
      if (a === b) continue;
      out.set(dependencyKey([columns[a]], columns[b]), degree(rows[a], rows[b]));
    }
  }
  return out;
}

/**
 * The degree to which `from` determines `to`.
 *
 * Group by the determinant; within each group the modal dependent value is the
 * one the dependency would predict. The share of rows carrying it, averaged
 * over groups weighted by size, is the degree. Groups of one row are excluded:
 * a value seen once trivially determines anything and would inflate the degree
 * of a high-cardinality column towards 1 for no real reason.
 */
export function degree(from: Value[], to: Value[]): number {
  const groups = new Map<string, Map<string, number>>();
  for (let i = 0; i < from.length; i++) {
    if (from[i] === null || to[i] === null) continue;
    const k = keyOf(from[i]);
    let counts = groups.get(k);
    if (!counts) { counts = new Map(); groups.set(k, counts); }
    const t = keyOf(to[i]);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  let supporting = 0;
  let considered = 0;
  for (const counts of groups.values()) {
    let total = 0, best = 0;
    for (const c of counts.values()) { total += c; if (c > best) best = c; }
    if (total < 2) continue;
    considered += total;
    supporting += best;
  }
  if (considered === 0) return 0;
  return clamp01((supporting - groupsCount(groups)) / Math.max(1, considered - groupsCount(groups)));
}

/** Groups with at least two rows — the ones `degree` considered. */
function groupsCount(groups: Map<string, Map<string, number>>): number {
  let n = 0;
  for (const counts of groups.values()) {
    let total = 0;
    for (const c of counts.values()) total += c;
    if (total >= 2) n++;
  }
  return n;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
