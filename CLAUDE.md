# CLAUDE.md — Query Planner

Build instructions for Claude Code. PRD.md is what and why. DESIGN.md is how it looks.

## Non-negotiables

1. **Write the engine.** No sql.js, no alasql, no PGlite in the shipped bundle. PGlite is a
   `devDependency` for the oracle only. Importing a database into `src/` deletes the reason
   the app exists.
2. **Statistics come from a sample, always.** Never compute a "statistic" by scanning the
   whole table and calling it an estimate. Sampling error is part of the subject.
3. **Estimation cannot see the data.** `src/planner/` must not import `src/storage/`. It
   reads `Statistics` objects and nothing else. Enforce with `no-restricted-imports`. This
   mirrors the estimator boundary in Mixed Traffic Simulator and it exists for the same
   reason: a planner that can peek at the truth is not a planner.
4. **The engine is pure and headless.** `src/engine/**` imports nothing — no React, no DOM,
   no `Math.random`, no `Date` except through an injected clock for timing instrumentation.
5. **All plans produce identical results.** This is a test, and it is the one that catches
   real executor bugs.
6. **No network at runtime.**

## Stack

- Vite + React 18 + TypeScript, strict.
- Plain CSS with custom properties.
- No SQL library, no parser generator, no charting library, no graph layout library — the
  lattice and the plan tree both have known, simple layouts and a general graph library
  would fight both.
- Vitest. `@electric-sql/pglite` as a `devDependency`.

## Layout

```
/
├─ src/
│  ├─ parser/
│  │  ├─ lexer.ts
│  │  ├─ parser.ts            # recursive descent, ~400 lines
│  │  └─ ast.ts
│  ├─ storage/
│  │  ├─ table.ts             # columnar arrays + row ids
│  │  ├─ btree.ts             # B+tree, range + equality
│  │  ├─ generator.ts         # synthetic data with correlation + Zipf skew
│  │  └─ datasets/            # the realistic schema
│  ├─ stats/
│  │  ├─ sample.ts            # reservoir sampling, size-controlled
│  │  ├─ histogram.ts         # equi-depth
│  │  ├─ mcv.ts
│  │  ├─ column.ts            # per-column stats bundle
│  │  ├─ multivariate/
│  │  │  ├─ dependencies.ts
│  │  │  ├─ ndistinct.ts
│  │  │  └─ mcv-multi.ts
│  │  └─ types.ts             # the Statistics boundary type
│  ├─ planner/                # MUST NOT import storage/
│  │  ├─ selectivity.ts
│  │  ├─ cardinality.ts
│  │  ├─ cost.ts
│  │  ├─ paths.ts             # access path generation
│  │  ├─ orders.ts            # interesting orders
│  │  ├─ selinger.ts          # the DP, with a full trace
│  │  └─ types.ts
│  ├─ executor/
│  │  ├─ nodes/               # one file per operator
│  │  ├─ execute.ts           # volcano driver + instrumentation
│  │  └─ trace.ts
│  ├─ views/
│  │  ├─ Lattice/
│  │  ├─ PlanTree/
│  │  ├─ Correlation/
│  │  ├─ Histogram/
│  │  ├─ CostBreakdown/
│  │  ├─ Sample/
│  │  ├─ Timeline/
│  │  └─ Recovery/
│  ├─ state/
│  ├─ ui/
│  └─ styles/
└─ tests/
   ├─ oracle.test.ts
   ├─ selectivity.test.ts
   ├─ enumeration.test.ts
   ├─ equivalence.test.ts     # all plans, same results
   └─ orders.test.ts
```

## 1. The statistics boundary

```ts
// src/stats/types.ts — the ONLY thing the planner may read
interface ColumnStatistics {
  column: string;
  nullFraction: number;
  nDistinct: number;             // negative means a ratio of row count, as Postgres does
  mcv: Array<{ value: Value; frequency: number }>;
  histogram: Value[];            // equi-depth bucket boundaries
  correlation: number;           // logical vs physical ordering
  sampleSize: number;
  tableRowCount: number;         // itself an estimate
}

interface MultivariateStatistics {
  columns: string[];
  dependencies?: Map<string, number>;   // "a=>b" → degree 0..1
  nDistinct?: Map<string, number>;      // "a,b" → distinct combinations
  mcv?: Array<{ values: Value[]; frequency: number; baseFrequency: number }>;
}
```

