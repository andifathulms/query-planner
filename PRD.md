# Query Planner — Product Requirements

**Name:** Query Planner
**Descriptor:** Why your SQL is slow, and what the database believed when it chose
**Type:** Static single-page application. No backend, no network at runtime.
**Deploy target:** GitHub Pages.
**Interface language:** English.

> **On the name.** "Query Planner" names its subject the way Spectrogram does — plain, and
> immediately legible to the people who want it. **Cardinality** is the sharper alternative:
> it names the thesis rather than the surface. It is kept as the fallback if reach turns out
> to matter less than precision.

---

## 1. The thesis

You write SQL. The database does not execute what you wrote.

It parses it, rewrites it, then enumerates hundreds of physically different ways to compute
the same answer — which table to read first, index or full scan, nested loop or hash or
merge. Each candidate gets a cost. The cheapest wins.

Every one of those costs rests on a single guess: **how many rows will this operator
produce?** That guess comes from statistics — histograms, most-common-value lists, distinct
counts — which are a lossy summary of the table, collected from a sample, at some point in
the past.

Get the guess wrong and the planner chooses a nested loop expecting twelve rows, receives
four hundred thousand, and a 200 ms query becomes forty minutes. Nothing is broken. No index
is missing. The plan was chosen correctly from a belief that was false.

**The plan is not chosen by what is true. It is chosen by what the statistics predict, and
the statistics assume things that are not so.**

## 2. The assumption worth building around

Independence.

By default, a planner assumes predicates are unrelated. Write

```sql
WHERE city = 'Balikpapan' AND province = 'Kalimantan Timur'
```

and it multiplies the two selectivities as though knowing the city tells you nothing about
the province. If each is one in a hundred, it predicts one in ten thousand. The truth is one
in a hundred, because the second condition adds nothing once the first holds.

Two orders of magnitude, from an assumption nobody chose.

This is demonstrable in a way that is directly visual: plot the two columns as a scatter and
the correlation is obvious to any human eye. Overlay the rectangle that independence implies
and you are looking at a wrong belief as an area. Then create multivariate statistics and
watch the estimate and the plan recover (§5.8).

That arc — assumption, error, diagnosis, repair — is the app.

## 3. Architecture decision, and why

**The app contains its own database engine.** Storage, B-tree index, statistics collection,
selectivity estimation, cost model, plan enumeration, and a volcano-model executor.

This is not stubbornness. It is the only architecture that works, for two reasons:

1. `EXPLAIN` shows you the winner. It does not show you the sixty-two candidate plans that
   lost, and that search is the most visual thing in the entire subject.
2. The app's central claim requires showing the estimate and the truth side by side, at
   every node, from one system. Only an engine you control can produce both.

Roughly 2,500 lines. Every component is thoroughly documented in the literature.

**PGlite is the oracle** (§7), as a test-time dependency, never shipped.

## 4. Scope

### 4.1 SQL subset

Deliberately narrow. A hand-written recursive descent parser, about 400 lines, giving full
control of the AST for visualisation and better errors than a general parser.

In: `SELECT` with projections and expressions; `FROM` with inner and left joins, up to 8
tables; `WHERE` with `=`, `<`, `<=`, `>`, `>=`, `<>`, `BETWEEN`, `IN`, `IS NULL`, `AND`,
`OR`; `GROUP BY`; `HAVING`; `ORDER BY`; `LIMIT`; the aggregates `count`, `sum`, `avg`,
`min`, `max`.

Out: CTEs, window functions, correlated subqueries, `UNION`, outer joins beyond `LEFT`,
`DISTINCT ON`, lateral joins, recursive queries. Out of scope means the parser rejects them
with a message naming the limitation, not that it fails obscurely.

### 4.2 Physical operators

| Operator | Notes |
|---|---|
| Sequential scan | The baseline |
| Index scan | B-tree, range and equality |
| Nested loop join | Pipelining; catastrophic when cardinality is underestimated |
| Hash join | Blocking build side; spills when the build exceeds `work_mem` |
| Merge join | Requires sorted inputs; the reason interesting orders matter |
| Sort | Feeds merge join and `ORDER BY`; spills to a simulated disk |
| Hash aggregate | For `GROUP BY` |
| Group aggregate | For `GROUP BY` on sorted input |
| Limit | Because early termination changes which plan wins |

Bitmap heap scan is deferred to v2. It is the classic "why did it not use my index" case and
it is where `random_page_cost` bites hardest, but it needs a bitmap layer of its own.

### 4.3 Statistics — the heart of the app

**Per-column, matching the Postgres model:**

- null fraction
- number of distinct values
- a most-common-values list with frequencies
- an equi-depth histogram over the remainder
- physical correlation between logical order and physical order

