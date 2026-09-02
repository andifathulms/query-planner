import { describe, it, expect } from 'vitest';
import { plan } from '../src/planner/index.js';
import { enumerate } from '../src/planner/selinger.js';
import { resolveQuery } from '../src/planner/resolve.js';
import { parse } from '../src/parser/parser.js';
import { analyze } from '../src/stats/column.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import { DEFAULT_COST_PARAMS, planChildren, walkPlan, type Plan } from '../src/planner/types.js';
import { exhaustiveBest } from './helpers/exhaustive.js';

const schema = buildDataset('wilayah', { rows: 30_000, correlation: 0.9, zipf: 0.7, seed: 11 });
const { statistics } = analyze(schema, { sampleSize: 4000, seed: 11 });
const params = DEFAULT_COST_PARAMS;

const FOUR_TABLE = `
  SELECT k.nama, c.nama, b.nama, p.nama
  FROM kelurahan k
  JOIN kecamatan c ON k.kecamatan_id = c.id
  JOIN kabupaten b ON c.kabupaten_id = b.id
  JOIN provinsi p ON b.provinsi_id = p.id
  WHERE k.kota = 'Balikpapan'
`;

describe('the lattice is complete', () => {
  const result = plan(FOUR_TABLE, statistics, { params });

  it('fills every subset: 2^n - 1 cells', () => {
    expect(result.stats.subsets).toBe(2 ** 4 - 1);
    expect(result.cells.filter((c) => c.level === 1)).toHaveLength(4);
    expect(result.cells.filter((c) => c.level === 2)).toHaveLength(6);
    expect(result.cells.filter((c) => c.level === 3)).toHaveLength(4);
    expect(result.cells.filter((c) => c.level === 4)).toHaveLength(1);
  });

  it('keeps every candidate, losers included — the lattice needs them', () => {
    expect(result.stats.candidates).toBeGreaterThan(result.stats.filledSubsets);
    for (const cell of result.cells) {
      if (!cell.best) continue;
      expect(cell.considered.length).toBeGreaterThan(0);
      // The winner is the cheapest of them.
      const cheapest = Math.min(...cell.considered.map((c) => c.cost.total));
      expect(cell.best.cost.total).toBeCloseTo(cheapest, 8);
    }
  });

  it('leaves disconnected subsets unfilled rather than absent', () => {
    // The query is a chain k-c-b-p, so {k, b} has no clause connecting it. That
    // cell belongs in the lattice, recessed, because what the cartesian toggle
    // excludes is exactly what a reader should be able to see.
    const kb = result.cells.find((c) => c.key === 'b|k')!;
    expect(kb.best).toBeNull();
    expect(kb.skipped).toBe('disconnected');
    expect(result.stats.filledSubsets).toBeLessThan(result.stats.subsets);

    const withCartesian = plan(FOUR_TABLE, statistics, { params, allowCartesian: true });
    expect(withCartesian.stats.filledSubsets).toBe(withCartesian.stats.subsets);
  });

  it('orders considered candidates by cost, so the lattice can draw the losers', () => {
    for (const cell of result.cells) {
      for (let i = 1; i < cell.considered.length; i++) {
        expect(cell.considered[i].cost.total).toBeGreaterThanOrEqual(cell.considered[i - 1].cost.total);
      }
    }
  });

  it('records the fill order level by level, for the animation', () => {
    let previous = 0;
    for (const cell of result.order) {
      expect(cell.level).toBeGreaterThanOrEqual(previous);
      previous = cell.level;
    }
    // Unfilled cells never resolve, so they are not part of the fill order.
    expect(result.order).toHaveLength(result.stats.filledSubsets);
  });

  it('gives every cell a stable key that does not depend on discovery order', () => {
    const again = plan(FOUR_TABLE, statistics, { params });
    expect(result.cells.map((c) => c.key)).toEqual(again.cells.map((c) => c.key));
  });

  it('plans an 8-table query well inside the 200 ms budget', () => {
    const eight = `
      SELECT p.id FROM penduduk p
      JOIN kelurahan k ON p.kelurahan_id = k.id
      JOIN kecamatan c ON k.kecamatan_id = c.id
      JOIN kabupaten b ON c.kabupaten_id = b.id
      JOIN provinsi v ON b.provinsi_id = v.id
      JOIN kelurahan k2 ON k2.kecamatan_id = c.id
      JOIN kecamatan c2 ON c2.kabupaten_id = b.id
      JOIN kabupaten b2 ON b2.provinsi_id = v.id
    `;
    // The budget exists so cost sliders can drive the lattice live (CLAUDE.md
    // §8), and a drag re-plans continuously — so the figure that matters is a
    // sustained one, not the first call, which also pays for JIT compilation.
    // The suite runs one file at a time (vitest.config.ts) so this is a real
    // wall-clock measurement rather than a contended one.
    const times: number[] = [];
    for (let i = 0; i < 7; i++) times.push(plan(eight, statistics, { params }).stats.planningMs);
    const warm = times.slice(2).sort((a, b) => a - b);
    const median = warm[Math.floor(warm.length / 2)];

    const r = plan(eight, statistics, { params });
    expect(r.stats.subsets).toBe(2 ** 8 - 1);
    expect(median).toBeLessThan(200);
  });
});