`baseFrequency` on the multivariate MCV is what independence *would* have predicted for that
combination. Carrying it means the correlation plot (§5.3) can draw the wrong belief and the
corrected one from the same object, which is exactly what the recovery view needs.

The lint rule:

```js
{
  files: ['src/planner/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: ['**/storage/**', '**/executor/**']
    }]
  }
}
```

## 2. Selectivity

Follow the Postgres model closely; it is well documented and the app's audience will
recognise it.

**Equality, value in MCV:** its frequency directly.

**Equality, value not in MCV:**
```
(1 − sum(mcvFrequencies) − nullFraction) / (nDistinct − mcv.length)
```

**Range:** locate the bounds in the histogram, count whole buckets, interpolate the partial
ones linearly within the bucket. Add MCV entries falling in range.

**Conjunction, no multivariate stats:** multiply. This is the independence assumption and it
is the app's subject — implement it plainly and label it in the trace as `independence`.

**Conjunction, with functional dependencies:** for `a = x AND b = y` where a determines b
with degree d:
```
sel = sel(a) * (d + (1 − d) * sel(b))
```
At d = 1, b contributes nothing. At d = 0 this reduces to independence.

**Conjunction, with a multivariate MCV:** if the combination is listed, use its frequency
directly. Otherwise fall back with the listed combinations subtracted out.

**Join:** `1 / max(nDistinct_left, nDistinct_right)`, adjusted by MCV overlap when both sides
have MCV lists.

**Every selectivity computation returns a trace:**

```ts
interface SelectivityTrace {
  clause: string;
  method: 'mcv' | 'histogram' | 'default' | 'independence'
        | 'dependency' | 'multivariate-mcv' | 'join';
  inputs: Record<string, number>;
  result: number;
  assumptions: string[];        // e.g. "independence between city and province"
}
```

The Histogram and Correlation views render this trace. They never recompute. Same discipline
as every other app in the family: the display and the computation are one object.

## 3. Cost model

```
seqScan     = pages * seq_page_cost + rows * cpu_tuple_cost
indexScan   = indexPages * random_page_cost
            + heapFetches * random_page_cost * (1 − correlationAdjustment)
            + rows * (cpu_tuple_cost + cpu_index_tuple_cost)
nestedLoop  = outer.cost + outer.rows * inner.costPerLoop
hashJoin    = build.cost + probe.cost
            + (build.rows + probe.rows) * cpu_operator_cost
            + spillCost(build.bytes, work_mem)
mergeJoin   = left.cost + right.cost + (left.rows + right.rows) * cpu_operator_cost
              (+ sort costs where inputs are not already ordered)
sort        = comparisons * cpu_operator_cost + spillCost(bytes, work_mem)
```

Costs are `(startup, total)` pairs, not scalars. `LIMIT` selects on startup cost, and that is
precisely why a `LIMIT 10` query wants a different plan. A scalar cost model cannot express
this and would silently remove one of the app's better demonstrations.

`spillCost` returns zero below `work_mem` and grows with the number of passes above it.
Spills are recorded so the timeline can show them.

Every cost returns its decomposition:

```ts
interface CostBreakdown {
  startup: number;
  total: number;
  terms: Array<{ label: string; value: number; kind: 'io' | 'cpu' }>;
}
```

The cost breakdown view renders `terms` directly.

## 4. Selinger enumeration

```ts
interface DpCell {
  relations: Set<TableId>;
  best: Plan;                       // cheapest by total cost
  bestByOrder: Map<SortOrder, Plan>; // interesting orders retained
  considered: Plan[];               // ALL candidates, kept for the lattice
  level: number;
}

function enumerate(query, stats, costParams): {
  cells: DpCell[];
  winner: Plan;
  order: DpCell[];   // the exact fill order, for animation
};
```

`considered` retains every candidate, including the losers. This is memory the algorithm
would normally throw away, and keeping it is the reason the lattice view is possible.

For 8 tables the worst case is 255 cells with a few candidates each. Trivial memory.
Do not optimise it away.

**Interesting orders.** A plan is retained if it is cheapest overall *or* cheapest for a sort
order that a later merge join, `GROUP BY` or `ORDER BY` could use. Without this, merge join
never wins and the app quietly teaches something false. `orders.test.ts` covers it with a
case that inverts when retention is disabled.