**Sampling is real.** Statistics are collected from a sample, not from the whole table, with
the sample size as a user control. This is not a shortcut — it introduces a second, genuine
source of estimation error, and showing which rows the statistics actually saw (§5.6) is one
of the app's better teaching moments.

**Multivariate, all three kinds:**

1. **Functional dependencies** — the degree to which column A determines column B. Repairs
   the equality-conjunction case.
2. **Multivariate n-distinct** — the number of distinct combinations across a column group.
   Repairs `GROUP BY` estimates over correlated columns.
3. **Multivariate MCV lists** — most common *combinations*, with frequencies. The most
   powerful and the largest.

All three are creatable and droppable from the interface, and each shows what it costs to
store and what it repairs.

### 4.4 Cost model

Parameters, every one a live slider:

| Parameter | Default | Meaning |
|---|---|---|
| `seq_page_cost` | 1.0 | Sequential page read |
| `random_page_cost` | 4.0 | Random page read |
| `cpu_tuple_cost` | 0.01 | Processing one row |
| `cpu_index_tuple_cost` | 0.005 | Processing one index entry |
| `cpu_operator_cost` | 0.0025 | One operator or function call |
| `work_mem` | 4 MB | Before hashes and sorts spill |
| `effective_cache_size` | 4 GB | Assumed cache, affects index cost |

Dragging `random_page_cost` from 4.0 to 1.1 — the standard SSD adjustment every DBA makes —
must visibly flip a plan from sequential scan to index scan. That single interaction is
worth more than a page of explanation.

### 4.5 Plan enumeration

Selinger dynamic programming over subsets: optimal plans for every single table, then every
pair, then every triple, up to the full set. For n tables that is 2ⁿ−1 subsets.

**Interesting orders are included.** A plan is retained not only if it is cheapest, but also
if it is cheapest *for a sort order some later operator could exploit*. This is what makes
merge join ever win, and it is the part of Selinger most explanations omit.

Cap at 8 tables — 255 subsets, which is the limit of what the lattice view can render
legibly. Real Postgres switches to a genetic optimiser at 12 tables; state that threshold
and why, but do not implement GEQO.

Cartesian products are excluded by default with a toggle, because seeing what happens when
they are allowed is instructive.

### 4.6 Execution

Volcano iterator model — `open`, `next`, `close`. Every node instrumented with actual rows
produced, actual time, loops, and spill events.

Because the engine executes for real, `EXPLAIN` and `EXPLAIN ANALYZE` come from one system
and the estimate/actual pairing is exact rather than approximate.

### 4.7 Datasets

**Synthetic generator, primary.** A correlation coefficient slider between two columns,
sweepable from 0 to 1. Synthetic is better than real here because the app's subject is the
relationship between correlation and estimation error, and only a generator lets you control
it exactly.

Also: skew control (Zipf parameter), table size, and distinct-value counts.

**One realistic dataset** for credibility — a plausible Indonesian administrative schema
with genuine functional dependencies (kelurahan determines kecamatan determines kabupaten
determines provinsi), which is the independence failure in its purest form.

## 5. Instruments

Eight. Full visual and motion specification in DESIGN.md.

### 5.1 The lattice — the hero

Selinger's dynamic programming table, animated as it fills.

Level 1: every single table, with its best access path. Level 2: every pair, each built from
the level-1 results. Level 3: every triple. Up to the root.

Each cell resolves to a winner while its alternatives grey out. For six tables that is 63
cells across six levels, and watching them fill is watching the algorithm that runs inside
every database on earth.

Nobody visualises this. It is the strongest single reason to build the app.

Cells retained for interesting orders are marked distinctly, because a cell may hold two
plans — the cheapest, and the cheapest sorted.

### 5.2 The plan tree

The chosen plan, as a tree. Each node carries estimated rows and actual rows, and the
distance between them is drawn (DESIGN.md §0).

Leaves are usually close. Then the errors multiply through each join and the ratio climbs.
Watching 1.2× at a scan become 8× after one join and 300× at the root — with the error drawn
as a widening gap up the tree — is the app's clearest statement of why a small statistics
problem becomes a catastrophic plan.

### 5.3 The correlation plot

Two predicate columns as a 2D scatter. The independence assumption drawn on top as the
rectangle it implies: the product of two marginal selectivities.

The gap between that rectangle and the actual point cloud is the estimation error, as area.

When multivariate statistics exist, the rectangle is replaced by what those statistics
actually predict, and it snaps onto the cloud.

### 5.4 The histogram

One column's statistics in full: the MCV list as labelled bars, the equi-depth histogram as
buckets, the null fraction.

The active predicate is overlaid. Partially covered buckets are shown partially covered, the
interpolation is visible, and the resulting selectivity is computed in view — then the true
count beside it.

