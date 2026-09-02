/**
 * Load this engine's schema and data into PGlite, so the two planners are
 * looking at exactly the same table.
 *
 * PGlite is a devDependency and never reaches `src/` (CLAUDE.md §1). It exists
 * to answer one question: given identical data and statistics, does our planner
 * choose the same plan shape Postgres does?
 */
import { PGlite } from '@electric-sql/pglite';
import type { Schema, Table, Value } from '../../src/storage/table.js';

const PG_TYPES: Record<string, string> = {
  int: 'integer', float: 'double precision', text: 'text', bool: 'boolean',
};

export async function loadSchema(schema: Schema): Promise<PGlite> {
  const db = new PGlite();

  for (const [name, table] of schema.tables) {
    const columns = table.columns.map((c) => `"${c.name}" ${PG_TYPES[c.type]}`).join(', ');
    await db.exec(`CREATE TABLE "${name}" (${columns});`);
    await insertRows(db, name, table);
  }

  for (const key of schema.indexes.keys()) {
    const [table, column] = key.split('.');
    await db.exec(`CREATE INDEX "${table}_${column}_idx" ON "${table}" ("${column}");`);
  }

  // PGlite ships with enable_seqscan off — it is tuned for small in-browser
  // datasets, and leaving it that way would make Postgres pick an index scan
  // everywhere and turn every comparison into a false divergence.
  await db.exec('SET enable_seqscan = on;');

  // Parallel plans are not modelled here (SIMPLIFICATIONS.parallel), so asking
  // Postgres for one would be comparing a plan we cannot express.
  await db.exec('SET max_parallel_workers_per_gather = 0;');

  // The other planner parameters already match DEFAULT_COST_PARAMS:
  // seq_page_cost 1, random_page_cost 4, cpu_tuple_cost 0.01,
  // cpu_operator_cost 0.0025, work_mem 4 MB, effective_cache_size 4 GB.

  // The oracle must plan from collected statistics, as we do — comparing our
  // sampled statistics against Postgres's unanalyzed defaults would be
  // comparing nothing.
  await db.exec('ANALYZE;');
  return db;
}

/** Insert in batches. A row-at-a-time load takes minutes on a 40k table. */
async function insertRows(db: PGlite, name: string, table: Table): Promise<void> {
  const BATCH = 500;
  const columnList = table.columns.map((c) => `"${c.name}"`).join(', ');
  for (let start = 0; start < table.rowCount; start += BATCH) {
    const end = Math.min(start + BATCH, table.rowCount);
    const tuples: string[] = [];
    for (let r = start; r < end; r++) {
      tuples.push(`(${table.row(r).map(literal).join(', ')})`);
    }
    if (tuples.length === 0) continue;
    await db.exec(`INSERT INTO "${name}" (${columnList}) VALUES ${tuples.join(', ')};`);
  }
}

function literal(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${v.replace(/'/g, "''")}'`;
}

// ── Reading Postgres's plan ──────────────────────────────────────────────────

export interface PgNode {
  operator: string;
  relation: string | null;
  alias: string | null;
  estimatedRows: number;
  totalCost: number;
  children: PgNode[];
}

interface RawPlan {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Plan Rows': number;
  'Total Cost': number;
  'Startup Cost': number;
  Strategy?: string;
  Plans?: RawPlan[];
}

export async function explain(db: PGlite, sql: string): Promise<PgNode> {
  const result = await db.query<{ 'QUERY PLAN': Array<{ Plan: RawPlan }> }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
  );
  const raw = result.rows[0]['QUERY PLAN'][0].Plan;
  return convert(raw);
}

/**
 * Map Postgres node types onto ours.
 *
 * Nodes with no counterpart here — Gather, Materialize, Memoize, Result — are
 * transparent to the comparison and are skipped rather than treated as a
 * difference in shape. Bitmap scans are not: this engine has no bitmap layer
 * (PRD §4.2), so those cases go on the divergence list rather than being
 * quietly reinterpreted as index scans.
 */
const TRANSPARENT = new Set([
  'Gather', 'Gather Merge', 'Materialize', 'Memoize', 'Result', 'Subquery Scan',
  'Append', 'Hash',
]);

const OPERATOR_NAMES: Record<string, string> = {
  'Seq Scan': 'Seq Scan',
  'Index Scan': 'Index Scan',
  'Index Only Scan': 'Index Scan',
  'Nested Loop': 'Nested Loop',
  'Hash Join': 'Hash Join',
  'Merge Join': 'Merge Join',
  Sort: 'Sort',
  'Incremental Sort': 'Sort',
  Limit: 'Limit',
  'Bitmap Heap Scan': 'Bitmap Heap Scan',
  'Bitmap Index Scan': 'Bitmap Index Scan',
};

function convert(raw: RawPlan): PgNode {
  const children = (raw.Plans ?? []).map(convert);
  if (TRANSPARENT.has(raw['Node Type']) && children.length === 1) return children[0];

  let operator = OPERATOR_NAMES[raw['Node Type']] ?? raw['Node Type'];
  if (raw['Node Type'] === 'Aggregate') {
    operator = raw.Strategy === 'Hashed' ? 'HashAggregate' : 'GroupAggregate';
  }

  return {
    operator,
    relation: raw['Relation Name'] ?? null,
    alias: raw.Alias ?? null,
    estimatedRows: raw['Plan Rows'],
    totalCost: raw['Total Cost'],
    children,
  };
}

/** The join order and operator choice, as a comparable string. */
export function pgShape(node: PgNode): string {
  const children = node.children.map(pgShape);
  const label = node.alias ? `${node.operator}(${node.alias})` : node.operator;
  return children.length === 0 ? label : `${label}[${children.join(' ')}]`;
}

/** Scan leaves in order, which is the join order stripped of operator choice. */
export function pgLeaves(node: PgNode): string[] {
  if (node.children.length === 0) return node.alias ? [node.alias] : [];
  return node.children.flatMap(pgLeaves);
}