**Fill order.** The DP naturally proceeds level by level. Record the exact sequence in
`order` so the lattice animation replays the real search rather than a re-enactment.

## 5. Executor

Volcano iterators:

```ts
interface Operator {
  open(): void;
  next(): Row | null;
  close(): void;
  readonly stats: NodeStats;   // mutated during execution
}

interface NodeStats {
  actualRows: number;
  actualTimeMs: number;
  loops: number;
  spills: number;
  firstRowTimeMs: number | null;   // startup, for the timeline
}
```

`firstRowTimeMs` is what makes pipelining visible. A nested loop's first row arrives almost
immediately; a hash join's arrives only after the build completes. That difference is §5.7's
entire content.

Instrumentation must not dominate the measurement. Time with a coarse counter and sample,
rather than calling a clock per row.

## 6. Sampling

Reservoir sampling with a seeded PRNG, sample size as a control (default 30,000 rows, as
Postgres's default statistics target implies).

Record the sampled row ids. The Sample view (§5.6) needs to show exactly which rows the
statistics saw, and reproducing the sample from a seed is cheaper than storing it twice.

## 7. Rendering

SVG throughout. Nothing here has more than a few hundred elements and everything benefits
from focus, labels and keyboard reachability.

**Lattice layout:** levels stacked vertically, cells within a level laid out in a row and
ordered by relation set for stability — a cell must not move between renders. For 8 tables,
level 4 has 70 cells and needs horizontal scroll with the level label pinned.

**Plan tree layout:** Reingold–Tilford tidy tree, written directly. Plans are small and
shallow; a graph library is unnecessary weight.

Do not attach listeners per lattice cell at level 4 and above. One listener on the level
group, hit-tested by data attribute.

## 8. Animation

Hand-rolled, one rAF loop. The house rule, now settled across five apps:

**Continuous control → direct mapping, zero easing.** Cost parameter sliders, sample size,
correlation coefficient. Re-plan and re-render on the frame.

**Discrete control → timed transition.** Query change, dataset change, creating or dropping
a statistic, toggling cartesian products.

The 200 ms planning budget in PRD §8.3 exists so cost sliders can drive the lattice live.

## 9. State and URL

```ts
interface AppState {
  sql: string;
  dataset: DatasetId;
  generator: { rows: number; correlation: number; zipf: number };
  costParams: CostParams;
  sampleSize: number;
  multivariate: MultivariateSpec[];   // what the user has created
  seed: number;
  selected: { cell: string | null; node: string | null };
}
```

Everything except `selected` serialises to the URL. A surprising plan must be reproducible
from a link — this is how someone shares a counterexample.

## 10. Copy

English, sentence case, no exclamation marks.

Postgres terminology exactly as Postgres uses it: `Seq Scan`, `Index Scan`, `Nested Loop`,
`Hash Join`, `Merge Join`, `rows`, `width`, `cost`. The audience will map what they see here
onto real `EXPLAIN` output and any renaming breaks that transfer.

Every estimate states its method and its assumptions, from the `SelectivityTrace`. Not
"estimated 12 rows" but "estimated 12 rows — independence assumed between city and
province".

The simplification statements (PRD §6.1) sit next to the numbers they affect, not on an about
page.

## 11. Build order

Do not start the UI before step 6 passes.

1. Lexer, parser, AST. Tests on the accepted subset and on rejection messages.
2. Storage, B-tree, synthetic generator with correlation and skew.
3. Sampling, per-column statistics, selectivity with traces. Unit tests.
4. Cost model with breakdowns. Hand-calculation tests.
5. Access paths, interesting orders, Selinger DP with full trace. Exhaustive-search
   agreement test at small n.
6. Executor, all operators, `equivalence.test.ts`. **Gate.**
7. PGlite oracle, plan-shape agreement, divergence list. **Gate.**
8. Design tokens, shell, SQL input, plan tree with estimate/actual pairing.
9. The lattice, animated. This is the hero; get it right before anything else.
10. Cost breakdown wired to live parameter sliders.
11. Histogram and correlation views from the selectivity trace.
12. Multivariate statistics: dependencies, then n-distinct, then MCV.
13. The recovery view.
14. Sample view, execution timeline.
15. Reduced motion, keyboard, JSON export, mobile, Lighthouse.

## 12. Deployment

GitHub Pages via Actions. `base` set to the repo path. CI: typecheck → lint (including both
import restrictions) → test → oracle → build. Deploy only on green.
