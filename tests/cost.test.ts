import { describe, it, expect } from 'vitest';
import {
  groupAggregateCost, hashAggregateCost, hashJoinCost, indexScanCost, limitCost,
  mergeJoinCost, nestedLoopCost, seqScanCost, sortCost, spillCost, PAGE_SIZE, ZERO_COST,
} from '../src/planner/cost.js';
import { DEFAULT_COST_PARAMS, type CostBreakdown, type CostParams } from '../src/planner/types.js';

const p: CostParams = DEFAULT_COST_PARAMS;

function scan(total: number, startup = 0): CostBreakdown {
  return { startup, total, terms: [] };
}

describe('sequential scan, by hand', () => {
  it('is pages x seq_page_cost plus rows x cpu_tuple_cost', () => {
    // 100 pages x 1.0 + 10000 rows x 0.01 = 100 + 100 = 200
    const c = seqScanCost(100, 10_000, 0, p);
    expect(c.total).toBeCloseTo(200, 10);
  });

  it('charges each qual per row', () => {
    // + 10000 x 2 x 0.0025 = 50
    expect(seqScanCost(100, 10_000, 2, p).total).toBeCloseTo(250, 10);
  });

  it('has no startup cost, which is why it survives a LIMIT', () => {
    expect(seqScanCost(100, 10_000, 0, p).startup).toBe(0);
  });

  it('decomposes into terms that sum to the total', () => {
    const c = seqScanCost(100, 10_000, 2, p);
    expect(c.terms.reduce((s, t) => s + t.value, 0)).toBeCloseTo(c.total, 8);
    expect(c.terms.map((t) => t.kind)).toEqual(['io', 'cpu', 'cpu']);
  });
});

describe('index scan', () => {
  const base = {
    indexPages: 2, indexHeight: 2, indexTuples: 100,
    rows: 100, tableRows: 10_000, tablePages: 100, quals: 0,
  };

  it('pays the descent as startup cost', () => {
    // 2 levels x random_page_cost 4.0
    expect(indexScanCost({ ...base, correlation: 1 }, p).startup).toBeCloseTo(8, 10);
  });

  it('is much cheaper on a well-correlated column', () => {
    const clustered = indexScanCost({ ...base, correlation: 1 }, p).total;
    const scattered = indexScanCost({ ...base, correlation: 0 }, p).total;
    expect(scattered).toBeGreaterThan(clustered * 3);
  });

  it('responds to random_page_cost, which is the plan flip lever', () => {
    const input = { ...base, correlation: 0 };
    const hdd = indexScanCost(input, p).total;
    const ssd = indexScanCost(input, { ...p, random_page_cost: 1.1 }).total;
    expect(ssd).toBeLessThan(hdd);
    // And there is a crossover against a sequential scan of the same table.
    const seq = seqScanCost(100, 10_000, 0, p).total;
    expect(hdd).toBeGreaterThan(seq);
    expect(ssd).toBeLessThan(seq);
  });

  it('discounts random reads by effective_cache_size', () => {
    const input = { ...base, correlation: 0 };
    const cached = indexScanCost(input, p).total;
    const uncached = indexScanCost(input, { ...p, effective_cache_size: PAGE_SIZE }).total;
    expect(cached).toBeLessThan(uncached);
  });
});

describe('spill', () => {
  it('is free below work_mem', () => {
    const s = spillCost(p.work_mem - 1, p);
    expect(s).toEqual({ cost: 0, passes: 0, spilled: false });
  });

  it('grows with the number of passes above work_mem', () => {
    const small = spillCost(p.work_mem * 2, p);
    const large = spillCost(p.work_mem * 64, p);
    expect(small.spilled).toBe(true);
    expect(large.passes).toBeGreaterThan(small.passes);
    expect(large.cost).toBeGreaterThan(small.cost * 10);
  });

  it('is exactly two page reads per page per pass', () => {
    const bytes = p.work_mem * 2;
    const s = spillCost(bytes, p);
    expect(s.cost).toBeCloseTo(2 * Math.ceil(bytes / PAGE_SIZE) * s.passes * p.seq_page_cost, 8);
  });
});

