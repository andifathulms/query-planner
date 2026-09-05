# Portfolio context — Query Planner

Raw material for a client-facing case study. Everything below is checked against the
codebase, `package.json`, the test run, and `git log`, not against the PRD's intentions.

Repo: `andifathulms/query-planner` · Live: https://andifathulms.github.io/query-planner/

---

## 1. One-line summary

A web app that opens up the hidden decision every database makes before it runs your query —
showing all the ways it *could* have answered, why it picked the one it did, and where its
guess about your data turned out to be wrong.

## 2. The problem

When a SQL query is slow, the usual answer is "add an index" — and often that is not the
problem at all. A database picks how to run a query by *estimating* how many rows each step
will produce, using a small statistical summary of the table. When those estimates are wrong,
it confidently picks a plan that is catastrophically slow. Nothing is broken and no index is
missing; the plan was chosen correctly from a false belief.

The specific failure the app is built around is the **independence assumption**: asked for
`city = 'Balikpapan' AND province = 'Kalimantan Timur'`, the database multiplies the two
odds as if knowing the city told you nothing about the province. It predicts one row in ten
thousand; the truth is one in a hundred. Two orders of magnitude of error, from an assumption
nobody chose.

Standard tooling cannot show this. `EXPLAIN` shows you the winning plan and nothing else — not
the dozens of candidates that lost, and not the gap between what the planner believed and what
actually happened.

**Who it's for:** backend and data engineers, DBAs, and anyone teaching or learning query
optimisation — the audience that already reads `EXPLAIN` output and wants to understand what
produced it. Terminology matches Postgres exactly (`Seq Scan`, `Hash Join`, `rows`, `width`,
`cost`) so what they see here transfers directly to real `EXPLAIN` output.

## 3. My role

Sole author. 36 commits, all by one person; no forked code, no inherited codebase, no
starter template beyond `npm create vite`.

**Built from scratch (~13,500 lines of TypeScript, React and CSS):**

- A SQL lexer, recursive-descent parser and AST for a deliberately narrow subset
- Columnar table storage and a bulk-loaded B+tree index with range and equality lookup
- Synthetic data generators with controllable correlation and Zipf skew, plus a realistic
  Indonesian administrative dataset with genuine functional dependencies
- Reservoir sampling, equi-depth histograms, MCV lists, per-column statistics, and all three
  kinds of multivariate statistics (functional dependencies, n-distinct, multivariate MCV)
- Selectivity estimation following the Postgres model, every computation returning its trace
- A cost model in `(startup, total)` pairs with a full term-by-term decomposition
- Selinger dynamic-programming plan enumeration with interesting-order retention, keeping
  every losing candidate for visualisation
- A volcano-model executor — seq scan, index scan, nested loop, hash join, merge join, sort,
  hash and group aggregate, limit — with per-node instrumentation
- Eight custom SVG visualisations, hand-written layout (including a Reingold–Tilford tidy
  tree), a hand-rolled rAF animation loop, a two-theme design token system, and the app shell
- 294 tests, plus the CI pipeline

**Used as-is:** React 18 and Vite as the shell, TypeScript, Vitest as the test runner, the
Geist typeface, and PGlite — Postgres compiled to WebAssembly — purely as a test-time oracle.

No SQL library, charting library, graph-layout library, animation library or state-management
library was used. Those are the things that would normally be imported, and each one was
written instead.

## 4. Technical approach

**The app contains a whole database engine, in the browser.** This is the central decision and
everything else follows from it. Wrapping an existing engine like SQLite-in-WASM would have
been far less work, but it cannot do the two things the app exists for: show the losing
candidate plans (`EXPLAIN` throws them away), and put the estimate and the truth side by side
at every node from one system. Only an engine you control produces both.

**The planner is architecturally forbidden from seeing the data.** `src/planner/` may not
import `src/storage/` or `src/executor/` — enforced by an ESLint rule in
[eslint.config.js](eslint.config.js), not by convention. It reads statistics objects and
nothing else. A planner that can peek at the truth is not a planner, and the whole
demonstration would be a lie if this leaked.

**Every estimate carries its own explanation.** A selectivity calculation returns not just a
number but a `SelectivityTrace` — the method used (`mcv`, `histogram`, `independence`,
`dependency`, …), the inputs, and the assumptions made. The histogram and correlation views
*render that trace* rather than recomputing anything. The display and the computation are one
object, so the interface cannot drift out of sync with the maths.

**Statistics always come from a sample, never a full scan.** Sampling is real reservoir
sampling with a seeded PRNG, default 30,000 rows, with the sample size as a user control.
Faking it with a full-table scan would have been easier and would have removed a genuine
source of estimation error that is part of the subject.

**Cost is a `(startup, total)` pair, not a single number.** A scalar cost model cannot express
why `LIMIT 10` wants a different plan than the same query without the limit. Keeping the pair
preserves one of the app's better demonstrations.

