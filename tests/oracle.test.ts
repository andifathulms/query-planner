/**
 * The oracle (PRD §7.1).
 *
 * Identical schema and data go into PGlite. It runs ANALYZE and EXPLAIN; we run
 * our own planner over our own sampled statistics. The assertion is plan-shape
 * agreement — join order and operator choice — not numerical identity, because
 * our cost model is simplified (PRD §6.1) and demanding identical costs would be
 * demanding we reimplement Postgres.
 *
 * Where the shapes disagree, the case goes on the divergence list below with a
 * reason. That list is a feature: it is a record of exactly which
 * simplifications matter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { plan } from '../src/planner/index.js';
import { analyze } from '../src/stats/column.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import { DEFAULT_COST_PARAMS, planChildren, walkPlan, type Plan } from '../src/planner/types.js';
import { explain, loadSchema, pgLeaves, pgShape, type PgNode } from './helpers/oracle-load.js';
import { DIVERGENCES, divergenceFor } from './helpers/divergences.js';

// Small enough to load into PGlite in reasonable time, large enough that the
// planner has a real choice to make.
const schema = buildDataset('wilayah', { rows: 60_000, correlation: 0.9, zipf: 0.8, seed: 17 });
const { statistics } = analyze(schema, { sampleSize: 3000, seed: 17 });
const params = DEFAULT_COST_PARAMS;

const CORPUS = [
  // Projections deliberately name non-indexed columns. Selecting only an
  // indexed column lets Postgres use an index-only scan, which this engine does
  // not implement — that case is on the divergence list below, once, rather
  // than contaminating every query in the corpus.
  'SELECT * FROM kecamatan c JOIN kabupaten b ON c.kabupaten_id = b.id',
  `SELECT k.nama FROM kelurahan k WHERE k.kota = 'Balikpapan'`,
  `SELECT p.pekerjaan FROM penduduk p WHERE p.umur = 40`,
  `SELECT p.pekerjaan FROM penduduk p WHERE p.umur BETWEEN 30 AND 35`,
  `SELECT k.nama, c.nama FROM kelurahan k JOIN kecamatan c ON k.kecamatan_id = c.id`,
  `SELECT k.nama, c.nama, b.nama FROM kelurahan k
     JOIN kecamatan c ON k.kecamatan_id = c.id
     JOIN kabupaten b ON c.kabupaten_id = b.id`,
  `SELECT k.nama, c.nama, b.nama, v.nama FROM kelurahan k
     JOIN kecamatan c ON k.kecamatan_id = c.id
     JOIN kabupaten b ON c.kabupaten_id = b.id
     JOIN provinsi v ON b.provinsi_id = v.id`,
  `SELECT p.pekerjaan, k.nama FROM penduduk p JOIN kelurahan k ON p.kelurahan_id = k.id
     WHERE k.kota = 'Surabaya'`,
  `SELECT k.kota, count(*) FROM kelurahan k GROUP BY k.kota`,
  `SELECT p.pekerjaan, count(*) FROM penduduk p GROUP BY p.pekerjaan`,
  `SELECT k.nama FROM kelurahan k ORDER BY k.penduduk LIMIT 10`,
  `SELECT c.nama, b.nama FROM kecamatan c LEFT JOIN kabupaten b ON c.kabupaten_id = b.id`,

  // Two cases kept deliberately because they are known to diverge. They are the
  // record of which simplifications actually change a decision.
  `SELECT p.id FROM penduduk p WHERE p.umur = 40`,
  `SELECT p.pekerjaan FROM penduduk p WHERE p.kelurahan_id = 12`,
];


let db: PGlite;

beforeAll(async () => {
  db = await loadSchema(schema);
}, 240_000);

afterAll(async () => { await db?.close(); });

/** Our plan's shape, in the same notation the oracle helper produces. */
function ourShape(p: Plan): string {
  const children = planChildren(p).map(ourShape);
  const label = p.operator === 'Seq Scan' || p.operator === 'Index Scan'
    ? `${p.operator}(${p.relation.alias})`
    : p.operator;
  return children.length === 0 ? label : `${label}[${children.join(' ')}]`;
}