This is where "selectivity" stops being a word.

### 5.5 The cost breakdown

Every candidate plan for the current subset, as horizontal stacked bars decomposed into
startup cost, I/O terms and CPU terms.

Bars re-sort live as cost parameters change. Dragging `random_page_cost` and watching bars
reorder until a different plan reaches the top is the mechanism of §4.4 made visible.

### 5.6 The sample

The table, with the rows the statistics sample actually saw highlighted, and the rest dimmed.

Beside it: the estimate produced from that sample against the estimate from a full scan.
Shrink the sample and watch the estimate degrade and the plan eventually flip. This is why
`ANALYZE` matters, shown rather than asserted.

### 5.7 The execution timeline

The volcano model in motion. Tuples flowing up through operators, showing which operators
pipeline and which block.

A hash join's build side must complete before a single output row appears; a nested loop
emits immediately. Seeing that difference explains why `LIMIT 10` transforms which plan is
right.

Spills are visible events — when a hash exceeds `work_mem`, the spill happens on screen.

### 5.8 The recovery

The app's thesis resolved, as a before-and-after.

Before: independence assumed, estimate wrong by two orders of magnitude, plan collapsed.
Create the multivariate statistic. After: estimate corrected, plan re-planned, execution
re-run, actual time compared.

Show all three statistic kinds and which repairs which — dependencies for equality
conjunctions, n-distinct for grouping, MCV for the general case — along with what each costs
to store.

## 6. Commitments

### 6.1 The cost model is simplified, and says so

This is a real cost model with real parameters, not a toy. But it is not Postgres. Every
simplification is stated where it affects a number, in the interface, next to the number.

This is the counterpart to the idealised interval in Compression Lab and the lateral rule in
Mixed Traffic Simulator: the app shows a model, names it as a model, and shows where it
diverges from the thing it models.

### 6.2 Estimates and actuals come from one engine

Which makes the comparison exact — and also means real Postgres would give different
numbers. State this once, plainly, where the oracle results are discussed.

### 6.3 Sampling error is shown, not hidden

Statistics come from a real sample. The estimate carries its sampling error and the sample
is inspectable (§5.6).

### 6.4 No verdict

The app does not recommend cost parameters, index designs, or statistics. It shows what each
choice produces.

### 6.5 Nothing leaves the device

No network at runtime. Users will paste their own queries.

## 7. Correctness

### 7.1 The oracle

PGlite — Postgres compiled to WebAssembly — as a `devDependency`, running in Node under
test.

For each of a corpus of schema, data and query combinations:

1. Load identical schema and data into PGlite.
2. Run `ANALYZE`, then `EXPLAIN (FORMAT JSON)`.
3. Assert our planner selects the same **plan shape** — join order and operator choice.
4. Assert our row estimates fall within a stated factor of Postgres's.

Plan shape agreement, not numerical identity. Our cost model is simplified (§6.1) and
demanding identical costs would be demanding we reimplement Postgres.

Where shapes disagree, the case goes into a documented divergence list with an explanation.
That list is a feature — it is a record of exactly which simplifications matter.

### 7.2 Unit-level

- Selectivity estimation against hand-computed histograms and MCV lists.
- Join cardinality against the analytic formula for known distributions.
- Cost formulas against hand calculation for each operator.
- Selinger enumeration: for small n, exhaustive search must produce the same optimum.
- Interesting orders: a case where the merge join plan wins only because a sorted
  intermediate was retained, and is lost if retention is disabled.

### 7.3 Execution

Every plan for a given query must produce identical result sets, regardless of chosen
operators. This is the strongest test in the suite — if a hash join and a merge join
disagree, one executor is wrong.

Deterministic: same data, same seed, same statistics produce the same plan.

## 8. Acceptance criteria

1. Oracle plan-shape agreement across the corpus, with every divergence documented. Runs in
   CI, blocks deploy.
2. All plans for one query return identical result sets (§7.3).
3. Planning an 8-table query completes in under 200 ms so the lattice animates without a
   stall.
4. Dragging any cost parameter re-plans and re-sorts the cost breakdown at 60 fps.
5. A demonstrable case where `random_page_cost` 4.0 → 1.1 flips the winning plan.
6. A demonstrable case where creating a multivariate statistic changes the plan and reduces
   actual execution time.
7. `prefers-reduced-motion` honoured: the lattice fills instantly, the execution timeline
   becomes steppable.
8. Fully keyboard operable, including lattice cell navigation and plan tree traversal.
9. Every instrument has a keyboard-reachable table equivalent; plans exportable as JSON.
10. Zero runtime network requests.
11. Bundle under 350 KB gzipped.
12. Usable at 380 px, with the plan tree legible.