**The DP keeps its garbage.** Selinger enumeration normally discards losing candidates the
moment a cheaper one appears. Here every candidate is retained in its cell, along with the
exact fill order of the search. For 8 tables that is 255 cells and trivial memory — and it is
the only reason the lattice animation can replay the real search rather than a re-enactment.

**Everything is deterministic and shareable.** No `Math.random` anywhere in the engine (also
lint-enforced); all randomness runs through a seeded PRNG. The entire app state except the
current selection serialises to the URL, so a surprising plan is a link someone can send.

**Correctness is proven two ways.** Real Postgres (via PGlite) is the oracle: identical data
goes into both, and 33 tests assert this planner picks the same *plan shape*. Separately, an
equivalence test asserts that every possible plan for a query returns identical results —
which is what actually catches executor bugs.

## 5. Actual tech stack

Verified against [package.json](package.json).

**Shipped runtime dependencies — three:**
- React 18.3 + React DOM
- `geist` (typeface; the six woff2 files are self-hosted and bundled)

**Build and dev:**
- TypeScript 5.7 (strict), Vite 6, `@vitejs/plugin-react`
- ESLint 9 + typescript-eslint, with custom `no-restricted-imports` /
  `no-restricted-globals` / `no-restricted-properties` rules encoding the architecture
- Vitest 2, jsdom, Testing Library (DOM + React)
- `@electric-sql/pglite` 0.2 — devDependency only, never shipped
- GitHub Actions → GitHub Pages

**Deliberately absent:** any SQL engine or parser generator in the bundle, D3 or any charting
library, any graph-layout library, any animation library, any CSS framework, any state
library. Styling is plain CSS with custom properties; all visualisation is hand-written SVG.

## 6. Notable features

- **The lattice** — Selinger's dynamic-programming table animated as it actually fills, level
  by level, every candidate plan visible including the losers. Watching it is watching the
  search that runs inside every database on earth. Nothing else visualises this.
- **Live plan flipping** — drag `random_page_cost` from 4.0 toward 1.1 (the standard SSD
  adjustment every DBA makes) and the cost bars re-sort and cross, and the winning plan
  rebuilds, tracking the pointer with no easing. A four-table join re-plans and re-executes in
  under 16 ms, so the threshold is exactly where you put it — pinned by a performance test.
- **Estimate vs. truth at every node** — the plan tree pairs the planner's guess with the real
  count at each operator, and draws the error as a widening gap up the tree: 1.2× at a scan
  becomes 8× after one join and 300× at the root.
- **The correlation plot** — the independence assumption drawn as an *area*. The rectangle
  independence implies sits detached from the actual point cloud; the gap between them is the
  estimation error, visible before you read a number.
- **The recovery** — create a multivariate statistic in one click and watch the estimate move
  onto the truth, the plan re-plan, and the query re-execute, with actual times compared.
  All three statistic kinds are offered, with what each repairs and what it costs to store.
- **An honest divergence list** — [src/planner/divergences.ts](src/planner/divergences.ts)
  documents every query where this planner disagrees with real Postgres and why (all four are
  the missing bitmap-heap-scan layer). The oracle test asserts each one *still* diverges, so
  the list cannot quietly go stale.
- **Shareable, offline, private** — zero network requests at runtime; the state serialises to
  the URL. Users can paste their own queries and nothing leaves the device.

## 7. Challenges and tradeoffs

**Two hard architectural boundaries, both machine-enforced.** The planner-cannot-see-storage
rule and the engine-is-pure rule are ESLint config, not documentation. This is the kind of
constraint that is easy to state and easy to violate under deadline pressure; making CI fail
on it was cheaper than discipline.

**The realistic dataset had to be re-ordered to keep the demonstration honest.** The city list
in [src/storage/datasets/wilayah.ts](src/storage/datasets/wilayah.ts) was originally grouped by
province. Because the Zipf sampler draws by list position, that made a province's cities all
land at adjacent frequency ranks — which made both marginal selectivities large together and
collapsed the independence error from about 30× down to 3×. Re-ordering the list by population
(also the more realistic arrangement) decoupled frequency from province and restored the
effect. A data-generation detail that quietly destroyed the app's entire thesis.

**Divergence from Postgres was documented rather than hidden.** The oracle found cases where
this planner picks a sequential scan and Postgres picks a bitmap heap scan. Rather than tuning
the cost model until the tests passed, the bitmap layer was declared out of scope and each
disagreement written up with its cause and surfaced *in the interface*, next to the numbers it
affects. Commit `5ba8322` is literally titled "the PGlite oracle, and what it caught".

**Interesting orders were non-optional.** Retaining plans that are only cheapest *for a
useful sort order* is the part of Selinger most explanations omit — and without it merge join
can never win, so the app would have quietly taught something false.
[tests/orders.test.ts](tests/orders.test.ts) covers a case that inverts when retention is
disabled.

**Instrumentation had to not distort the measurement.** Calling a clock per row would have
made the timing numbers meaningless. Timing is sampled against a coarse counter instead.

