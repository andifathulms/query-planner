import { describe, it, expect } from 'vitest';
import {
  estimateEquality, estimateExpr, estimateJoin, estimateRange,
  type EstimationContext,
} from '../src/planner/selectivity.js';
import { parse } from '../src/parser/parser.js';
import type { ColumnStatistics, MultivariateStatistics, Statistics, Value } from '../src/stats/types.js';
import type { QueryRelation } from '../src/planner/types.js';
import { dependencyKey } from '../src/stats/multivariate/dependencies.js';
import { proportionStandardError, reservoirSample } from '../src/stats/sample.js';

/** A hand-written column statistic, so every expectation can be checked by hand. */
function column(overrides: Partial<ColumnStatistics> & { column: string }): ColumnStatistics {
  return {
    table: 't', type: 'int',
    nullFraction: 0, nDistinct: 100, mcv: [], histogram: [],
    correlation: 0, sampleSize: 1000, tableRowCount: 10000, averageWidth: 4,
    ...overrides,
  };
}

function context(columns: ColumnStatistics[], multivariate: MultivariateStatistics[] = []): EstimationContext {
  const relation: QueryRelation = { alias: 't', table: 't', rowCount: 10000, pageCount: 100, rowWidth: 40 };
  const statistics: Statistics = {
    tables: new Map([['t', {
      name: 't', rowCount: 10000, pageCount: 100, rowWidth: 40,
      columns: new Map(columns.map((c) => [c.column, c])),
    }]]),
    indexes: new Map(),
    multivariate,
    sampleSize: 1000,
  };
  return { statistics, relations: new Map([['t', relation]]) };
}

function where(sql: string, ctx: EstimationContext) {
  const q = parse(`SELECT * FROM t WHERE ${sql}`);
  return estimateExpr(q.where!, ctx);
}

describe('equality', () => {
  const stat = column({
    column: 'a',
    nDistinct: 10,
    mcv: [{ value: 1, frequency: 0.4 }, { value: 2, frequency: 0.2 }],
    nullFraction: 0.1,
  });

  it('uses an MCV frequency directly', () => {
    const e = estimateEquality(stat, 1, 'a = 1');
    expect(e.selectivity).toBe(0.4);
    expect(e.trace.method).toBe('mcv');
    expect(e.trace.assumptions[0]).toMatch(/most-common-values list/);
  });

  it('spreads the remainder over the values the list does not name', () => {
    // (1 - 0.6 mcv - 0.1 null) / (10 - 2) = 0.3 / 8
    const e = estimateEquality(stat, 7, 'a = 7');
    expect(e.selectivity).toBeCloseTo(0.0375, 10);
    expect(e.trace.inputs.remainingDistinct).toBe(8);
  });

  it('returns zero when the MCV list is exhaustive', () => {
    const exhaustive = column({
      column: 'a', nDistinct: 2,
      mcv: [{ value: 1, frequency: 0.7 }, { value: 2, frequency: 0.3 }],
    });
    expect(estimateEquality(exhaustive, 9, 'a = 9').selectivity).toBe(0);
  });

  it('resolves the negative nDistinct convention against the row count', () => {
    // -0.5 means half the rows are distinct: 5000 distinct values.
    const ratio = column({ column: 'a', nDistinct: -0.5, tableRowCount: 10000 });
    expect(estimateEquality(ratio, 3, 'a = 3').selectivity).toBeCloseTo(1 / 5000, 10);
  });
});

