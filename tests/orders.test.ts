import { describe, it, expect } from 'vitest';
import { enumerate } from '../src/planner/selinger.js';
import { resolveQuery } from '../src/planner/resolve.js';
import { interestingOrders } from '../src/planner/orders.js';
import { parse } from '../src/parser/parser.js';
import { analyze } from '../src/stats/column.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import { DEFAULT_COST_PARAMS, orderKey, satisfies, walkPlan, type SortOrder } from '../src/planner/types.js';

const schema = buildDataset('wilayah', { rows: 40_000, correlation: 0.9, zipf: 0.7, seed: 23 });
const { statistics } = analyze(schema, { sampleSize: 5000, seed: 23 });
const params = DEFAULT_COST_PARAMS;

function planWith(sql: string, retain: boolean, overrides: Partial<typeof params> = {}) {
  const spec = resolveQuery(parse(sql), statistics);
  return enumerate(spec, statistics, {
    params: { ...params, ...overrides }, retainInterestingOrders: retain,
  });
}

function operators(sql: string, retain: boolean, overrides: Partial<typeof params> = {}): string[] {
  const out: string[] = [];
  walkPlan(planWith(sql, retain, overrides).winner, (p) => out.push(p.operator));
  return out;
}

describe('which orders are interesting', () => {
  it('names both sides of every equi-join, for a merge join', () => {
    const spec = resolveQuery(parse(`
      SELECT * FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id
    `), statistics);
    const orders = interestingOrders(spec);
    const keys = orders.map((o) => orderKey(o.order));
    expect(keys).toContain('k.kecamatan_id:asc');
    expect(keys).toContain('c.id:asc');
    expect(orders.every((o) => o.reason === 'merge join')).toBe(true);
  });

  it('names the GROUP BY and ORDER BY orders too', () => {
    const spec = resolveQuery(parse(`
      SELECT k.kota, count(*) FROM kelurahan k GROUP BY k.kota ORDER BY k.penduduk
    `), statistics);
    const reasons = interestingOrders(spec).map((o) => o.reason);
    expect(reasons).toContain('group by');
    expect(reasons).toContain('order by');
  });

  it('offers no order for a query that could not use one', () => {
    const spec = resolveQuery(parse('SELECT * FROM kelurahan k WHERE k.penduduk > 100'), statistics);
    expect(interestingOrders(spec)).toHaveLength(0);
  });
});

describe('retention is what lets a merge join win', () => {
  // PRD §7.2 asks for a case that inverts when retention is disabled. A join
  // over the full tables on their indexed keys is it: with retention, the
  // index-ordered scans survive and feed a merge join with no sort; without it,
  // those scans lose their cells to the cheaper sequential scans and the merge
  // join has to pay for two sorts, so a hash join wins instead.
  const sql = `
    SELECT p.id, k.nama
    FROM penduduk p
    JOIN kelurahan k ON p.kelurahan_id = k.id
    ORDER BY p.kelurahan_id
  `;

  it('chooses a merge join over index-ordered inputs when orders are retained', () => {
    const ops = operators(sql, true);
    expect(ops).toContain('Merge Join');
  });

  it('loses the merge join entirely when retention is disabled', () => {
    const kept = operators(sql, true);
    const dropped = operators(sql, false);
    expect(kept).not.toEqual(dropped);
    expect(dropped).not.toContain('Merge Join');
  });

  it('costs more without retention, which is the whole argument', () => {
    const kept = planWith(sql, true).winner.cost.total;
    const dropped = planWith(sql, false).winner.cost.total;
    expect(dropped).toBeGreaterThan(kept);
  });

  it('reports how many orders it kept', () => {
    expect(planWith(sql, true).stats.ordersKept).toBeGreaterThan(0);
    expect(planWith(sql, false).stats.ordersKept).toBe(0);
  });
});

describe('retained plans are genuinely more expensive than the cell winner', () => {
  it('keeps a plan only because of its order, never because it is cheapest', () => {
    const result = planWith(`
      SELECT p.id FROM penduduk p JOIN kelurahan k ON p.kelurahan_id = k.id
    `, true);
    for (const cell of result.cells) {
      if (!cell.best) continue;
      for (const { plan, order } of cell.bestByOrder.values()) {
        // It is not the winner...
        expect(plan).not.toBe(cell.best);
        expect(plan.cost.total).toBeGreaterThanOrEqual(cell.best.cost.total);
        // ...and it carries the order it was kept for.
        expect(plan.order).not.toBeNull();
        expect(satisfies(plan.order as SortOrder, order)).toBe(true);
      }
    }
  });
});

describe('an ordered input removes the sort above it', () => {
  it('does not sort for ORDER BY when the plan already produced that order', () => {
    const sorted = operators(`
      SELECT p.id FROM penduduk p
      JOIN kelurahan k ON p.kelurahan_id = k.id
      ORDER BY p.kelurahan_id
    `, true);
    // The merge join emits in join-key order, which is the requested order, so
    // no Sort survives above it.
    const joinIndex = sorted.indexOf('Merge Join');
    if (joinIndex >= 0) {
      expect(sorted.slice(0, joinIndex)).not.toContain('Sort');
    }
  });

  it('chooses GroupAggregate when the group table would not fit', () => {
    // Grouping by a unique column makes one group per row, so the hash table is
    // the size of the table. Below work_mem the hash aggregate still wins —
    // hashing is cheaper than reading an index. Above it, the ordered index scan
    // that retention kept is cheaper than a spilling hash, and the group
    // aggregate pipelines through it.
    const sql = 'SELECT p.id, count(*) FROM penduduk p GROUP BY p.id';
    const roomy = operators(sql, true, { work_mem: 64 * 1024 * 1024 });
    expect(roomy).toContain('HashAggregate');

    const cramped = operators(sql, true, { work_mem: 64 * 1024 });
    expect(cramped).toContain('GroupAggregate');
    expect(cramped).toContain('Index Scan');
    expect(cramped).not.toContain('Sort');
  });
});