function ourLeaves(p: Plan): string[] {
  const out: string[] = [];
  walkPlan(p, (node) => {
    if (node.operator === 'Seq Scan' || node.operator === 'Index Scan') out.push(node.relation.alias);
  });
  return out;
}

/** Scan operator per relation, which is the part of the shape most worth pinning. */
function scanChoices(p: Plan): Map<string, string> {
  const out = new Map<string, string>();
  walkPlan(p, (node) => {
    if (node.operator === 'Seq Scan' || node.operator === 'Index Scan') {
      out.set(node.relation.alias, node.operator);
    }
  });
  return out;
}

function pgScanChoices(node: PgNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: PgNode): void => {
    if (n.children.length === 0 && n.alias) out.set(n.alias, n.operator);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

function rootRows(p: Plan): number { return p.estimatedRows; }

describe('the oracle', () => {
  it('loaded the same data into both engines', async () => {
    for (const [name, table] of schema.tables) {
      const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}"`);
      expect(Number(result.rows[0].n), name).toBe(table.rowCount);
    }
  });

  for (const sql of CORPUS) {
    const label = sql.replace(/\s+/g, ' ').slice(0, 62);
    const divergence = divergenceFor(sql);

    it(`${divergence ? 'diverges, documented: ' : ''}${label}`, async () => {
      const ours = plan(sql, statistics, { params });
      const theirs = await explain(db, sql);

      const ourJoins = ourLeaves(ours.winner);
      const theirJoins = pgLeaves(theirs);

      if (divergence) {
        // A documented divergence still has to be the divergence we documented.
        expect(
          ourShape(ours.winner) !== pgShape(theirs)
          || ourJoins.join(',') !== theirJoins.join(','),
          `${label} no longer diverges; remove it from the divergence list`,
        ).toBe(true);
        return;
      }

      // Join order: which relations are read, in which order.
      expect(ourJoins, `join order\nours:   ${ourShape(ours.winner)}\ntheirs: ${pgShape(theirs)}`)
        .toEqual(theirJoins);

      // Operator choice at every scan.
      const ourScans = scanChoices(ours.winner);
      const theirScans = pgScanChoices(theirs);
      for (const [alias, operator] of theirScans) {
        if (ourScans.has(alias)) {
          expect(ourScans.get(alias), `scan on ${alias}\nours:   ${ourShape(ours.winner)}\ntheirs: ${pgShape(theirs)}`)
            .toBe(operator);
        }
      }
    }, 60_000);
  }
});

describe('row estimates fall within a stated factor', () => {
  // PRD §7.1: within a stated factor, not identical. Both engines estimate from
  // a sample, and they do not draw the same sample.
  const FACTOR = 10;

  for (const sql of CORPUS) {
    it(sql.replace(/\s+/g, ' ').slice(0, 62), async () => {
      const ours = rootRows(plan(sql, statistics, { params }).winner);
      const theirs = (await explain(db, sql)).estimatedRows;
      const ratio = Math.max(ours, theirs) / Math.max(1, Math.min(ours, theirs));
      expect(ratio, `ours ${ours.toFixed(0)} vs postgres ${theirs}`).toBeLessThan(FACTOR);
    }, 60_000);
  }
});

describe('the divergence list', () => {
  it('explains every entry', () => {
    for (const d of DIVERGENCES) {
      expect(d.reason.length, d.match).toBeGreaterThan(30);
      expect(d.simplification.length).toBeGreaterThan(0);
    }
  });

  it('names only queries that are actually in the corpus', () => {
    for (const d of DIVERGENCES) {
      expect(
        CORPUS.some((sql) => sql.replace(/\s+/g, ' ').includes(d.match)),
        `${d.match} matches no corpus query`,
      ).toBe(true);
    }
  });
});