describe('ranges', () => {
  // Ten equi-depth buckets over 0..100, so each bucket holds 10% of the rows.
  const stat = column({
    column: 'v',
    histogram: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    nDistinct: 1000,
  });

  it('counts whole buckets', () => {
    expect(estimateRange(stat, '<', 30, 'v < 30').selectivity).toBeCloseTo(0.3, 10);
    expect(estimateRange(stat, '>', 30, 'v > 30').selectivity).toBeCloseTo(0.7, 10);
  });

  it('interpolates inside the partial bucket', () => {
    // 3 whole buckets, plus half of the fourth: 0.35.
    const e = estimateRange(stat, '<', 35, 'v < 35');
    expect(e.selectivity).toBeCloseTo(0.35, 10);
    expect(e.trace.inputs.withinBucket).toBeCloseTo(0.5, 10);
    expect(e.trace.assumptions[0]).toMatch(/bucket 4 of 10/);
  });

  it('clamps outside the histogram range', () => {
    expect(estimateRange(stat, '<', -5, 'v < -5').selectivity).toBe(0);
    expect(estimateRange(stat, '<', 500, 'v < 500').selectivity).toBeCloseTo(1, 10);
  });

  it('adds MCV entries falling in range, and scales the histogram by its share', () => {
    const withMcv = column({
      column: 'v',
      histogram: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      mcv: [{ value: 5, frequency: 0.2 }, { value: 95, frequency: 0.1 }],
      nullFraction: 0.1,
    });
    // Histogram covers 1 - 0.3 mcv - 0.1 null = 0.6 of the rows.
    // v < 50 takes half of that, 0.3, plus the MCV entry at 5: 0.2. Total 0.5.
    const e = estimateRange(withMcv, '<', 50, 'v < 50');
    expect(e.selectivity).toBeCloseTo(0.5, 10);
    expect(e.trace.inputs.mcvInRange).toBeCloseTo(0.2, 10);
  });

  it('falls back to a third with no histogram', () => {
    const e = estimateRange(column({ column: 'v' }), '<', 5, 'v < 5');
    expect(e.selectivity).toBeCloseTo(1 / 3, 10);
    expect(e.trace.method).toBe('default');
  });
});

describe('BETWEEN', () => {
  const ctx = context([column({
    column: 'v', histogram: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], nDistinct: 1000,
  })]);

  it('is the span between the bounds, not the product of them', () => {
    // 20..40 is a fifth of the histogram. Independence would give
    // (v >= 20) * (v <= 40) = 0.8 * 0.4 = 0.32, which is wrong by 60%.
    const e = where('v BETWEEN 20 AND 40', ctx);
    expect(e.selectivity).toBeCloseTo(0.2, 10);
    expect(e.trace.assumptions[1]).toMatch(/would assume they are independent/);
  });

  it('does not let a trailing AND clause change the bounds', () => {
    const e = where('v BETWEEN 20 AND 40 AND v > 0', ctx);
    expect(e.selectivity).toBeCloseTo(0.2, 10);
  });
});

describe('IN, IS NULL and <>', () => {
  const stat = column({
    column: 'a', nDistinct: 10, nullFraction: 0.2,
    mcv: [{ value: 1, frequency: 0.3 }, { value: 2, frequency: 0.1 }],
  });
  const ctx = context([stat]);

  it('sums IN because the values are mutually exclusive', () => {
    expect(where('a IN (1, 2)', ctx).selectivity).toBeCloseTo(0.4, 10);
  });

  it('reads IS NULL straight off the null fraction, with no assumption', () => {
    const e = where('a IS NULL', ctx);
    expect(e.selectivity).toBe(0.2);
    expect(e.trace.method).toBe('nullfrac');
    expect(where('a IS NOT NULL', ctx).selectivity).toBeCloseTo(0.8, 10);
  });

  it('excludes nulls from <>, which do not satisfy it', () => {
    expect(where('a <> 1', ctx).selectivity).toBeCloseTo(1 - 0.3 - 0.2, 10);
  });
});

