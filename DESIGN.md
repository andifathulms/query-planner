# DESIGN.md — Query Planner

Visual and motion specification. PRD.md defines substance; this defines form.

---

## 0. The design problem, and the idea that solves it

Every quantity in this app exists twice. What the planner **believed**, and what turned out
to be **true**. Estimated rows and actual rows. Predicted selectivity and measured
selectivity. Estimated cost and elapsed time.

The app's whole subject is the distance between those two numbers. So the design has exactly
one job:

**Make the gap physical.** Never two numbers side by side for the reader to divide. Always a
believed mark, a true mark, and the drawn distance between them — so estimation error is a
length you see before you read anything.

This runs through every instrument. In the plan tree it is a horizontal span at each node,
widening as you go up. In the histogram it is the gap between the predicted bar and the
measured one. In the correlation plot it is the area between the independence rectangle and
the actual point cloud. In the cost breakdown it is the distance a bar travels when it
re-sorts.

Two consequences follow, and they settle the palette and the typography:

**Two colours carry the entire app.** One means believed, one means true. Everything else is
neutral. That is an unusually strict discipline for an app this information-dense, and it is
what keeps a screen full of paired numbers readable.

**The type is deliberately quiet.** This is the densest interface in the family — trees,
lattices, tables, SQL, live counters. The visual interest comes from the paired encoding, not
from the letterforms. A face with personality would compete with several hundred numbers,
and lose the argument. Choosing a neutral superfamily here is a decision, not a default, and
§3 says why.

**What this app is not:** a terminal. The dark-background monospace treatment is the
predictable choice for anything SQL-shaped, and it is wrong here. The work this app asks of a
reader is careful comparison of paired figures across a large tree. That is reading work, and
reading work wants a light ground.

---

## 1. Design plan

**Concept: the schematic.**

A technical drawing on cool drafting stock. Lattice and tree are diagrams with real
structure, drawn in line rather than filled in blocks. Believed values are drawn the way a
proposal is drawn on a plan — outlined, dashed, provisional. Measured values are drawn the
way an as-built is marked up — solid, filled, final.

That distinction is not decorative. It maps exactly onto the app's subject and it means a
reader can tell belief from measurement without a legend, at any zoom, anywhere in the
interface.

**Alignment:** the app is a left-to-right derivation — SQL, then search, then chosen plan,
then execution, then truth. The layout follows that direction and does not fight it.

---

## 2. Colour

### 2.1 Ground

| Token | Value | Use |
|---|---|---|
| `--stock` | `#EDEFF1` | Page. Cool light grey, drafting stock. |
| `--stock-panel` | `#F6F7F8` | Panels, raised from the page rather than recessed. |
| `--stock-deep` | `#E0E3E6` | Recessed areas: unfilled lattice cells, empty buckets. |
| `--ink` | `#15181B` | Primary text and structural line. |
| `--ink-mid` | `#565D64` | Labels, axis text, secondary. |
| `--ink-faint` | `#98A0A7` | Ticks, pruned candidates, disabled. |
| `--rule` | `#CBD0D5` | Hairlines and grid. |

Cool rather than warm, which distinguishes it from Compression Lab's paper at a glance and
suits a schematic rather than a manuscript.

### 2.2 The two colours

| Token | Value | Meaning |
|---|---|---|
| `--believed` | `#4A6FA5` | Estimated, predicted, assumed. Cool blue. |
| `--true` | `#B5622F` | Actual, measured, executed. Warm ochre. |

Reinforced by treatment, not carried by hue alone:

- **Believed** is drawn hollow — outline only, 1.5 px, dashed 4/3.
- **True** is drawn solid — filled, no stroke.

A reader with no colour vision still reads dashed-hollow as proposed and solid-filled as
measured. The pairing works in print, at 3 px, and in a screenshot.

**The gap between them** is filled at 12% opacity in `--believed` when the estimate is low
and in `--true` when the estimate is high. Under-estimates and over-estimates therefore look
different, which matters: an under-estimate is the dangerous one, because it is what makes a
planner choose a nested loop it cannot afford.

