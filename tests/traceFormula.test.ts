/**
 * The working, checkable by hand.
 *
 * PRD §2 makes independence the app's subject, and the trace showed two inputs,
 * a label and an answer without ever showing the multiplication between them.
 * These tests pin the property that makes displaying it safe: the arithmetic is
 * rendered only when evaluating it reproduces the estimator's own result, so a
 * reader who checks the working can never find the app disagreeing with itself.
 */
import { describe, it, expect } from 'vitest';
import { formulaFor, METHOD_RULES } from '../src/ui/traceFormula.js';
import { estimateExpr } from '../src/planner/selectivity.js';
import { makeContext } from '../src/planner/cardinality.js';
import { parse } from '../src/parser/parser.js';
import { resolveQuery } from '../src/planner/resolve.js';
import { conjoin } from '../src/planner/paths.js';
import { analyze } from '../src/stats/column.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import type { SelectivityTrace } from '../src/planner/types.js';

const schema = buildDataset('wilayah', { rows: 20_000, correlation: 0.95, zipf: 0.8, seed: 3 });
const { statistics } = analyze(schema, { sampleSize: 3000, seed: 3 });

/** Every trace node produced for a query, root first. */
function traces(sql: string): SelectivityTrace[] {
  const spec = resolveQuery(parse(sql), statistics);
  const ctx = makeContext(spec, statistics);
  const out: SelectivityTrace[] = [];
  const walk = (t: SelectivityTrace): void => {
    out.push(t);
    for (const c of t.children ?? []) walk(c);
  };
  // Top-level ANDs arrive as separate restrictions; the independence step
  // happens when a scan conjoins them, which is where the app's subject lives.
  if (spec.restrictions.length > 0) {
    walk(estimateExpr(conjoin(spec.restrictions.map((r) => r.expr)), ctx).trace);
  }
  return out;
}

const CORRELATED = `SELECT k.nama FROM kelurahan k
  WHERE k.kota = 'Kupang' AND k.provinsi = 'Nusa Tenggara Timur'`;

describe('the displayed arithmetic', () => {
  it('writes out the multiplication independence performs', () => {
    const independence = traces(CORRELATED).find((t) => t.method === 'independence')!;
    expect(independence).toBeTruthy();
    const formula = formulaFor(independence)!;
    expect(formula.expression).toMatch(/^[\d.e+-]+ × [\d.e+-]+$/);
    expect(formula.verified).toBe(true);
  });

  it('reproduces the estimator result for every formula it offers', () => {
    // The load-bearing property. Any trace the UI writes a formula for must have
    // that formula evaluate to the number the estimator actually produced.
    const sqls = [
      CORRELATED,
      `SELECT k.nama FROM kelurahan k WHERE k.kota = 'Kupang' OR k.kota = 'Balikpapan'`,
      `SELECT k.nama FROM kelurahan k WHERE k.kota <> 'Kupang'`,
      `SELECT k.nama FROM kelurahan k WHERE k.penduduk BETWEEN 2000 AND 4000`,
    ];
    let offered = 0;
    for (const sql of sqls) {
      for (const trace of traces(sql)) {
        const f = formulaFor(trace);
        if (!f) continue;
        offered++;
        expect(`${trace.method}: ${f.expression} verified=${f.verified}`)
          .toBe(`${trace.method}: ${f.expression} verified=true`);
      }
    }
    expect(offered).toBeGreaterThan(2);
  });

  it('prints the interpolation arithmetic PRD §5.4 promises', () => {
    // The docstring in Histogram.tsx claimed this printed and it did not: the
    // only thing beneath the chart was a note about sample size.
    const range = traces(
      `SELECT k.nama FROM kelurahan k WHERE k.penduduk > 3000`,
    ).find((t) => t.method === 'histogram')!;
    expect(range).toBeTruthy();
    const f = formulaFor(range)!;
    expect(f.verified).toBe(true);
    expect(f.expression).toMatch(/×/);
  });

  it('offers nothing for a method whose answer is a table read, not a sum', () => {
    // A most-common-value lookup has no arithmetic to show. Silence is correct;
    // inventing an expression would be the failure mode.
    const mcv = traces(CORRELATED).find((t) => t.method === 'mcv')!;
    expect(formulaFor(mcv)).toBeNull();
  });

  it('states the rule for the method that applied it', () => {
    expect(METHOD_RULES.independence).toMatch(/multiplies the selectivities/);
    // Cited where the rule is applied, so every rule names its own mechanism.
    for (const [method, rule] of Object.entries(METHOD_RULES)) {
      expect(`${method}: ${rule!.length > 40}`).toBe(`${method}: true`);
    }
  });
});