describe('conjunction — the app’s subject', () => {
  const kota = column({
    column: 'kota', type: 'text', nDistinct: 100,
    mcv: [{ value: 'Balikpapan', frequency: 0.01 }],
  });
  const provinsi = column({
    column: 'provinsi', type: 'text', nDistinct: 37,
    mcv: [{ value: 'Kalimantan Timur', frequency: 0.01 }],
  });

  it('multiplies, and says so', () => {
    const ctx = context([kota, provinsi]);
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", ctx);
    expect(e.selectivity).toBeCloseTo(0.0001, 10);
    expect(e.trace.method).toBe('independence');
    expect(e.trace.assumptions[0]).toBe('independence between kota and provinsi');
  });

  it('recovers with a functional dependency at degree 1', () => {
    // kota determines provinsi exactly, so the second clause contributes
    // nothing and the answer is the first clause alone.
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['dependencies'],
      dependencies: new Map([
        [dependencyKey(['kota'], 'provinsi'), 1],
        [dependencyKey(['provinsi'], 'kota'), 0.03],
      ]),
      storageBytes: 112,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    expect(e.selectivity).toBeCloseTo(0.01, 10);
    expect(e.trace.method).toBe('dependency');
    expect(e.trace.assumptions[0]).toMatch(/kota determines provinsi with degree 1\.000.*contributes nothing/);
    // A hundredfold correction, which is the two orders of magnitude in PRD §2.
    expect(e.selectivity / 0.0001).toBeCloseTo(100, 5);
  });

  it('reduces to independence at degree 0', () => {
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['dependencies'],
      dependencies: new Map([[dependencyKey(['kota'], 'provinsi'), 0]]),
      storageBytes: 88,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    expect(e.selectivity).toBeCloseTo(0.0001, 10);
  });

  it('interpolates between the two at an intermediate degree', () => {
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['dependencies'],
      dependencies: new Map([[dependencyKey(['kota'], 'provinsi'), 0.5]]),
      storageBytes: 88,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    // 0.01 * (0.5 + 0.5 * 0.01)
    expect(e.selectivity).toBeCloseTo(0.01 * 0.505, 10);
  });

  it('prefers a listed multivariate MCV combination over any rule', () => {
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['mcv'],
      mcv: [{
        values: ['Balikpapan', 'Kalimantan Timur'] as Value[],
        frequency: 0.0097, baseFrequency: 0.0001,
      }],
      storageBytes: 400,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    expect(e.selectivity).toBe(0.0097);
    expect(e.trace.method).toBe('multivariate-mcv');
    // baseFrequency carries what independence would have said, so the recovery
    // view can draw both from one object.
    expect(e.trace.inputs.baseFrequency).toBe(0.0001);
    expect(e.trace.inputs.ratio).toBeCloseTo(97, 5);
  });

  it('subtracts the listed combinations out when the combination is not listed', () => {
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['mcv'],
      mcv: [{ values: ['Medan', 'Sumatera Utara'] as Value[], frequency: 0.5, baseFrequency: 0.01 }],
      storageBytes: 400,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    expect(e.selectivity).toBeCloseTo(0.0001 * 0.5, 10);
  });

  it('leaves clauses the statistic does not cover multiplying under independence', () => {
    const other = column({ column: 'x', nDistinct: 4 });
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'provinsi'], kinds: ['dependencies'],
      dependencies: new Map([[dependencyKey(['kota'], 'provinsi'), 1]]),
      storageBytes: 88,
    };
    const e = where(
      "kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur' AND x = 3",
      context([kota, provinsi, other], [stat]),
    );
    // The dependency handles the first two; x = 3 at 1/4 still multiplies.
    expect(e.selectivity).toBeCloseTo(0.01 * 0.25, 10);
  });

  it('ignores a statistic that does not cover the columns in the clause', () => {
    const stat: MultivariateStatistics = {
      table: 't', columns: ['kota', 'pulau'], kinds: ['dependencies'],
      dependencies: new Map([[dependencyKey(['kota'], 'pulau'), 1]]),
      storageBytes: 88,
    };
    const e = where("kota = 'Balikpapan' AND provinsi = 'Kalimantan Timur'", context([kota, provinsi], [stat]));
    expect(e.trace.method).toBe('independence');
  });
});

describe('disjunction', () => {
  it('uses inclusion-exclusion under independence', () => {
    const ctx = context([
      column({ column: 'a', nDistinct: 4 }),
      column({ column: 'b', nDistinct: 5 }),
    ]);
    const e = where('a = 1 OR b = 2', ctx);
    expect(e.selectivity).toBeCloseTo(0.25 + 0.2 - 0.05, 10);
  });
});

