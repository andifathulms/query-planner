import { describe, it, expect } from 'vitest';
import { BTreeIndex } from '../src/storage/btree.js';
import { Table, compareValues } from '../src/storage/table.js';
import { makeRng } from '../src/engine/rng.js';
import { correlatedCategory, physicallyCluster, zipfSampler } from '../src/storage/generator.js';
import { buildDataset } from '../src/storage/datasets/index.js';

const params = { rows: 6000, correlation: 0.9, zipf: 0.7, seed: 42 };

describe('the B+tree', () => {
  const rng = makeRng(1);
  const values = Array.from({ length: 5000 }, () => rng.int(400));
  const index = new BTreeIndex('t', 'v', values);

  it('finds every row for an equality lookup', () => {
    for (const key of [0, 7, 199, 399]) {
      const expected = values.flatMap((v, i) => (v === key ? [i] : []));
      expect(index.lookup(key).slice().sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('returns nothing for a missing key', () => {
    expect(index.lookup(9999)).toEqual([]);
  });

  it('matches a linear scan on every range, inclusive and exclusive', () => {
    const bounds: Array<[number | null, boolean, number | null, boolean]> = [
      [100, true, 200, true], [100, false, 200, false], [100, true, 200, false],
      [null, true, 50, true], [350, true, null, true], [null, true, null, true],
      [200, true, 200, true], [201, true, 200, true],
    ];
    for (const [lo, loInc, hi, hiInc] of bounds) {
      const got = [...index.range(lo, loInc, hi, hiInc)].sort((a, b) => a - b);
      const want = values.flatMap((v, i) => {
        if (lo !== null && (loInc ? v < lo : v <= lo)) return [];
        if (hi !== null && (hiInc ? v > hi : v >= hi)) return [];
        return [i];
      });
      expect(got, `range ${lo}..${hi}`).toEqual(want);
    }
  });

  it('yields in key order so an index scan can supply an ordering', () => {
    const keys = [...index.ordered()].map((i) => values[i]);
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThanOrEqual(keys[i - 1]);
  });

  it('is lazy, so a LIMIT above it stops early', () => {
    const gen = index.range(0, true, null, true);
    const first = [gen.next().value, gen.next().value];
    expect(first).toHaveLength(2);
    gen.return(undefined);
  });

  it('excludes nulls, as a Postgres b-tree scan on an equality qual does', () => {
    const withNulls = [1, null, 2, null, 3];
    const ix = new BTreeIndex('t', 'v', withNulls);
    expect(ix.entries).toBe(3);
    expect([...ix.ordered()]).toEqual([0, 2, 4]);
  });

  it('reports a height that grows with the key count', () => {
    expect(new BTreeIndex('t', 'v', [1, 2, 3]).height).toBe(1);
    expect(index.height).toBeGreaterThanOrEqual(2);
  });
});

describe('the generator', () => {
  it('produces the requested correlation, approximately', () => {
    for (const rho of [0, 0.5, 1]) {
      const rng = makeRng(7);
      const a = Array.from({ length: 20000 }, () => rng.int(50));
      const b = correlatedCategory(a, 20, rho, rng);
      // How concentrated is b given a? The modal b for each a is the one the
      // dependency determines; its share is the dependency degree we can see.
      const byA = new Map<number, Map<number, number>>();
      for (let i = 0; i < a.length; i++) {
        const counts = byA.get(a[i]) ?? new Map<number, number>();
        counts.set(b[i], (counts.get(b[i]) ?? 0) + 1);
        byA.set(a[i], counts);
      }
      let modal = 0;
      for (const counts of byA.values()) modal += Math.max(...counts.values());
      const rate = modal / a.length;
      // At rho the determined value is drawn with probability rho + (1 - rho) / distinct.
      expect(rate).toBeCloseTo(rho + ((1 - rho) / 20), 1);
    }
  });

  it('skews with the Zipf exponent', () => {
    const flat = countTop(0);
    const skewed = countTop(1.2);
    expect(skewed).toBeGreaterThan(flat * 3);
    function countTop(s: number): number {
      const rng = makeRng(3);
      const pick = zipfSampler(100, s, rng);
      let top = 0;
      for (let i = 0; i < 20000; i++) if (pick() === 0) top++;
      return top;
    }
  });

  it('clusters physically in proportion to the correlation', () => {
    const rng = makeRng(11);
    const rows = Array.from({ length: 3000 }, (_, i) => ({ k: rng.int(200), i }));
    const tight = physicallyCluster(rows, (r) => r.k, 0.98, makeRng(5));
    const loose = physicallyCluster(rows, (r) => r.k, 0.0, makeRng(5));
    expect(inversionRate(tight)).toBeLessThan(inversionRate(loose));
    function inversionRate(rs: Array<{ k: number }>): number {
      let bad = 0;
      for (let i = 1; i < rs.length; i++) if (rs[i].k < rs[i - 1].k) bad++;
      return bad / rs.length;
    }
  });

  it('is deterministic for a seed', () => {
    const a = buildDataset('sintetis', params).tables.get('fakta')!.column('a');
    const b = buildDataset('sintetis', params).tables.get('fakta')!.column('a');
    expect(a).toEqual(b);
  });
});

describe('the datasets', () => {
  it('builds wilayah with a consistent hierarchy', () => {
    const schema = buildDataset('wilayah', params);
    const kelurahan = schema.tables.get('kelurahan')!;
    const kecamatan = schema.tables.get('kecamatan')!;
    expect(kelurahan.rowCount).toBeGreaterThan(0);
    // Every foreign key resolves.
    for (const fk of kelurahan.column('kecamatan_id')) {
      expect(fk as number).toBeLessThan(kecamatan.rowCount);
    }
    expect(schema.indexes.get('kelurahan.kota')).toBeDefined();
  });

  it('reports pages from row width', () => {
    const t = new Table('t', [{ name: 'a', type: 'int', width: 4 }], [Array(4096).fill(1)]);
    expect(t.rowWidth).toBe(4);
    expect(t.pageCount).toBe(2);
  });

  it('sorts nulls last', () => {
    expect([3, null, 1].sort(compareValues)).toEqual([1, 3, null]);
  });
});
