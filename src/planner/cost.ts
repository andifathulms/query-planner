/**
 * The cost model (CLAUDE.md §3).
 *
 * Real parameters, real formulas, and not Postgres. Every simplification is
 * stated in `SIMPLIFICATIONS` and the interface prints each one next to the
 * number it affects (PRD §6.1).
 *
 * Costs are (startup, total) pairs. LIMIT selects on startup cost, and that is
 * precisely why `LIMIT 10` wants a different plan; a scalar cost model could not
 * express it and would silently remove one of the app's better demonstrations.
 */
import type { CostBreakdown, CostParams } from './types.js';

/** Bytes per page, the conventional Postgres block size. */
export const PAGE_SIZE = 8192;

export interface SpillResult {
  cost: number;
  /** Passes over the data beyond the first. Zero means it fitted in memory. */
  passes: number;
  spilled: boolean;
}

/**
 * The cost of not fitting in `work_mem`.
 *
 * Zero below the limit. Above it, the data is written out and read back once per
 * merge pass, and the number of passes grows logarithmically with how far over
 * the limit it is. Spills are recorded so the timeline can show them as events.
 */
export function spillCost(bytes: number, params: CostParams): SpillResult {
  if (bytes <= params.work_mem) return { cost: 0, passes: 0, spilled: false };
  const pages = Math.ceil(bytes / PAGE_SIZE);
  // Each pass writes every page and reads it back.
  const passes = Math.max(1, Math.ceil(Math.log2(bytes / params.work_mem)));
  return {
    cost: 2 * pages * passes * params.seq_page_cost,
    passes,
    spilled: true,
  };
}

type Term = { label: string; value: number; kind: 'io' | 'cpu' };

function terms(...entries: Array<Term | null>): Term[] {
  return entries.filter((e): e is Term => e !== null && e.value !== 0);
}

/**
 * A cost, with its decomposition computed on first access.
 *
 * Two things about this class earn their keep at eight relations, where the
 * search produces around 20,000 candidates:
 *
 * The terms are lazy. Each decomposition carries formatted labels, and only the
 * winner and the candidates of whichever lattice cell is selected are ever
 * rendered — building every label eagerly spent most of the planning budget on
 * strings nobody reads.
 *
 * It is a class rather than an object literal so that every cost in the search
 * shares one hidden class. With literals, the spilling operators returned a
 * different shape from the rest, and `cost.total` in the DP's sort comparator
 * became a megamorphic property access: it was the single hottest line in the
 * profile, above the arithmetic it was comparing.
 */
class Cost implements CostBreakdown {
  private cached: Term[] | null = null;

  constructor(
    readonly startup: number,
    readonly total: number,
    private readonly build: () => Term[],
    /** Present on the operators that can spill; null on the rest. */
    readonly spill: SpillResult | null = null,
  ) {}

  get terms(): Term[] { return (this.cached ??= this.build()); }
}

function lazy(startup: number, total: number, build: () => Term[]): CostBreakdown {
  return new Cost(startup, total, build);
}

function lazySpilling(
  startup: number, total: number, build: () => Term[], spill: SpillResult,
): CostBreakdown & { spill: SpillResult } {
  return new Cost(startup, total, build, spill) as CostBreakdown & { spill: SpillResult };
}

// ── Scans ────────────────────────────────────────────────────────────────────

export function seqScanCost(
  pages: number, rows: number, quals: number, params: CostParams,
): CostBreakdown {
  const io = pages * params.seq_page_cost;
  const cpu = rows * params.cpu_tuple_cost;
  const qual = rows * quals * params.cpu_operator_cost;
  // A sequential scan can return its first row as soon as the first page is
  // read, so its startup cost is effectively zero. This is what makes it
  // competitive under a small LIMIT even when its total cost is high.
  return lazy(0, io + cpu + qual, () => terms(
      { label: `${fmt(pages)} pages x seq_page_cost`, value: io, kind: 'io' },
      { label: `${fmt(rows)} rows x cpu_tuple_cost`, value: cpu, kind: 'cpu' },
    quals > 0 ? { label: `${fmt(rows)} rows x ${quals} quals x cpu_operator_cost`, value: qual, kind: 'cpu' } : null,
  ));
}

export interface IndexScanInput {
  /** Index pages touched: the descent plus the leaves the range covers. */
  indexPages: number;
  indexHeight: number;
  /** Index entries examined. */
  indexTuples: number;
  /** Rows the scan returns after the index quals. */
  rows: number;
  /** Rows in the table, for the cache-fraction calculation. */
  tableRows: number;
  tablePages: number;
  /** Physical correlation of the indexed column, -1..1. */
  correlation: number;
  /** Filters applied after the heap fetch. */
  quals: number;
}