describe('joins', () => {
  it('charges the inner side once per outer row', () => {
    const outer = scan(100);
    const inner = scan(50);
    const one = nestedLoopCost(outer, 1, inner, 10, p).total;
    const hundred = nestedLoopCost(outer, 100, inner, 10, p).total;
    // The outer side is paid once; everything above it scales with the loop
    // count, which is why an underestimated outer side is catastrophic.
    expect((hundred - 100) / (one - 100)).toBeCloseTo(100, 1);
  });

  it('gives a nested loop almost no startup cost, so it pipelines', () => {
    const c = nestedLoopCost(scan(100), 1000, scan(50), 10, p);
    expect(c.startup).toBe(0);
    expect(c.total).toBeGreaterThan(1000);
  });

  it('gives a hash join a startup cost equal to its whole build side', () => {
    const build = scan(500);
    const c = hashJoinCost(build, 1000, 1000 * 40, scan(200), 5000, p);
    expect(c.startup).toBeGreaterThanOrEqual(500);
    expect(c.spill.spilled).toBe(false);
  });

  it('records a hash join spill when the build exceeds work_mem', () => {
    const c = hashJoinCost(scan(500), 1_000_000, 1_000_000 * 40, scan(200), 5000, p);
    expect(c.spill.spilled).toBe(true);
    expect(c.terms.some((t) => t.label.includes('spill'))).toBe(true);
  });

  it('charges a hash join more per row than a merge join', () => {
    // A build row is hashed once; a probe row is hashed and then compared, so it
    // costs two operators. A merge join compares once per row from each side.
    // Charging both a flat operator per row would make them cost exactly the
    // same, and a merge join could then never win on its own merits — the
    // outcome CLAUDE.md §4 warns about.
    const left = scan(500), right = scan(400);
    const merge = mergeJoinCost(left, 10_000, right, 10_000, p);
    const fits = hashJoinCost(left, 10_000, 10_000 * 40, right, 10_000, p);
    expect(fits.total - merge.total).toBeCloseTo(10_000 * p.cpu_operator_cost, 8);

    // Give the hash join a build side that does not fit and merge wins by more.
    const spills = hashJoinCost(left, 2_000_000, 2_000_000 * 40, right, 10_000, p);
    expect(merge.total).toBeLessThan(spills.total);

    // Put an unavoidable sort under the merge join and hash wins instead.
    const sorted = sortCost(left, 1_000_000, 1_000_000 * 40, p);
    const withSort = mergeJoinCost(sorted, 1_000_000, right, 10_000, p);
    expect(withSort.total).toBeGreaterThan(
      hashJoinCost(left, 1_000_000, 1_000_000 * 8, right, 10_000, p).total,
    );
  });

  it('carries a sort’s cost into the merge join’s startup cost', () => {
    const sorted = sortCost(scan(500), 10_000, 10_000 * 40, p);
    const merge = mergeJoinCost(sorted, 10_000, scan(400), 10_000, p);
    // The sort is blocking, so nothing emerges from the merge until it finishes.
    expect(merge.startup).toBeGreaterThanOrEqual(sorted.total);
  });
});

describe('sort and aggregate', () => {
  it('sorts at n log n comparisons', () => {
    // 1024 x log2(1024) = 1024 x 10 = 10240 comparisons x 0.0025 = 25.6
    const c = sortCost(ZERO_COST, 1024, 1024 * 8, p);
    expect(c.total).toBeCloseTo(25.6, 8);
  });

  it('makes a sort entirely startup cost, because it is blocking', () => {
    const c = sortCost(scan(100), 1000, 8000, p);
    expect(c.startup).toBe(c.total);
  });

  it('costs nothing to sort one row', () => {
    expect(sortCost(ZERO_COST, 1, 8, p).total).toBe(0);
  });

  it('makes a hash aggregate blocking and a group aggregate pipelining', () => {
    const input = scan(200, 50);
    const hash = hashAggregateCost(input, 10_000, 100, 100 * 40, 1, p);
    const group = groupAggregateCost(input, 10_000, 100, 1, p);
    expect(hash.startup).toBe(hash.total);
    expect(group.startup).toBe(50);
  });
});

describe('LIMIT, and why startup cost has to be a separate number', () => {
  it('charges only the fraction of the run cost it consumes', () => {
    const input = scan(1000, 0);
    expect(limitCost(input, 10_000, 10).total).toBeCloseTo(1, 8);
  });

  it('pays a blocking input’s startup cost in full', () => {
    const blocking = scan(1000, 1000); // a sort
    expect(limitCost(blocking, 10_000, 10).total).toBeCloseTo(1000, 8);
  });

  it('is the reason a pipelining plan can beat a cheaper blocking one', () => {
    // A nested loop that costs more overall but starts immediately.
    const nested = scan(5000, 0);
    // A hash join that costs less overall but must build first.
    const hashed = scan(2000, 1500);

    expect(hashed.total).toBeLessThan(nested.total);
    // Without LIMIT the hash join wins.
    expect(hashed.total).toBeLessThan(nested.total);
    // With LIMIT 10 out of 100,000 rows, the nested loop wins.
    const nestedLimited = limitCost(nested, 100_000, 10).total;
    const hashedLimited = limitCost(hashed, 100_000, 10).total;
    expect(nestedLimited).toBeLessThan(hashedLimited);
  });
});