### 2.3 Everything else

| Token | Value | Use |
|---|---|---|
| `--winner` | `#15181B` | The chosen plan, in ink. Not a colour — the winner is simply drawn fully. |
| `--pruned` | `#98A0A7` | Candidates that lost. Same shape, drained. |
| `--order` | `#5C7F6B` | Plans retained for an interesting order. The one extra hue in the app. |
| `--warn` | `#C04A2E` | Spills, estimation errors past a threshold, parser errors. |

Operator types are **not** coloured. They are distinguished by their node glyph in the plan
tree (§5.2). Spending hue on nine operators would leave nothing for the distinction the app
is actually about.

---

## 3. Typography

**Geist** and **Geist Mono**. One superfamily.

The reasoning is stated in §0 and worth repeating because it will look like a default and is
not: this interface carries more simultaneous numbers than any other in the family, and the
information design is doing the expressive work. Geist has excellent tabular figures, a wide
weight range, and a mono sibling that sits correctly beside it — which matters when SQL,
plan output and prose share a line.

**Geist Mono** for SQL, plan node text, all numerals, and every table. Postgres terminology
appears in the same shapes a reader sees in psql, which is deliberate — the transfer to real
`EXPLAIN` output is the point.

**Geist** for headings, labels and the small amount of running prose.

No third family.

### 3.1 Scale

Base 14 px — smaller than the other apps, because density is the point here. Ratio 1.25.

| Token | Size / line-height | Face | Use |
|---|---|---|---|
| `--t-display` | 34 / 1.05, 600 | Geist Mono | The error ratio. One instance, and it should be large. |
| `--t-figure` | 22 / 1.1, 600 | Geist Mono | Panel values, chosen plan cost |
| `--t-h2` | 17 / 1.3, 600 | Geist | Panel headings |
| `--t-sql` | 14 / 1.6, 400 | Geist Mono | The query input |
| `--t-body` | 14 / 1.55, 400 | Geist | Explanatory copy. Max 68 characters. |
| `--t-data` | 12.5 / 1.45, 400 | Geist Mono | Plan nodes, tables, axis numbers |
| `--t-small` | 11.5 / 1.35, 400 | Geist | Labels, legend |
| `--t-micro` | 10 / 1.2, 500 | Geist Mono | Lattice cell contents, tick labels |

`font-variant-numeric: tabular-nums` on all Geist Mono. Values update on every frame of a
cost-slider drag and proportional figures would make the whole interface shimmer.

The error ratio at `--t-display` is the app's one piece of typographic drama. A `312×` set
large, in ink, beside a plan tree, is the headline the app has earned.

### 3.2 Prohibitions

No all-caps labels. No tracked-out eyebrows. No coloured words in headings — hue means
believed or true here and nothing else. Sentence case throughout, except SQL keywords and
Postgres operator names, which keep their canonical casing.

---

## 4. Layout

### 4.1 The derivation

```
┌──────────────────────────────────────────────────────────────────────┐
│ Query Planner                        dataset: wilayah · 1.2M rows    │
├───────────────────────┬──────────────────────────────────────────────┤
│ SELECT ...            │  THE LATTICE                                 │
│ FROM kelurahan k      │  L4  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  ← filling              │
│ JOIN kecamatan c ...  │  L3  ▣▣▣▣▣▣▣▣▣▣                              │
│ WHERE k.kota = ...    │  L2  ▣▣▣▣▣▣                                  │
│   AND k.provinsi = .. │  L1  ▣▣▣▣                                    │
│                       │                                              │
│ [ run ]               │  63 subsets · 218 candidates · 4 orders kept │
├───────────────────────┼──────────────────────────────────────────────┤
│ COST BREAKDOWN        │  THE PLAN                                    │
│ ▬▬▬▬▬▬▬▬ hash 412     │   Nested Loop      est ┈┈┈┈┈╱▓▓▓▓▓▓ act      │
│ ▬▬▬▬▬▬ merge 388      │   ├ Index Scan k   est ┈┈╱▓▓ act             │
│ ▬▬▬▬ nestloop 240 ◀   │   └ Seq Scan c     est ┈╱▓ act               │
│                       │                                              │
│                       │                     312×  underestimated     │
├───────────────────────┴──────────────────────────────────────────────┤
│ INSTRUMENT BAY                                                       │
│ [correlation | histogram | sample | timeline | recovery]             │
├──────────────────────────────────────────────────────────────────────┤
│ random_page_cost ●────  4.0   work_mem ●──  4MB   sample ●───  30k   │
└──────────────────────────────────────────────────────────────────────┘
```

