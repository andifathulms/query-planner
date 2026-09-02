import { describe, it, expect } from 'vitest';
import { buildMcv } from '../src/stats/mcv.js';
import { buildHistogram, locate, interpolate } from '../src/stats/histogram.js';
import { analyze, estimateCorrelation, estimateDistinct } from '../src/stats/column.js';
import { reservoirSample } from '../src/stats/sample.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import { createMultivariate } from '../src/stats/multivariate/index.js';
import { degree, dependencyKey } from '../src/stats/multivariate/dependencies.js';
import { computeMultiMcv, listedFrequency } from '../src/stats/multivariate/mcv-multi.js';
import { ndistinctKey } from '../src/stats/multivariate/ndistinct.js';
import type { Value } from '../src/stats/types.js';
import { makeRng } from '../src/engine/rng.js';

describe('the MCV list', () => {
  it('promotes values that are much more common than average', () => {
    const values: Value[] = [
      ...Array(500).fill('a'), ...Array(300).fill('b'),
      ...Array.from({ length: 200 }, (_, i) => `rare${i}`),
    ];
    const { entries } = buildMcv(values, 100);
    expect(entries.map((e) => e.value)).toEqual(['a', 'b']);
    expect(entries[0].frequency).toBeCloseTo(0.5, 10);
  });

  it('promotes nothing from a uniform column, where frequencies would be noise', () => {
    const values: Value[] = Array.from({ length: 1000 }, (_, i) => i % 200);
    expect(buildMcv(values, 100).entries).toHaveLength(0);
  });

  it('keeps every value when they all fit, leaving the histogram nothing to do', () => {
    const values: Value[] = Array.from({ length: 1000 }, (_, i) => i % 5);
    const { entries, remainder } = buildMcv(values, 100);
    expect(entries).toHaveLength(5);
    expect(remainder).toHaveLength(0);
  });

  it('ignores nulls but counts them in the denominator', () => {
    const values: Value[] = [...Array(50).fill('a'), ...Array(50).fill(null)];
    const { entries } = buildMcv(values, 100);
    expect(entries[0].frequency).toBeCloseTo(0.5, 10);
  });
});

describe('the histogram', () => {
  it('is equi-depth: every bucket holds the same count', () => {
    const values: Value[] = Array.from({ length: 1000 }, (_, i) => i);
    const h = buildHistogram(values, 10);
    expect(h).toHaveLength(11);
    expect(h[0]).toBe(0);
    expect(h[10]).toBe(999);
    expect(h[5]).toBe(500);
  });

  it('puts boundaries close together where values are dense', () => {
    // 900 values in 0..9, 100 spread over 0..1000.
    const values: Value[] = [
      ...Array.from({ length: 900 }, (_, i) => i % 10),
      ...Array.from({ length: 100 }, (_, i) => i * 10),
    ];
    const h = buildHistogram(values, 10) as number[];
    expect(h[1] - h[0]).toBeLessThan(h[10] - h[9]);
  });

  it('locates a value by whole buckets plus interpolation', () => {
    const h = buildHistogram(Array.from({ length: 1000 }, (_, i) => i) as Value[], 10);
    const p = locate(h, 450);
    expect(p.bucket).toBe(4);
    expect(p.fraction).toBeCloseTo(0.45, 2);
  });

  it('interpolates strings by their leading bytes, as Postgres does', () => {
    expect(interpolate('a', 'c', 'b')).toBeCloseTo(0.5, 2);
    expect(interpolate(0, 10, 2.5)).toBeCloseTo(0.25, 10);
    expect(interpolate(5, 5, 5)).toBe(0);
  });
});

describe('the distinct estimator', () => {
  it('is exact when the sample is the whole table', () => {
    const values: Value[] = Array.from({ length: 100 }, (_, i) => i % 7);
    expect(estimateDistinct(values, reservoirSample(100, 100, 1))).toBe(7);
  });

  it('inflates when the sample shows many values only once', () => {
    // A high-cardinality column sampled thinly. A naive count would say 200;
    // the estimator must say substantially more.
    const values: Value[] = Array.from({ length: 200 }, (_, i) => i);
    const naive = 200;
    const estimated = estimateDistinct(values, reservoirSample(100_000, 200, 1));
    // All-unique reads as a unique column, which Postgres records as -1.
    expect(estimated).toBe(-1);

    const mixed: Value[] = [
      ...Array.from({ length: 150 }, (_, i) => i),
      ...Array.from({ length: 50 }, (_, i) => i % 10),
    ];
    const e2 = estimateDistinct(mixed, reservoirSample(100_000, 200, 1));
    const resolved = e2 < 0 ? -e2 * 100_000 : e2;
    expect(resolved).toBeGreaterThan(naive * 0.7);
  });
});

describe('the correlation estimator', () => {
  it('is 1 for a sorted column and near 0 for a shuffled one', () => {
    const sorted: Value[] = Array.from({ length: 500 }, (_, i) => i);
    expect(estimateCorrelation(sorted)).toBeCloseTo(1, 6);

    const reversed: Value[] = [...sorted].reverse();
    expect(estimateCorrelation(reversed)).toBeCloseTo(-1, 6);

    const rng = makeRng(19);
    const shuffled: Value[] = [...sorted];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(Math.abs(estimateCorrelation(shuffled))).toBeLessThan(0.3);
  });
});