/**
 * Index scan.
 *
 * The heap fetches are the interesting term. With correlation near 1 the rows
 * come out in physical order and the fetches are effectively sequential; near 0
 * each is a separate random read. Interpolating between the two on the square of
 * the correlation is what Postgres does, and it is why `random_page_cost` has
 * such leverage over this plan — dragging it from 4.0 to 1.1 is the standard SSD
 * adjustment, and it must visibly flip a plan (PRD §4.4).
 */
export function indexScanCost(input: IndexScanInput, params: CostParams): CostBreakdown {
  const {
    indexPages, indexHeight, indexTuples, rows, tableRows, tablePages, correlation, quals,
  } = input;

  // effective_cache_size discounts the index's own pages, which a repeated scan
  // finds resident. It deliberately does NOT discount the heap fetches: doing so
  // halves random_page_cost's effect on the term it dominates, and that term is
  // the whole reason dragging the parameter flips a plan.
  const indexCached = Math.min(1, params.effective_cache_size / Math.max(1, indexPages * PAGE_SIZE));
  const indexIo = (indexHeight + indexPages) * params.random_page_cost * (1 - 0.5 * indexCached);
  const indexCpu = indexTuples * params.cpu_index_tuple_cost;

  // How many distinct pages do `rows` heap fetches touch? At worst one each; at
  // best the pages the rows are clustered into. Never more pages than exist.
  const clusteredPages = tableRows === 0 ? 0 : Math.ceil((rows / tableRows) * tablePages);
  const randomPages = Math.min(rows, tablePages);
  const c = Math.abs(correlation);
  const heapPages = c * c * clusteredPages + (1 - c * c) * randomPages;
  const effectivePageCost = c * c * params.seq_page_cost + (1 - c * c) * params.random_page_cost;
  const heapIo = heapPages * effectivePageCost;

  const cpu = rows * params.cpu_tuple_cost;
  const qual = rows * quals * params.cpu_operator_cost;

  // The descent must complete before the first row appears. It is charged with
  // the same cache discount as the rest of the index, and never above the node's
  // own total — a startup cost exceeding the total would make the run cost
  // negative, and a nested loop above would then be paid to do work.
  const total = indexIo + indexCpu + heapIo + cpu + qual;
  const descent = indexHeight * params.random_page_cost * (1 - 0.5 * indexCached);
  return lazy(Math.min(descent, total), total, () => terms(
      { label: `${fmt(indexHeight + indexPages)} index pages x random_page_cost`, value: indexIo, kind: 'io' },
      { label: `${fmt(indexTuples)} index tuples x cpu_index_tuple_cost`, value: indexCpu, kind: 'cpu' },
      { label: `${fmt(heapPages)} heap pages, correlation ${correlation.toFixed(2)}`, value: heapIo, kind: 'io' },
      { label: `${fmt(rows)} rows x cpu_tuple_cost`, value: cpu, kind: 'cpu' },
    quals > 0 ? { label: `${fmt(rows)} rows x ${quals} quals x cpu_operator_cost`, value: qual, kind: 'cpu' } : null,
  ));
}

// ── Joins ────────────────────────────────────────────────────────────────────

/**
 * Nested loop.
 *
 * The inner side is re-scanned once per outer row, so the cost is linear in the
 * outer cardinality — which is exactly why an underestimated outer side is
 * catastrophic. Its startup cost is almost nothing, so it pipelines and wins
 * under a small LIMIT.
 */
export function nestedLoopCost(
  outer: CostBreakdown, outerRows: number,
  inner: CostBreakdown, innerRows: number,
  params: CostParams,
): CostBreakdown {
  // The inner side pays its startup once and its per-loop cost every time.
  const perLoop = inner.total - inner.startup;
  const loops = Math.max(1, outerRows);
  const innerCost = inner.startup + loops * perLoop;
  const cpu = loops * innerRows * params.cpu_operator_cost;
  return lazy(outer.startup + inner.startup, outer.total + innerCost + cpu, () => terms(
    { label: 'outer subtree', value: outer.total, kind: 'cpu' },
    { label: `inner subtree x ${fmt(loops)} loops`, value: innerCost, kind: 'io' },
    { label: `${fmt(loops * innerRows)} comparisons x cpu_operator_cost`, value: cpu, kind: 'cpu' },
  ));
}

/**
 * Hash join.
 *
 * The build side is blocking: not one output row appears until the whole hash
 * table is built, which is the entire content of the timeline view's contrast
 * with the nested loop. That blocking is expressed here as a startup cost equal
 * to the build side's total.
 */
