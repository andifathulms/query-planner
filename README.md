# Query planner

Why your SQL is slow, and what the database believed when it chose.

A static single-page application containing its own database engine: storage, a
B+tree index, statistics collection from a real sample, selectivity estimation,
a cost model, Selinger plan enumeration, and a volcano-model executor. No SQL
library ships in the bundle. There is no network at runtime.

`PRD.md` is what and why. `DESIGN.md` is how it looks. `CLAUDE.md` is the build
brief.

## Why an engine rather than a wrapper

`EXPLAIN` shows you the winner. It does not show the sixty-two candidate plans
that lost, and that search is the most visual thing in the subject. The app's
central claim also needs the estimate and the truth side by side at every node,
from one system — and only an engine you control produces both.

## Running it

```
npm install
npm run dev        # the app
npm test           # 244 tests
npm run oracle     # plan-shape agreement against PGlite
npm run build      # production bundle
```

`@electric-sql/pglite` is a devDependency and is never shipped. It is the
oracle: identical data goes into real Postgres, and the test asserts this
planner picks the same plan shape.

## Layout

```
src/
  parser/     recursive descent over the accepted SQL subset
  storage/    columnar tables, a bulk-loaded B+tree, the generators
  stats/      reservoir sampling, MCV, histograms, multivariate statistics
  planner/    selectivity, cost, access paths, interesting orders, the DP
  executor/   volcano operators, one per file, with instrumentation
  views/      the eight instruments
  state/      the store, URL serialisation, and measurement of the truth
```

Three boundaries are enforced rather than intended:

- `src/planner/` may not import `src/storage/` or `src/executor/`. A planner
  that can peek at the truth is not a planner. The rule is in `eslint.config.js`.
- No engine module imports React, the DOM, or `Math.random`. All randomness
  runs through the seeded PRNG, so a seed reproduces a plan exactly.
- Statistics come from a sample, always. Sampling error is part of the subject.

## What is not modelled

The cost model is real, with real parameters, and it is not Postgres. Every
simplification is listed in `SIMPLIFICATIONS` (`src/planner/cost.ts`) and shown
in the interface next to the number it affects. The cases where a simplification
actually changed a decision are in `src/planner/divergences.ts`, found by the
oracle and asserted still to diverge. Bitmap heap scans are the largest gap.

Estimates and actuals come from one engine, which makes their pairing exact and
also means real Postgres would give different numbers.

## State

Everything except the current selection serialises to the URL. A surprising plan
is a link.

The theme is the one exception, and it is deliberate: it lives in
`localStorage`, not in the URL. A shared link carries a plan, and forcing a
colleague into your colour scheme to show them a plan would be rude. The control
cycles system, light, dark; "system" means no `data-theme` attribute at all, so
`prefers-color-scheme` decides.