**A visible mid-project design pivot.** The build followed a strict engine-first order — no UI
work started until the executor passed its equivalence gate at step 6. Then commit `a073496`,
"DESIGN.md revision 2: state what the first pass got wrong, and the fix", opens an eight-commit
stretch that rebuilt the entire token layer with semantic names and two themes, reworked the
shell, migrated every input onto a shared control vocabulary, and fixed eleven issues found by
reading the app's own screenshots. The visual system was rebuilt once, deliberately, after the
first pass was judged wrong.

**Copy rules enforced by test.** [tests/copy.test.ts](tests/copy.test.ts) asserts no em-dashes
in shipped strings, no marketing filler, and no two headings naming different things — rules a
person cannot reliably hold in their head across 3,000 lines of interface.

**Theme is the one thing kept out of the URL.** A shared link carries a plan; forcing a
colleague into your colour scheme in order to show them a plan would be rude.

## 8. Status

- **Live and deployed** at https://andifathulms.github.io/query-planner/ (returns 200).
- **Public repository** at https://github.com/andifathulms/query-planner (returns 200).
- Deployed via GitHub Actions on push to `main`. The pipeline is
  typecheck → lint → test → oracle → build → deploy, and deploy only runs on green.
- Complete against its own acceptance criteria — all 15 build steps in the brief are shipped,
  including reduced motion, keyboard operation, table equivalents for every instrument, JSON
  export and mobile layout. It is a finished demonstration app rather than a prototype; it is
  not a production service (there is no backend to run).

## 9. Metrics

| | |
|---|---|
| Commits | 36, single author |
| Time span | 2026-09-03 00:37 → 2026-09-03 17:15 — a single ~16.5-hour session |
| Source | ~13,565 lines across `src/` (TypeScript, TSX, CSS) |
| Tests | **294 passing** — 261 unit/integration + 33 oracle, 13 test files, ~3,185 lines |
| Bundle | 316 KB raw JS → **98 KB gzipped**, plus 6.5 KB gzipped CSS (budget was 350 KB) |
| Runtime network requests | 0 |
| Engine breakdown | planner 2,845 lines · executor 1,703 · stats 754 · storage 719 · parser 619 |
| Interface breakdown | views 3,109 lines · ui 1,883 · state 824 · styles 524 |
| Physical operators | 9 (seq scan, index scan, nested loop, hash join, merge join, sort, hash aggregate, group aggregate, limit) |
| Instruments | 8 distinct visualisations |
| Plan search space | up to 8 tables = 255 DP cells, all candidates retained |
| Planning performance | four-table join re-plans and re-executes in under 16 ms (one 60 fps frame), asserted in CI |
| Datasets | 2 — a controllable synthetic generator and a realistic Indonesian administrative schema |

## 10. Suggested screenshots

1. **The lattice, mid-fill** — the hero shot. The DP table part-way through filling, with
   resolved cells, greyed-out losing candidates, and the level labels. Ideally captured as the
   final cell resolves and its plan descends into the tree below.
   → [src/views/Lattice/Lattice.tsx](src/views/Lattice/Lattice.tsx),
   [src/views/Lattice/Lattice.css](src/views/Lattice/Lattice.css)

2. **The correlation plot with the independence rectangle detached from the point cloud** —
   the single clearest image of the app's thesis. The wrong belief drawn as an area beside the
   truth. Pair it with an "after" capture once a multivariate statistic exists and the
   rectangle snaps onto the cloud.
   → [src/views/Correlation/Correlation.tsx](src/views/Correlation/Correlation.tsx)

3. **The plan tree with estimate/actual pairs** — showing the error ratio widening up the tree
   from a scan to the root, with a node selected so its selectivity trace and assumptions are
   visible in the detail panel.
   → [src/views/PlanTree/PlanTree.tsx](src/views/PlanTree/PlanTree.tsx),
   [src/views/PlanTree/layout.ts](src/views/PlanTree/layout.ts),
   [src/ui/PlanDetail.tsx](src/ui/PlanDetail.tsx),
   [src/ui/TraceDetail.tsx](src/ui/TraceDetail.tsx)

4. **The cost breakdown mid-drag** — the stacked candidate bars decomposed into startup, I/O
   and CPU terms, captured at the moment `random_page_cost` crosses the threshold and a
   different plan reaches the top. Best shown as a before/after pair at 4.0 and 1.1.
   → [src/views/CostBreakdown/CostBreakdown.tsx](src/views/CostBreakdown/CostBreakdown.tsx),
   [src/ui/CostBar.tsx](src/ui/CostBar.tsx),
   [src/ui/DatasetControls.tsx](src/ui/DatasetControls.tsx)

5. **The recovery, as a before-and-after** *(optional fifth, if the case study has room)* —
   the app's argument resolved in one frame: estimate wrong by orders of magnitude, one click,
   estimate corrected and plan rebuilt, with storage cost stated.
   → [src/views/Recovery/Recovery.tsx](src/views/Recovery/Recovery.tsx)

Capture in both themes if the case study has the space — the two-theme token system is real
work and the dark theme has its own contract, pinned by
[tests/theme.test.tsx](tests/theme.test.tsx).