describe('the DP agrees with exhaustive search', () => {
  // PRD §7.2: for small n, exhaustive search must produce the same optimum.
  const queries = [
    `SELECT * FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id`,
    `SELECT * FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id
      JOIN kabupaten b ON c.kabupaten_id = b.id`,
    FOUR_TABLE,
    `SELECT * FROM penduduk p JOIN kelurahan k ON p.kelurahan_id = k.id
      JOIN kecamatan c ON k.kecamatan_id = c.id
      WHERE p.umur > 40 AND k.kota = 'Surabaya'`,
  ];

  for (const [i, sql] of queries.entries()) {
    it(`matches the exhaustive optimum on query ${i + 1}`, () => {
      const spec = resolveQuery(parse(sql), statistics);
      const dp = enumerate(spec, statistics, { params });
      const brute = exhaustiveBest(spec, statistics, params);
      expect(dp.joinWinner.cost.total).toBeCloseTo(brute.cost.total, 6);
      expect(shape(dp.joinWinner)).toBe(shape(brute));
    });
  }
});

describe('cartesian products', () => {
  const disconnected = 'SELECT * FROM provinsi p, kabupaten b';

  it('are excluded by default, so a disconnected query cannot be planned', () => {
    expect(() => plan(disconnected, statistics, { params }))
      .toThrow(/No plan connects every table/);
  });

  it('are planned when the toggle is on', () => {
    const r = plan(disconnected, statistics, { params, allowCartesian: true });
    expect(r.stats.subsets).toBe(3);
    expect(r.stats.filledSubsets).toBe(3);
    // Every pair of rows, which is the instructive part.
    const p = statistics.tables.get('provinsi')!.rowCount;
    const b = statistics.tables.get('kabupaten')!.rowCount;
    expect(r.winner.estimatedRows).toBeCloseTo(p * b, 0);
  });

  it('counts how many splits it declined to consider', () => {
    const r = plan(FOUR_TABLE, statistics, { params });
    expect(r.stats.cartesianConsidered).toBeGreaterThan(0);
  });
});

describe('the plan the enumerator returns', () => {
  it('covers every relation exactly once', () => {
    const r = plan(FOUR_TABLE, statistics, { params });
    const scanned: string[] = [];
    walkPlan(r.winner, (p) => {
      if (p.operator === 'Seq Scan' || p.operator === 'Index Scan') scanned.push(p.relation.alias);
    });
    expect(scanned.sort()).toEqual(['b', 'c', 'k', 'p']);
  });

  it('carries a selectivity trace on the nodes that estimated something', () => {
    const r = plan(FOUR_TABLE, statistics, { params });
    let traced = 0;
    walkPlan(r.winner, (p) => { traced += p.traces.length; });
    expect(traced).toBeGreaterThan(0);
  });

  it('puts Limit at the root when the query has one', () => {
    const r = plan(`${FOUR_TABLE} LIMIT 10`, statistics, { params });
    expect(r.winner.operator).toBe('Limit');
    expect(r.winner.estimatedRows).toBeLessThanOrEqual(10);
  });

  it('puts an aggregate above the joins for GROUP BY', () => {
    const r = plan(
      `SELECT k.kota, count(*) FROM kelurahan k GROUP BY k.kota`,
      statistics, { params },
    );
    expect(['HashAggregate', 'GroupAggregate']).toContain(r.winner.operator);
  });

  it('is deterministic: the same inputs give the same plan', () => {
    const a = plan(FOUR_TABLE, statistics, { params });
    const b = plan(FOUR_TABLE, statistics, { params });
    expect(shape(a.winner)).toBe(shape(b.winner));
    expect(a.winner.cost.total).toBe(b.winner.cost.total);
  });
});

describe('cost parameters change the plan', () => {
  it('flips a scan from sequential to index when random_page_cost drops', () => {
    // PRD §8.5: a demonstrable case. The predicate is on an uncorrelated column,
    // so every heap fetch is a separate random read and random_page_cost has its
    // full leverage. 4.0 to 1.1 is the standard SSD adjustment.
    const sql = `SELECT * FROM penduduk p WHERE p.umur = 40`;
    const hdd = plan(sql, statistics, { params: { ...params, random_page_cost: 4.0 } });
    const ssd = plan(sql, statistics, { params: { ...params, random_page_cost: 1.1 } });
    expect(hdd.winner.operator).toBe('Seq Scan');
    expect(ssd.winner.operator).toBe('Index Scan');
  });

  it('leaves a well-clustered column on the index at either setting', () => {
    // The counterpart, and it is the honest half of the lesson: kelurahan is
    // physically ordered by kota, so the heap fetches are nearly sequential and
    // random_page_cost barely applies. The parameter is not a universal switch.
    const sql = `SELECT * FROM kelurahan k WHERE k.kota = 'Balikpapan'`;
    for (const rpc of [4.0, 1.1]) {
      expect(plan(sql, statistics, { params: { ...params, random_page_cost: rpc } }).winner.operator)
        .toBe('Index Scan');
    }
  });

  it('makes work_mem decide whether a hash join spills', () => {
    const sql = `SELECT * FROM penduduk p JOIN kelurahan k ON p.kelurahan_id = k.id`;
    const roomy = plan(sql, statistics, { params: { ...params, work_mem: 1024 ** 3 } });
    const cramped = plan(sql, statistics, { params: { ...params, work_mem: 64 * 1024 } });
    expect(cramped.winner.cost.total).toBeGreaterThan(roomy.winner.cost.total);
  });
});

/** A compact description of a plan's shape: operators and join order. */
export function shape(plan: Plan): string {
  const children = planChildren(plan).map(shape);
  const label = plan.operator === 'Seq Scan' || plan.operator === 'Index Scan'
    ? `${plan.operator}(${plan.relation.alias})`
    : plan.operator;
  return children.length === 0 ? label : `${label}[${children.join(' ')}]`;
}