Left to right, top to bottom, the layout is the derivation: query, search, candidates,
chosen plan, evidence.

The lattice sits above the plan tree because it produces it. When the lattice's final cell
resolves, its winning plan is what appears below — and the transition between the two is the
first orchestrated moment (§6.3).

### 4.2 The cost parameter bar

Pinned to the bottom, full width. Every cost parameter as a live slider with its default
marked.

These are the app's continuous controls and they drive everything above: re-plan, re-sort the
cost breakdown, re-fill the lattice. The 200 ms planning budget exists for this bar.

`random_page_cost` gets the most width and carries a marker at 1.1 labelled with what it
means, because dragging from 4.0 to 1.1 and watching the plan flip is the single most useful
thing a DBA can learn here.

### 4.3 The instrument bay

Tabbed: correlation, histogram, sample, timeline, recovery. One at a time, full width, on
panel ground.

Recovery is the only tab that changes the state above it, since creating a statistic
re-plans. It is marked distinctly for that reason.

### 4.4 Grid and rhythm

8 px base. Spacing scale: 8 · 12 · 16 · 24 · 40 · 64 — tighter than the other apps, because
density is the design.

Panels are raised from the page by value with a hairline, not by shadow. 2 px radius. The
plan tree and lattice sit directly on panel ground with no inner card.

### 4.5 Mobile

Below 900 px the columns stack in derivation order: SQL, lattice, plan, cost breakdown,
bay. The lattice keeps horizontal scroll per level with the level label pinned left. The plan
tree keeps its estimate/actual spans — they are the point and they compress before anything
else does. The cost bar keeps `random_page_cost` and `work_mem`; the rest moves behind a
sheet.

---

## 5. Instruments

### 5.1 The lattice

Levels stacked bottom to top, level 1 at the bottom. Cells ordered within a level by relation
set, and that order never changes between renders — a cell must not move.

Each cell shows its relation set as initials, its best plan's operator glyph, and its cost.
Cells retained for an interesting order carry a second, smaller mark in `--order`.

Unfilled cells are `--stock-deep`. Filled cells are ink. Candidates that lost are drawn
inside the cell as small drained marks, so the density of losers is visible — level 4 cells
often considered a dozen plans and kept one.

Selecting a cell shows its full candidate list in the cost breakdown, which turns the lattice
into a navigable record of the entire search rather than an animation that plays once.

### 5.2 The plan tree

Reingold–Tilford layout, root at top, drawn in line.

Each node carries: operator name in Postgres's own words, the relation, the estimate/actual
span, and cost. Operators are distinguished by a glyph at the node — a bar for a scan, a
converging pair for a join, a stack for a sort — not by colour.

**The span is the node's most important element.** A log-scaled horizontal axis local to each
node, with the believed mark hollow-dashed and the true mark solid, and the distance between
filled. Leaves are usually tight. The spans widen as you go up, and the widening is the
error compounding.

The root's ratio is printed at `--t-display` beside the tree, with the direction stated —
over- or under-estimated. Under-estimates carry a `--warn` marker, because those are the ones
that produce the nested loop disaster.

Selecting a node opens its selectivity trace: the method used, the inputs, and the
assumptions listed by name.

### 5.3 Correlation

Two predicate columns as a scatter, points at low opacity so density reads.

The independence assumption drawn as a hollow dashed rectangle — the product of two marginal
selectivities, positioned at the predicate values. The actual matching points are drawn
solid.