export function hashJoinCost(
  build: CostBreakdown, buildRows: number, buildBytes: number,
  probe: CostBreakdown, probeRows: number,
  params: CostParams,
): CostBreakdown & { spill: SpillResult } {
  const spill = spillCost(buildBytes, params);
  // A build row is hashed and then inserted into the table. A probe row is
  // hashed and compared against what it lands on. Building is the dearer of the
  // two, which is why a planner hashes the smaller side — and a model that had
  // it the other way round would recommend hashing the larger relation, which
  // is wrong in a way a reader would notice.
  //
  // Charging both sides a flat single operator would also make a hash join and
  // a merge join cost exactly the same per row, and a merge join would then
  // never win on its own merits — the outcome CLAUDE.md §4 warns about. A merge
  // join still compares once per row from each side, so it stays the cheaper of
  // the two per row and buys that with its ordering requirement.
  const buildCpu = buildRows * (params.cpu_operator_cost + params.cpu_tuple_cost);
  const probeCpu = probeRows * 2 * params.cpu_operator_cost;
  const cpu = buildCpu + probeCpu;
  return lazySpilling(
    build.total + probe.startup + spill.cost, build.total + probe.total + cpu + spill.cost,
    () => terms(
      { label: 'build side (blocking)', value: build.total, kind: 'cpu' },
      { label: 'probe side', value: probe.total, kind: 'cpu' },
      { label: `${fmt(buildRows)} rows hashed and inserted`, value: buildCpu, kind: 'cpu' },
      { label: `${fmt(probeRows)} rows hashed and compared`, value: probeCpu, kind: 'cpu' },
      spill.spilled ? { label: `spill: ${spill.passes} extra pass${spill.passes === 1 ? '' : 'es'} over work_mem`, value: spill.cost, kind: 'io' } : null,
    ),
    spill,
  );
}

/**
 * Merge join.
 *
 * Cheap per row, but it requires both inputs sorted — which is the whole reason
 * interesting orders are retained. Where an input already carries the right
 * order, the sort disappears and this wins; without order retention it never
 * would, and the app would quietly teach something false.
 */
export function mergeJoinCost(
  left: CostBreakdown, leftRows: number,
  right: CostBreakdown, rightRows: number,
  params: CostParams,
): CostBreakdown {
  // One comparison per row from each side. Cheaper per row than a hash join,
  // which is what a merge join buys with its ordering requirement.
  const cpu = (leftRows + rightRows) * params.cpu_operator_cost;
  // Both sides must produce their first row, and a sort beneath either side
  // carries its own startup, which is where the sort cost shows up.
  return lazy(left.startup + right.startup, left.total + right.total + cpu, () => terms(
    { label: 'left subtree', value: left.total, kind: 'cpu' },
    { label: 'right subtree', value: right.total, kind: 'cpu' },
    { label: `${fmt(leftRows + rightRows)} rows merged x cpu_operator_cost`, value: cpu, kind: 'cpu' },
  ));
}

// ── Sort and aggregate ───────────────────────────────────────────────────────

/**
 * Sort.
 *
 * n log n comparisons, and fully blocking: nothing comes out until everything
 * has gone in, so the entire cost is startup cost. That is what makes a sort
 * ruinous under a LIMIT and what the timeline draws as a long hollow bar.
 */
export function sortCost(
  input: CostBreakdown, rows: number, bytes: number, params: CostParams,
): CostBreakdown & { spill: SpillResult } {
  const comparisons = rows <= 1 ? 0 : rows * Math.log2(rows);
  const cpu = comparisons * params.cpu_operator_cost;
  const spill = spillCost(bytes, params);
  const total = input.total + cpu + spill.cost;
  return lazySpilling(total, total, () => terms(
    { label: 'input subtree', value: input.total, kind: 'cpu' },
    { label: `${fmt(comparisons)} comparisons x cpu_operator_cost`, value: cpu, kind: 'cpu' },
    spill.spilled ? { label: `spill: ${spill.passes} merge pass${spill.passes === 1 ? '' : 'es'}`, value: spill.cost, kind: 'io' } : null,
  ), spill);
}

/** Hash aggregate: blocking, and it spills when the group table exceeds work_mem. */
export function hashAggregateCost(
  input: CostBreakdown, rows: number, groups: number, groupBytes: number,
  aggregates: number, params: CostParams,
): CostBreakdown & { spill: SpillResult } {
  const cpu = rows * (aggregates + 1) * params.cpu_operator_cost;
  const emit = groups * params.cpu_tuple_cost;
  const spill = spillCost(groupBytes, params);
  const total = input.total + cpu + emit + spill.cost;
  return lazySpilling(total, total, () => terms(
    { label: 'input subtree', value: input.total, kind: 'cpu' },
    { label: `${fmt(rows)} rows x ${aggregates + 1} x cpu_operator_cost`, value: cpu, kind: 'cpu' },
    { label: `${fmt(groups)} groups emitted x cpu_tuple_cost`, value: emit, kind: 'cpu' },
    spill.spilled ? { label: 'spill: group table over work_mem', value: spill.cost, kind: 'io' } : null,
  ), spill);
}

