/**
 * Plan export (PRD §8.9) and the URL round trip (CLAUDE.md §9).
 *
 * A surprising plan must be reproducible from a link, and exportable as JSON.
 */
import { describe, it, expect } from 'vitest';
import { exportPlan } from '../src/ui/exportPlan.js';
import { decodeState, defaultState, encodeState } from '../src/state/url.js';
import { runQuery } from '../src/state/engine.js';
import { DEFAULT_COST_PARAMS } from '../src/planner/types.js';

const small = {
  ...defaultState(),
  generator: { ...defaultState().generator, rows: 6000 },
  sampleSize: 2000,
};

describe('the JSON export', () => {
  const result = runQuery(small);

  it('uses the same node names Postgres uses', () => {
    const json = exportPlan(small.sql, result.planning!, result.execution);
    const names: string[] = [];
    const walk = (node: typeof json.Plan): void => {
      names.push(node['Node Type']);
      node.Plans?.forEach(walk);
    };
    walk(json.Plan);
    for (const name of names) {
      expect([
        'Seq Scan', 'Index Scan', 'Nested Loop', 'Hash Join', 'Merge Join',
        'Sort', 'HashAggregate', 'GroupAggregate', 'Limit',
      ]).toContain(name);
    }
  });

  it('pairs the estimate with the actual at every node', () => {
    const json = exportPlan(small.sql, result.planning!, result.execution);
    expect(json.Plan['Plan Rows']).toBeGreaterThanOrEqual(0);
    expect(json.Plan['Actual Rows']).toBeGreaterThanOrEqual(0);
    expect(json.Execution?.['Execution Time']).toBeGreaterThanOrEqual(0);
  });

  it('carries the assumptions, which real EXPLAIN never shows', () => {
    const json = exportPlan(small.sql, result.planning!, result.execution);
    const assumptions: string[] = [];
    const walk = (node: typeof json.Plan): void => {
      assumptions.push(...(node.Assumptions ?? []));
      node.Plans?.forEach(walk);
    };
    walk(json.Plan);
    expect(assumptions.length).toBeGreaterThan(0);
    expect(assumptions.join(' ')).toMatch(/independence|most-common|uniformly/);
  });

  it('says once that real Postgres would give different numbers', () => {
    const json = exportPlan(small.sql, result.planning!, result.execution);
    expect(json.Note).toMatch(/[Rr]eal Postgres would give different numbers/);
  });

  it('serialises', () => {
    const json = exportPlan(small.sql, result.planning!, result.execution);
    expect(() => JSON.parse(JSON.stringify(json))).not.toThrow();
  });
});

describe('the URL', () => {
  it('omits everything left at its default', () => {
    expect(encodeState(defaultState())).toBe('');
  });

  it('round-trips a changed state', () => {
    const state = {
      ...defaultState(),
      sql: 'SELECT k.nama FROM kelurahan k WHERE k.kota = \'Medan\'',
      seed: 42,
      sampleSize: 1234,
      allowCartesian: true,
      generator: { rows: 50_000, correlation: 0.4, zipf: 1.1 },
      costParams: { ...DEFAULT_COST_PARAMS, random_page_cost: 1.1, work_mem: 65536 },
      multivariate: [
        { table: 'kelurahan', columns: ['kota', 'provinsi'], kinds: ['dependencies' as const] },
      ],
    };
    const decoded = decodeState(encodeState(state));
    expect(decoded.sql).toBe(state.sql);
    expect(decoded.seed).toBe(42);
    expect(decoded.sampleSize).toBe(1234);
    expect(decoded.allowCartesian).toBe(true);
    expect(decoded.generator).toEqual(state.generator);
    expect(decoded.costParams.random_page_cost).toBe(1.1);
    expect(decoded.costParams.work_mem).toBe(65536);
    expect(decoded.multivariate).toEqual(state.multivariate);
  });

  it('reproduces the plan a link encodes', () => {
    const flipped = {
      ...small,
      sql: 'SELECT p.pekerjaan FROM penduduk p WHERE p.umur = 40',
      costParams: { ...DEFAULT_COST_PARAMS, random_page_cost: 1.1 },
    };
    const link = encodeState(flipped);
    const restored = decodeState(link);
    // A link is only worth sharing if it reproduces the plan exactly.
    expect(runQuery(restored).planning?.winner.operator)
      .toBe(runQuery(flipped).planning?.winner.operator);
  });

  it('clamps values a hand-edited link puts out of range', () => {
    const decoded = decodeState('n=-5&r=9&z=-2&s=0&rpc=0');
    expect(decoded.generator.rows).toBeGreaterThanOrEqual(1000);
    expect(decoded.generator.correlation).toBeLessThanOrEqual(1);
    expect(decoded.generator.zipf).toBeGreaterThanOrEqual(0);
    expect(decoded.sampleSize).toBeGreaterThan(0);
    // A cost parameter of zero would make plans free and the search meaningless.
    expect(decoded.costParams.random_page_cost).toBeGreaterThan(0);
  });

  it('ignores a malformed statistic rather than refusing the link', () => {
    expect(decodeState('mv=kelurahan:kota:bogus').multivariate).toEqual([]);
    expect(decodeState('mv=nonsense').multivariate).toEqual([]);
  });
});