The area between the rectangle and the cloud is the error, and it is the app's thesis as a
single picture.

The correlation coefficient slider lives here. Sweeping it from 0 to 1 and watching the
rectangle detach from the cloud is a five-second explanation of the whole subject.

When a multivariate statistic exists, a second, solid rectangle appears showing what it
predicts, and it lands on the cloud.

### 5.4 Histogram

One column, fully: MCV entries as labelled bars, the equi-depth histogram as buckets, the
null fraction as a segment.

The active predicate overlays the buckets. Partially covered buckets show their coverage
fraction, and the interpolation arithmetic prints beneath in `--t-data` so it can be checked
by hand.

Predicted selectivity and measured selectivity are shown as a paired span, in the app's
standard encoding.

### 5.5 Cost breakdown

Horizontal stacked bars, one per candidate plan for the selected lattice cell, decomposed
into the terms from `CostBreakdown.terms`. I/O terms are drawn with a fine hatch, CPU terms
solid, so the two kinds are separable without hue.

Sorted by total cost. The winner carries a marker at the left.

Dragging a cost parameter re-sorts the bars live. Bars move rather than redraw, so the moment
one overtakes another is visible — that overtake is the plan flip.

### 5.6 Sample

The table rendered as a dense grid of rows, sampled rows in ink and unsampled rows in
`--ink-faint`. At a million rows this is a texture rather than a table, which is correct — it
shows what fraction the statistics actually saw.

Beside it, the estimate from the sample and the estimate from a full scan, as a paired span.

Shrinking the sample degrades the estimate and eventually flips the plan, and the plan tree
above updates as it happens.

### 5.7 Execution timeline

Horizontal time axis. One track per plan node, positioned by tree depth.

Each track shows its startup period hollow and its output period solid, so pipelining and
blocking are visually distinct: a hash join's build side is a long hollow bar with nothing
emitted, then output begins. A nested loop's output starts almost at zero.

Tuple flow is drawn as marks travelling up between tracks. Spills appear as `--warn` marks
at the moment they occur.

This view is why `LIMIT 10` changes which plan is right, and it should be reachable directly
from a `LIMIT` in the query.

### 5.8 Recovery

Two states, side by side, on the same axes: before the statistic, after it.

For each of the three statistic kinds — dependencies, n-distinct, multivariate MCV — a row
showing what it repairs, what it costs to store, and the resulting estimate.

Creating one is a discrete action that re-plans the query above, re-executes it, and reports
the change in actual time. That whole chain running from one click is the app's payoff.

---

## 6. Motion

### 6.1 The rule

Settled across five apps now:

**Continuous control → direct mapping, zero easing.** Cost parameters, sample size,
correlation coefficient. Re-plan and re-render on the frame.

**Discrete control → timed transition.** Query change, dataset change, creating or dropping a
statistic, lattice cell selection.

### 6.2 Durations

| Event | Duration | Curve |
|---|---|---|
| Lattice fill, per level | 380 ms, cells staggered 12 ms | `cubic-bezier(.32,.72,0,1)` |
| Winning plan descending into the tree | 500 ms | `cubic-bezier(.32,.72,0,1)` |
| Cost bar re-sort | 300 ms | `cubic-bezier(.32,.72,0,1)` |
| Estimate/actual span redraw | 320 ms | `cubic-bezier(.4,0,.2,1)` |
| Recovery before → after | 700 ms, staged | `cubic-bezier(.32,.72,0,1)` |
| Execution timeline playback | real elapsed time, scaled | linear |
| Instrument tab | 220 ms | `cubic-bezier(.4,0,.2,1)` |
| Selectivity trace popover | 140 ms | `cubic-bezier(.4,0,.2,1)` |

### 6.3 First orchestrated moment: the lattice fills

Run a six-table query. Level 1 resolves almost instantly — four or six single-table access
paths, each picking index or sequential scan. Level 2 fills across, each pair built from
level-1 winners, candidates appearing and all but one draining to `--pruned`. Level 3, wider.
Level 4, wider still. Then the levels narrow again toward a single cell at the top.