describe('joins', () => {
  it('is one over the larger distinct count', () => {
    const left = column({ column: 'id', nDistinct: 1000 });
    const right = column({ column: 'fk', nDistinct: 50 });
    const e = estimateJoin(left, right, 'a.id = b.fk');
    expect(e.selectivity).toBeCloseTo(1 / 1000, 10);
    expect(e.trace.method).toBe('join');
    expect(e.trace.assumptions[1]).toMatch(/every value on the smaller side/);
  });

  it('measures MCV overlap directly when both sides have lists', () => {
    const left = column({
      column: 'k', nDistinct: 10,
      mcv: [{ value: 1, frequency: 0.5 }, { value: 2, frequency: 0.1 }],
    });
    const right = column({
      column: 'k', nDistinct: 10,
      mcv: [{ value: 1, frequency: 0.4 }, { value: 9, frequency: 0.1 }],
    });
    const e = estimateJoin(left, right, 'a.k = b.k');
    // The pair (1, 1) contributes 0.5 * 0.4 = 0.2 exactly, which the uniform
    // estimate of 0.1 would have missed entirely.
    expect(e.trace.inputs.mcvOverlap).toBeCloseTo(0.2, 10);
    expect(e.selectivity).toBeGreaterThan(e.trace.inputs.uniform);
  });

  it('discounts nulls, which never join', () => {
    const left = column({ column: 'id', nDistinct: 100, nullFraction: 0.5 });
    const right = column({ column: 'fk', nDistinct: 100 });
    expect(estimateJoin(left, right, 'j').selectivity).toBeCloseTo(0.5 / 100, 10);
  });

  it('falls back when a side has no statistics', () => {
    const e = estimateJoin(null, column({ column: 'fk' }), 'j');
    expect(e.trace.method).toBe('default');
  });
});

describe('every estimate carries a trace', () => {
  const ctx = context([
    column({ column: 'a', nDistinct: 10, mcv: [{ value: 1, frequency: 0.3 }] }),
    column({ column: 'v', histogram: [0, 50, 100] }),
  ]);

  for (const sql of ['a = 1', 'a = 99', 'v < 25', 'v BETWEEN 10 AND 20', 'a IS NULL',
    'a IN (1, 2)', 'a = 1 AND v < 50', 'a = 1 OR v < 50', 'NOT a = 1', 'a <> 1']) {
    it(`traces ${sql}`, () => {
      const e = where(sql, ctx);
      expect(e.trace.clause.length).toBeGreaterThan(0);
      expect(e.trace.result).toBe(e.selectivity);
      expect(e.trace.assumptions.length).toBeGreaterThan(0);
      expect(e.selectivity).toBeGreaterThanOrEqual(0);
      expect(e.selectivity).toBeLessThanOrEqual(1);
    });
  }
});

describe('statistics collected from a sample', () => {
  it('degrades as the sample shrinks, and the interface can say by how much', () => {
    // Not a property of the estimator but of the sample it reads, which is why
    // the sample size is a control and the sampling error is shown (PRD §6.3).
    const wide = proportionStandardError(0.01, reservoirSample(1_000_000, 30_000, 1));
    const narrow = proportionStandardError(0.01, reservoirSample(1_000_000, 300, 1));
    expect(narrow).toBeGreaterThan(wide * 5);
  });

  it('draws the same rows for the same seed and a different set for another', () => {
    const a = reservoirSample(10_000, 100, 7).rowIds;
    const b = reservoirSample(10_000, 100, 7).rowIds;
    const c = reservoirSample(10_000, 100, 8).rowIds;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('samples the whole table when the target exceeds it', () => {
    const s = reservoirSample(50, 30_000, 1);
    expect(s.rowIds).toHaveLength(50);
    expect(proportionStandardError(0.5, s)).toBe(0);
  });
});