describe('analyze', () => {
  const schema = buildDataset('wilayah', { rows: 24_000, correlation: 0.95, zipf: 0.8, seed: 7 });
  const { statistics, samples } = analyze(schema, { sampleSize: 3000, seed: 7 });

  it('records the sample it saw, so the sample view can show it', () => {
    const sample = samples.get('penduduk')!;
    expect(sample.rowIds).toHaveLength(3000);
    expect(sample.populationSize).toBe(24_000);
  });

  it('never scans the whole table to produce a statistic', () => {
    for (const [name, sample] of samples) {
      const table = schema.tables.get(name)!;
      expect(sample.rowIds.length).toBeLessThanOrEqual(Math.min(3000, table.rowCount));
    }
  });

  it('produces a statistic for every column of every table', () => {
    for (const [name, table] of schema.tables) {
      const stat = statistics.tables.get(name)!;
      for (const def of table.columns) expect(stat.columns.has(def.name)).toBe(true);
    }
  });

  it('finds the null fraction on the column that has nulls', () => {
    const jk = statistics.tables.get('penduduk')!.columns.get('jenis_kelamin')!;
    expect(jk.nullFraction).toBeGreaterThan(0.005);
    expect(jk.nullFraction).toBeLessThan(0.05);
  });

  it('finds a high physical correlation on the clustered column', () => {
    const kota = statistics.tables.get('kelurahan')!.columns.get('kota')!;
    expect(kota.correlation).toBeGreaterThan(0.5);
  });
});

describe('multivariate statistics', () => {
  const schema = buildDataset('wilayah', { rows: 24_000, correlation: 1, zipf: 0.6, seed: 3 });
  const { samples } = analyze(schema, { sampleSize: 4000, seed: 3 });
  const sample = samples.get('kelurahan')!;

  it('measures a dependency degree near 1 when one column determines the other', () => {
    const stat = createMultivariate(
      schema, sample,
      { table: 'kelurahan', columns: ['kota', 'provinsi'], kinds: ['dependencies'] },
      100,
    );
    const d = stat.dependencies!.get(dependencyKey(['kota'], 'provinsi'))!;
    expect(d).toBeGreaterThan(0.95);
  });

  it('measures a low degree in the direction that does not determine', () => {
    const uncorrelated = buildDataset('sintetis', { rows: 20_000, correlation: 0, zipf: 0, seed: 5 });
    const { samples: s2 } = analyze(uncorrelated, { sampleSize: 4000, seed: 5 });
    const stat = createMultivariate(
      uncorrelated, s2.get('fakta')!,
      { table: 'fakta', columns: ['a', 'b'], kinds: ['dependencies'] },
      100,
    );
    expect(stat.dependencies!.get(dependencyKey(['a'], 'b'))!).toBeLessThan(0.25);
  });

  it('computes distinct combinations far below the independence product', () => {
    const stat = createMultivariate(
      schema, sample,
      { table: 'kelurahan', columns: ['kota', 'provinsi'], kinds: ['ndistinct'] },
      100,
    );
    const combos = stat.nDistinct!.get(ndistinctKey(['kota', 'provinsi']))!;
    // With kota determining provinsi there are at most as many combinations as
    // cities — far fewer than cities x provinces.
    expect(combos).toBeLessThan(41 * 37);
  });

  it('carries what independence would have predicted on every MCV entry', () => {
    const entries = computeMultiMcv(
      [['x', 'x', 'x', 'y'], ['p', 'p', 'p', 'q']] as Value[][],
      10,
    );
    expect(entries[0].frequency).toBeCloseTo(0.75, 10);
    expect(entries[0].baseFrequency).toBeCloseTo(0.75 * 0.75, 10);
    expect(listedFrequency(entries)).toBeCloseTo(1, 10);
  });

  it('prices an MCV list far above the other two kinds', () => {
    const spec = { table: 'kelurahan' as const, columns: ['kota', 'provinsi'] };
    const deps = createMultivariate(schema, sample, { ...spec, kinds: ['dependencies'] }, 100);
    const mcv = createMultivariate(schema, sample, { ...spec, kinds: ['mcv'] }, 100);
    expect(mcv.storageBytes).toBeGreaterThan(deps.storageBytes * 10);
  });
});

describe('the dependency degree itself', () => {
  it('is 1 for an exact determination', () => {
    const from: Value[] = [1, 1, 2, 2, 3, 3];
    const to: Value[] = ['a', 'a', 'b', 'b', 'c', 'c'];
    expect(degree(from, to)).toBeCloseTo(1, 10);
  });

  it('is 0 when the dependent varies freely within each group', () => {
    const from: Value[] = [1, 1, 1, 1, 2, 2, 2, 2];
    const to: Value[] = ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'];
    expect(degree(from, to)).toBeCloseTo(0, 10);
  });

  it('is asymmetric: a fine column determines a coarse one, not the reverse', () => {
    const fine: Value[] = [1, 1, 2, 2, 3, 3, 4, 4];
    const coarse: Value[] = ['x', 'x', 'x', 'x', 'y', 'y', 'y', 'y'];
    expect(degree(fine, coarse)).toBeCloseTo(1, 10);
    expect(degree(coarse, fine)).toBeLessThan(0.5);
  });
});