When that final cell resolves, its plan **descends into the tree below** — the winning node
structure translating down out of the lattice and settling into the plan tree's layout over
500 ms.

That descent is what makes the two views one thing. Without it the lattice is a pretty chart
beside a plan; with it, the lattice visibly *produces* the plan.

Requirements: the fill must replay the real search order recorded by the enumerator, not an
idealised sweep. Cells that considered many candidates must visibly consider many. Play,
pause, step by level, and step by cell.

No caption, no arrow. The descent carries it.

### 6.4 Second orchestrated moment: the recovery

The app's argument resolving.

State one: independence assumed. The correlation plot's dashed rectangle floats away from
the cloud. The plan tree's spans are wide and the root reads `312×`, underestimated. The
plan is a nested loop.

The user creates the multivariate statistic. Then, in sequence over 700 ms:

1. The correlation plot's second rectangle appears and lands on the cloud.
2. The plan tree's spans contract — leaves first, then upward, the compounding running in
   reverse.
3. The root ratio counts down from 312× toward 1×.
4. The lattice re-fills and a different cell wins.
5. The new plan descends.
6. Actual execution time appears beside the old one.

Staged, in that order, because the causal chain is the lesson. Do not run them
simultaneously.

### 6.5 The plan flip

Not a moment — an interaction, and it should feel like one. Dragging `random_page_cost` past
the threshold, the cost bars cross, the winner marker moves, and the plan tree rebuilds. All
of it tracks the pointer directly with no easing, so the flip happens exactly where the user
put it.

Finding that threshold by feel is the point. Do not snap, do not animate the crossing, do not
announce it.

### 6.6 Restraint

No panel entrance animations. No hover transitions on lattice cells. No pulsing. The lattice
fill and the recovery are the budget.

### 6.7 Reduced motion

`prefers-reduced-motion: reduce`: the lattice fills instantly and completely, with a
level-by-level stepper available. The plan descent becomes an instant state change. The
recovery becomes a before/after toggle with no staging. The execution timeline renders
complete rather than playing. Spans redraw instantly.

Every number and every view stays reachable.

---

## 7. Copy

English, sentence case, no exclamation marks.

Postgres terminology exactly as Postgres writes it. This is not pedantry — the app's value
depends on a reader mapping what they see here onto real `EXPLAIN` output.

Every estimate states its method and assumptions from the selectivity trace: *"estimated 12
rows — independence assumed between kota and provinsi"*, never a bare number.

Simplification statements (PRD §6.1) sit next to the numbers they affect. The oracle
divergence list is reachable from the same place, because a documented list of where this
model differs from Postgres is more credible than a claim that it does not.

Errors from the parser name the limitation: *"Window functions are not supported"*, not
*"syntax error near OVER"*.

Empty state: the SQL input focused, a dataset already loaded, and one example query
pre-filled — the correlated-predicate one, because it produces the app's best result on first
run.

---

## 8. Quality floor

Assumed, not announced: usable at 380 px with the plan tree legible; visible keyboard focus
everywhere including lattice cells and plan nodes; every instrument has a keyboard-reachable
table equivalent; plans exportable as JSON; contrast 4.5:1 for text and 3:1 for graphical
objects; reduced motion honoured; no network at runtime.

## 9. Relationship to the house layer

Takes: the spacing scale, the motion curve family, the citation-popover pattern, the type
floor, the continuous-versus-discrete motion rule, the constant-anchor layout.

Contributes back:

**The paired encoding.** Believed versus true as hollow-dashed versus solid-filled, with the
gap drawn. This generalises to any app comparing a prediction against an outcome, and it is
better than the two-numbers-side-by-side treatment those apps usually get.

**A derivation that visibly produces its result.** The lattice descending into the plan tree
is the same instinct as the shared axis in Mixed Traffic Simulator — two views made into one
object by motion rather than by a label.

Departs in one place: this is the densest interface in the family and the only one using a
deliberately neutral typeface. The reason is in §0. Document it, so quiet type does not
become a house default in apps that could carry more.