/**
 * Group aggregate: needs sorted input, but it pipelines — a group can be emitted
 * as soon as its last row arrives, so the startup cost is only the input's.
 */
export function groupAggregateCost(
  input: CostBreakdown, rows: number, groups: number, aggregates: number, params: CostParams,
): CostBreakdown {
  const cpu = rows * (aggregates + 1) * params.cpu_operator_cost;
  const emit = groups * params.cpu_tuple_cost;
  return lazy(input.startup, input.total + cpu + emit, () => terms(
    { label: 'input subtree', value: input.total, kind: 'cpu' },
    { label: `${fmt(rows)} rows x ${aggregates + 1} x cpu_operator_cost`, value: cpu, kind: 'cpu' },
    { label: `${fmt(groups)} groups emitted x cpu_tuple_cost`, value: emit, kind: 'cpu' },
  ));
}

/**
 * Limit.
 *
 * The node that makes startup cost matter. It pays the input's startup, then
 * only the fraction of the input's run cost it actually consumes — so a
 * pipelining plan beneath it is charged for a few rows and a blocking one is
 * charged for all of them.
 */
export function limitCost(
  input: CostBreakdown, inputRows: number, count: number,
): CostBreakdown {
  const fraction = inputRows <= 0 ? 1 : Math.min(1, count / inputRows);
  const run = (input.total - input.startup) * fraction;
  return lazy(input.startup, input.startup + run, () => terms(
    { label: 'input startup, paid in full', value: input.startup, kind: 'cpu' },
    { label: `${(fraction * 100).toFixed(1)}% of the input's run cost`, value: run, kind: 'cpu' },
  ));
}

// ── The honesty note ─────────────────────────────────────────────────────────

/**
 * Where this model differs from Postgres. The interface prints each of these
 * next to the number it affects, not on an about page (CLAUDE.md §10).
 */
export const SIMPLIFICATIONS: Record<string, string> = {
  seqScan:
    'Postgres also charges for parallel workers and for the visibility map. '
    + 'Neither is modelled here.',
  indexScan:
    'Heap fetches are interpolated between clustered and random on the square of '
    + 'the correlation. Postgres uses a more elaborate function and also consults '
    + 'the index’s own correlation statistics.',
  cache:
    'effective_cache_size discounts index pages by up to half here and does not '
    + 'touch heap fetches. Postgres estimates cache residency per index scan with '
    + 'the Mackert-Lohman formula, which also accounts for repeated scans on the '
    + 'inner side of a nested loop.',
  nestedLoop:
    'A real planner can materialise the inner side and rescan it cheaply. This '
    + 'model charges the full inner cost on every loop.',
  hashJoin:
    'One hash table, one batch until work_mem is exceeded. Postgres chooses a '
    + 'batch count up front and can rebalance during the build. Probe rows are '
    + 'charged two operators (a hash and a bucket comparison) against a merge '
    + 'join\'s one; Postgres counts the bucket occupancy rather than assuming one.',
  mergeJoin:
    'Merge cost is linear in the input sizes. Postgres also estimates how far '
    + 'into each input the merge will actually run, which matters when one side '
    + 'ends early.',
  sort:
    'n log n comparisons and a simple multi-pass spill. Postgres distinguishes '
    + 'quicksort, top-N heapsort and external merge sort, which differ by more '
    + 'than a constant.',
  bitmap:
    'Bitmap heap scans are not implemented. They are the classic "why did it not '
    + 'use my index" case, and their absence is the largest gap in this model.',
  parallel:
    'No parallel plans. Postgres would consider a parallel sequential scan on a '
    + 'table this size.',
  elapsed:
    'The cost model prices disk: a random page read costs four times a '
    + 'sequential one. This executor holds every table in memory, where both '
    + 'cost the same. So elapsed time here measures rows touched, not the I/O '
    + 'the model is reasoning about, and a plan that is right for a database on '
    + 'a disk can be the slower one in this browser. The estimate against the '
    + 'actual row count is the comparison this app is making; elapsed time is '
    + 'reported beside it, not instead of it.',
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function addCosts(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    startup: a.startup + b.startup,
    total: a.total + b.total,
    terms: [...a.terms, ...b.terms],
  };
}

export const ZERO_COST: CostBreakdown = { startup: 0, total: 0, terms: [] };
