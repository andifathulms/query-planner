# DESIGN.md — Query Planner

Visual and motion specification. PRD.md defines substance; this defines form.

**Revision 2.** The first revision established the idea that carries this app — belief drawn
against truth — and then dressed it in a single flat light theme where every panel had the
same weight as every other. The idea survives revision 2 intact. What changes is everything
around it: a ground that actually has depth, two themes rather than one, a type scale with
fewer and more distinct steps, one control vocabulary instead of six ad-hoc ones, and a
layout that puts the hero where the eye lands instead of in a 340 px column beside it.

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

### 0.1 What revision 1 got wrong

Worth stating plainly, because each fault has a fix in the sections below and the faults are
the reason for the revision.

1. **The ground had no depth.** Page `#EDEFF1` under panel `#F6F7F8` is a 2% step. Panels
   were declared raised and did not read raised, so the screen was one undifferentiated
   field of hairline boxes. §2.1 replaces the two-value ground with a four-step ramp and a
   real, if very quiet, elevation.
2. **Every panel had the same weight.** The lattice is the hero and it sat in the same box
   as the result grid, at the same heading size, with the same border. §4 gives the
   derivation a spine and lets the hero be a hero.
3. **One theme.** A tool a DBA keeps open beside a terminal needs a dark theme, and "this app
   is not a terminal" (an argument about *treatment*) was allowed to become an argument
   against *ever being dark*. It is not the same claim. §2.4 settles it: two themes, both
   light-ground in their reading behaviour, the dark one a dim instrument panel rather than a
   black terminal.
4. **Four small type sizes doing one job.** 14 / 12.5 / 11.5 / 10 is a scale with no steps
   in it. §3.1 cuts to a scale where each step is visibly a step.
5. **Six copies of the same button.** `padding: 1px var(--s1); border: 1px solid var(--rule)`
   appears, slightly differently, in six stylesheets. §4.6 makes one control vocabulary.
6. **No horizon.** `align-content: start` with no max width meant the interface hugged the
   top-left of a wide display and stretched illegibly on an ultrawide. §4.2 gives it a
   measure.

---

## 1. Design plan

**Concept: the instrument panel.**

Revision 1 called it a schematic — a technical drawing on drafting stock. That was right
about the *marks* and wrong about the *housing*. A schematic is a static document; this is a
live instrument that re-derives itself on every frame of a slider drag. So: schematic marks,
instrument housing.

What that means concretely:

- **Marks stay drawn, not filled.** Lattice, tree, histogram, timeline and correlation are
  line drawings with real structure. Believed values are drawn the way a proposal is drawn on
  a plan — outlined, dashed, provisional. Measured values are drawn the way an as-built is
  marked up — solid, filled, final. This is unchanged and it is the part worth keeping.
- **The housing has depth and hierarchy.** Panels sit on a ground, at three levels: the page,
  the panel, and the sunken canvas a diagram is drawn into. A reader should be able to see
  the structure of the screen with their eyes out of focus.
- **Readouts look like readouts.** Numbers that change on every frame sit in mono, tabular,
  on a sunken field, with their unit and their label attached. They are not prose.

**Alignment:** the app is a left-to-right derivation — SQL, then search, then chosen plan,
then execution, then truth. The layout follows that direction and does not fight it.

---

## 2. Colour

The palette is defined **semantically** and instantiated twice, once per theme. No component
stylesheet names a hex value or a theme; every rule reads a semantic token, so the dark
theme is a token file and not a second set of components.

### 2.1 Ground

A four-step ramp, plus text and line. The step between page and panel is now visible — around
5–7% of luminance rather than 2% — and the direction is deliberate: **panels are lighter than
the page in the light theme and lighter than the page in the dark theme too.** Raised is
always lighter. Sunken is always darker. That rule holds in both themes so the reader learns
depth once.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#E7EAEE` | `#101317` | The page. Everything sits on it. |
| `--surface` | `#F7F8FA` | `#191D22` | Panels. Raised from the page. |
| `--surface-raised` | `#FFFFFF` | `#20252B` | Popovers, the selected row, the active tab. |
| `--surface-sunken` | `#DDE1E6` | `#0B0E11` | Canvases a diagram is drawn into; input fields; unfilled lattice cells. |
| `--ink` | `#12161A` | `#EDF0F3` | Primary text and structural line. |
| `--ink-mid` | `#5A626B` | `#9AA4AE` | Labels, axis text, secondary. |
| `--ink-faint` | `#8B949D` | `#69737D` | Ticks, pruned candidates, disabled. |
| `--line` | `#C9CFD6` | `#2C333A` | Hairlines and grid. |
| `--line-strong` | `#A8B1BA` | `#3D454E` | Panel borders, the edge of a focused control. |

Cool rather than warm in both themes. The light theme reads as coated stock under even light;
the dark theme reads as a dimmed instrument panel, not as a terminal — it is a desaturated
blue-grey at `#101317`, never pure black, and its text is `#EDF0F3`, never pure white. Pure
black on pure white is the halation that makes dark interfaces tiring, and this one is meant
to be read for an hour.

### 2.2 The two colours

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--believed` | `#3B6FB6` | `#7AA5E8` | Estimated, predicted, assumed. Cool blue. |
| `--true` | `#B45C22` | `#E8974A` | Actual, measured, executed. Warm amber. |

Re-tuned from revision 1, where `#4A6FA5` and `#B5622F` were muddy enough that at 1.5 px
stroke weight on a light-grey field they read as two greys. Both are lifted in chroma and
separated further in hue; both clear 4.5:1 against their own theme's `--surface` for text and
3:1 for graphical objects, in both themes. The dark-theme values are lighter rather than the
same colours on a dark ground, because a mid-tone stroke on `#191D22` disappears.

Reinforced by treatment, not carried by hue alone:

- **Believed** is drawn hollow — outline only, 1.5 px, dashed 4/3.
- **True** is drawn solid — filled, no stroke.

A reader with no colour vision still reads dashed-hollow as proposed and solid-filled as
measured. The pairing works in print, at 3 px, in either theme, and in a screenshot.

**The gap between them** is filled at 14% opacity in `--believed` when the estimate is low
and in `--true` when the estimate is high. Under-estimates and over-estimates therefore look
different, which matters: an under-estimate is the dangerous one, because it is what makes a
planner choose a nested loop it cannot afford.

### 2.3 Everything else

| Token | Light | Dark | Use |
|---|---|---|---|
| `--winner` | `#12161A` | `#EDF0F3` | The chosen plan, in ink. Not a colour — the winner is drawn fully. |
| `--pruned` | `#8B949D` | `#69737D` | Candidates that lost. Same shape, drained. |
| `--order` | `#3F7D63` | `#5FBE92` | Plans retained for an interesting order. The one extra hue. |
| `--warn` | `#C0432A` | `#F0785A` | Spills, estimation errors past a threshold, parser errors. |
| `--focus` | `#3B6FB6` | `#7AA5E8` | The focus ring. Tracks `--believed` deliberately: focus is a proposal too. |

Operator types are **not** coloured. They are distinguished by their node glyph in the plan
tree (§5.2). Spending hue on nine operators would leave nothing for the distinction the app
is actually about.

**Total hue budget: four.** Believed, true, order, warn. Anything else that needs to be
distinguished is distinguished by value, by fill treatment, or by hatch.

### 2.4 Themes

Three states, as the platform actually models them:

- No preference expressed → follow `prefers-color-scheme`.
- `data-theme="light"` on the root → light, regardless of the system.
- `data-theme="dark"` on the root → dark, regardless of the system.

The toggle in the header cycles system → light → dark and persists to `localStorage`. It is
not in the URL: a shared link carries a *plan*, and forcing a colleague into your theme to
show them a plan would be rude. Theme is a property of the reader, not of the finding.

Every token is defined on bare `:root` (light), redefined under
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme='light'])`, and
redefined again under `:root[data-theme='dark']` so the explicit choice wins in both
directions. `color-scheme` is set alongside, so form controls, scrollbars and the range
thumbs follow without being restyled by hand.

### 2.5 Elevation

Shadows are near-invisible and they are still doing work: they stop a hairline box from
looking like a table cell. Two steps only.

| Token | Light | Dark |
|---|---|---|
| `--shadow-panel` | `0 1px 2px rgb(18 22 26 / .04), 0 1px 1px rgb(18 22 26 / .03)` | `0 1px 2px rgb(0 0 0 / .4)` |
| `--shadow-raised` | `0 4px 12px rgb(18 22 26 / .08), 0 1px 3px rgb(18 22 26 / .06)` | `0 6px 20px rgb(0 0 0 / .5)` |

`--shadow-raised` is for popovers and the sticky cost bar only. Nothing on the page hovers.

---

## 3. Typography

**Geist** and **Geist Mono**. One superfamily, self-hosted, subset to Latin.

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

Base 14 px. Revision 1 had eight steps of which four were crowded into 10–14 px and were not
distinguishable in use. Revision 2 has seven, and each is a step you can see.

| Token | Size / line-height / weight | Face | Use |
|---|---|---|---|
| `--t-display` | 40 / 1.0 / 600 | Geist Mono | The error ratio. One instance, and it should be large. |
| `--t-figure` | 24 / 1.1 / 600 | Geist Mono | Panel values, chosen plan cost, verdict numbers. |
| `--t-h2` | 15 / 1.3 / 600 | Geist | Panel headings. |
| `--t-body` | 14 / 1.55 / 400 | Geist | SQL input and explanatory copy. Max 68 characters. |
| `--t-data` | 12.5 / 1.45 / 400 | Geist Mono | Plan nodes, tables, axis numbers. |
| `--t-label` | 11.5 / 1.35 / 500 | Geist | Control labels, legends, tab labels. |
| `--t-micro` | 10 / 1.2 / 500 | Geist Mono | Lattice cell contents, tick labels. |

Two changes worth naming. The panel heading drops from 17 px to 15 px and gains its weight
from being the only 600-weight sans on the panel, not from size — seventeen panels at 17 px
is a lot of shouting. The display figure rises from 34 px to 40 px, because it is the one
number the app has earned the right to set large and it was competing with the panel headings
rather than dominating them.

`font-variant-numeric: tabular-nums` on all Geist Mono. Values update on every frame of a
cost-slider drag and proportional figures would make the whole interface shimmer.

The error ratio at `--t-display` is the app's one piece of typographic drama. A `312×` set
large, in ink, beside a plan tree, is the headline the app has earned.

### 3.2 The eyebrow

Revision 1 banned all-caps labels outright. Revision 2 keeps that ban for anything a reader
*reads*, and makes one exception for a thing a reader *finds*: the panel eyebrow.

Panels carry a small caps-and-tracked kicker above their heading: `SEARCH`, `PLAN`,
`EVIDENCE`, at 10 px, 500 weight, `0.08em` tracking, in `--ink-faint`. It is a landmark, not
a label: at a glance it tells you which stage of the derivation you are looking at, and it is
short enough that all-caps costs no legibility. Nothing longer than one word ever gets this
treatment.

**Every panel gets one, and that is the point.** On a marketing page an eyebrow above every
section is decorative rhythm and should be rationed. Here the seven eyebrows are the seven
stages of the derivation, in order: QUERY, SEARCH, PLAN, COST, EVIDENCE, RESULT, PARAMETERS.
Removing five of them would not reduce clutter, it would delete the pipeline's table of
contents from a screen carrying several hundred numbers. The rule that follows from this is
about collision rather than count: no two eyebrows may name different things.

### 3.3 Prohibitions

No tracked-out eyebrows longer than a word. No coloured words in headings — hue means
believed or true here and nothing else. Sentence case throughout, except SQL keywords,
Postgres operator names, and the §3.2 eyebrows.

---

## 4. Layout

### 4.1 The derivation

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▨ Query planner   ·  what the database believed      wilayah 1.2M   ☾  ⋯  │
├──────────────────────────┬─────────────────────────────────────────────────┤
│ QUERY                    │  SEARCH                       planned in 4.1 ms │
│ ┌──────────────────────┐ │  ┌────────────────────────────────────────────┐ │
│ │ SELECT ...           │ │  │ L4  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  ← filling             │ │
│ │ FROM kelurahan k     │ │  │ L3  ▣▣▣▣▣▣▣▣▣▣                             │ │
│ │ JOIN kecamatan c ... │ │  │ L2  ▣▣▣▣▣▣                                 │ │
│ │ WHERE k.kota = ...   │ │  │ L1  ▣▣▣▣                                   │ │
│ └──────────────────────┘ │  └────────────────────────────────────────────┘ │
│ examples ▾   generator ▾ │  63 subsets · 218 candidates · 4 orders kept    │
│                          ├─────────────────────────────────────────────────┤
│ COST                     │  PLAN                                           │
│ ▬▬▬▬▬▬▬▬ hash 412        │   Nested Loop      est ┈┈┈┈┈╱▓▓▓▓▓▓ act         │
│ ▬▬▬▬▬▬ merge 388         │   ├ Index Scan k   est ┈┈╱▓▓ act                │
│ ▬▬▬▬ nestloop 240 ◀      │   └ Seq Scan c     est ┈╱▓ act                  │
│                          │                                                 │
│                          │   ┌─ 312× ─────────────────────────────────┐    │
│                          │   │ underestimated · independence assumed  │    │
│                          │   └────────────────────────────────────────┘    │
├──────────────────────────┴─────────────────────────────────────────────────┤
│ EVIDENCE  [correlation | histogram | sample | timeline | recovery •]        │
├────────────────────────────────────────────────────────────────────────────┤
│ RESULT    1,204 rows · 82 ms                                    export ⤓   │
├────────────────────────────────────────────────────────────────────────────┤
│ random_page_cost ●────  4.0   work_mem ●──  4MB   …            reset (2)   │
└────────────────────────────────────────────────────────────────────────────┘
```

Left to right, top to bottom, the layout is the derivation: query, search, candidates,
chosen plan, evidence, result.

Two changes from revision 1. The lattice moves out of the narrow right column into the wide
one and gets the top of the fold to itself — it is the hero and it was being treated as a
sibling. And the root error ratio is promoted out of a margin note into a **verdict block**
beneath the tree: the number at `--t-display`, the direction stated in words, and the
assumption that produced it named. That is the app's finding, and a finding gets a frame.

The lattice sits above the plan tree because it produces it. When the lattice's final cell
resolves, its winning plan is what appears below — and the transition between the two is the
first orchestrated moment (§6.3).

### 4.2 Measure and container

The app is centred in a container with `max-width: 1680px` and a minimum side gutter of
`--s3`. Beyond 1680 px the extra space becomes gutter rather than making the lattice
1200 px wide and the plan tree 900 px tall — neither of which is more legible.

The shell is a `min-height: 100dvh` grid of `auto 1fr auto`: header, scrolling derivation,
sticky cost bar. Content grows down from the top; the cost bar never leaves.

Column split at ≥1100 px: `minmax(320px, 380px)` for the derivation's inputs (query, cost
breakdown) and `minmax(0, 1fr)` for its results (search, plan). Below that, one column in
derivation order.

### 4.3 The cost parameter bar

Pinned to the bottom, full width, `--shadow-raised` so it reads as floating above the page
rather than as the last panel.

Every cost parameter as a live slider with its default marked. These are the app's continuous
controls and they drive everything above: re-plan, re-sort the cost breakdown, re-fill the
lattice. The 200 ms planning budget exists for this bar.

The seven parameters are a grid of equal tracks — `repeat(auto-fit, minmax(150px, 1fr))` —
not a wrapping flex row. Flexed, six filled the first row and left `cpu_operator_cost` alone
on a second one stretched to the full width of the bar: a thousand-pixel slider for a value
between 0.0005 and 0.05.

`random_page_cost` spans two tracks and carries a marker at 1.1 labelled with what it means,
because dragging from 4.0 to 1.1 and watching the plan flip is the single most useful thing a
DBA can learn here. At the ends of a track the marker's caption aligns inward while the tick
stays on its value — 1.1 on a range starting at 1 is half a percent along, and centred the
caption hangs off the edge of the bar.

A parameter moved off its default has its readout in `--ink` at 500 weight against the
default's `--ink-mid`, and the reset button counts how many have moved. Both are there so a
reader who has been dragging for five minutes can see, without reading seven numbers, that
they are no longer looking at stock Postgres.

### 4.4 The instrument bay

Tabbed: correlation, histogram, sample, timeline, recovery. One at a time, full width, on
panel ground, with the tab strip on `--surface-sunken` so the active tab reads as lifted out
of it rather than underlined within it.

Recovery is the only tab that changes the state above it, since creating a statistic
re-plans. It carries an `--order` dot for that reason.

### 4.5 Grid, rhythm and shape

8 px base. Spacing scale: 4 · 8 · 12 · 16 · 24 · 40 · 64. Tighter than the other apps,
because density is the design; the 4 px step is new and exists for the inside of controls.

Radii, three values and no more:

| Token | Value | Use |
|---|---|---|
| `--r-control` | 4px | Buttons, selects, inputs, chips, tabs. |
| `--r-panel` | 8px | Panels, the sunken canvas, popovers. |
| `--r-full` | 999px | The theme toggle and nothing else. |

Revision 1's uniform 2 px made everything look like the same small hard thing. Panels are
large and want a radius you can see; controls are small and want one you can barely see.

Panels are `--surface` on `--bg`, with a `--line` hairline and `--shadow-panel`. Diagrams sit
on a `--surface-sunken` canvas inside the panel, inset by `--s2`, with no border — the value
step is the border. This is the one place revision 1's "no inner card" rule is relaxed, and
it is relaxed because a lattice drawn directly on panel ground has no edge and no floor.

### 4.6 The control vocabulary

One set, defined once, used everywhere. Revision 1 had six near-identical copies of a chip
button spread across six stylesheets, which is how three of them ended up with different
padding.

| Class | Shape |
|---|---|
| `.control` | The base: `--t-label`, `--r-control`, 1px `--line`, `--surface` ground, `--ink-mid` text, 26 px tall. |
| `.control:hover` | `--ink` text, `--line-strong` border. No background change, no transition longer than 120 ms. |
| `.control[aria-pressed='true']`, `.control.is-active` | `--surface-raised` ground, `--ink` text, `--line-strong` border. |
| `.control:disabled` | 45% opacity, no hover. |
| `.control-quiet` | The same, with no border until hover. For dense clusters. |
| `.field` | Text and number inputs, and `select`. `--surface-sunken` ground, 1px `--line`, mono. |
| `.range` | `input[type=range]`, `accent-color: var(--ink)`, 16 px track box. |
| `.eyebrow` | §3.2. |
| `.panel-head` | Eyebrow, `h2`, and a right-aligned meta slot on one baseline. |

Focus is a 2 px `--focus` ring at 2 px offset, everywhere, including SVG lattice cells and
plan nodes. It is never removed and never replaced by a colour change.

### 4.7 Mobile

Below 1100 px the columns stack in derivation order: query, search, plan, cost breakdown,
bay, result. The lattice keeps horizontal scroll per level with the level label pinned left.
The plan tree keeps its estimate/actual spans — they are the point and they compress before
anything else does. The cost bar keeps `random_page_cost` and `work_mem`; the rest moves
behind a disclosure.

Below 560 px the verdict block's display figure drops to `--t-figure`, the panel padding
drops a step, and the header wraps its status line beneath the title. Usable at 380 px with
the plan tree legible is the floor, and it is a floor rather than an aspiration.

---

## 5. Instruments

### 5.1 The lattice

Levels stacked bottom to top, level 1 at the bottom. Cells ordered within a level by relation
set, and that order never changes between renders — a cell must not move.

Each cell shows its relation set as initials, its best plan's operator glyph, and its cost.
Cells retained for an interesting order carry a second, smaller mark in `--order`.

Unfilled cells are the sunken canvas itself, which is to say they are absence rather than a
drawn empty box. Filled cells are ink on `--surface`. Candidates that lost are drawn
inside the cell as small drained marks, so the density of losers is visible — level 4 cells
often considered a dozen plans and kept one.

Selecting a cell shows its full candidate list in the cost breakdown, which turns the lattice
into a navigable record of the entire search rather than an animation that plays once.

### 5.2 The plan tree

Reingold–Tilford layout, root at top, drawn in line.

Each node carries: operator name in Postgres's own words, the relation, the estimate/actual
span, and cost. The relation line is truncated to the node's width — SVG text neither wraps
nor clips on its own, and a parameterized index scan's subtitle is half again as long as the
node is wide. The full text stays in the node's tooltip and in its detail panel. Operators are distinguished by a glyph at the node — a bar for a scan, a
converging pair for a join, a stack for a sort — not by colour.

**The span is the node's most important element.** A log-scaled horizontal axis local to each
node, with the believed mark hollow-dashed and the true mark solid, and the distance between
filled. Leaves are usually tight. The spans widen as you go up, and the widening is the
error compounding.

The root's ratio is printed at `--t-display` in the **verdict block** beneath the tree
(§4.1), with the direction stated in words and the assumption that produced it named. Under-
estimates carry a `--warn` marker, because those are the ones that produce the nested loop
disaster. The block is bordered on its leading edge only — in `--warn` for an under-estimate,
`--line-strong` otherwise — so the verdict has a frame without becoming a card.

Selecting a node opens its selectivity trace: the method used, the inputs, and the
assumptions listed by name.

### 5.3 Correlation

Two predicate columns as a scatter, points at low opacity so density reads.

The independence assumption drawn as a hollow dashed rectangle — the product of two marginal
selectivities, positioned at the predicate values. The actual matching points are drawn
solid.

**Both are drawn at the same scale, and the scale is area over the field: area is
selectivity.** Revision 1 only did half of this — the belief was drawn to scale and the truth
was drawn as whichever grid cells happened to match, which is a texture rather than an area,
so the two could not be compared by eye at all. The measured selectivity now gets a square of
its own at the same anchor, stroked solid in `--true`, with the region belief failed to cover
tinted as a gap. A 4 px box inside a 43 px one is the hundredfold error, seen before anything
is read.

The area between the two is the error, and it is the app's thesis as a single picture.

The readout sits beside the plot rather than beneath it. The plot is a fixed square and the
bay is the full width of the app, so stacked it left two thirds of the panel as empty field.

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

The table rendered as a dense grid of rows on the sunken canvas, sampled rows in `--true` and
unsampled rows in `--line`. Hue is spent here rather than value, and it is the app's own hue:
a sampled row is a row the statistics actually measured, which is exactly what `--true`
means everywhere else. At a million rows this is a texture rather than a table, which is
correct — it shows what fraction the statistics actually saw.

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

**No em-dashes, and no en-dashes.** The only dash the interface uses is the hyphen, including
as the "no value" glyph in a numeric column. This is not a house-style preference so much as
a defect class: an em-dash reads as ordinary punctuation while you are writing it and only
becomes a tic when you count it across a whole codebase, at which point sixteen of them have
accumulated in shipped strings. Prose that reaches for one gets a colon, a full stop or
parentheses, and the sentence is clearer every time. `tests/copy.test.ts` counts, because a
person cannot.

The same test enforces two more things a person cannot hold in their head: that no marketing
filler verb reaches a string, and that no eyebrow labels two different things. Two panels both
reading `COST`, one the breakdown and one the parameters, is worse than no label at all.

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
pre-filled. It has to be a correlated-predicate query, because that failure is the subject.
It also has to **join**, and revision 1's did not: a single-relation query gives the lattice
exactly one cell, so the app's hero opened on an empty box with a number in the corner.
Three relations is seven cells over three levels — small enough to read at a glance, large
enough to be a lattice — and it gives the under-estimate somewhere to do damage, so the
verdict block, the timeline and the recovery tab all have their subject on first run.

---

## 8. Quality floor

Assumed, not announced: usable at 380 px with the plan tree legible; visible keyboard focus
everywhere including lattice cells and plan nodes; every instrument has a keyboard-reachable
table equivalent; plans exportable as JSON; contrast 4.5:1 for text and 3:1 for graphical
objects **in both themes**; reduced motion honoured; no network at runtime.

Added in revision 2: no component stylesheet names a hex value or a theme — every rule reads
a semantic token, so a third theme would be a token file and nothing else. No stylesheet
declares its own button. `color-scheme` is set per theme so native controls, scrollbars and
range thumbs follow without hand-restyling.

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

**A semantic token layer with two instantiations.** Components read `--surface`,
`--ink-mid`, `--line`; the theme file decides what those are. This is the cheapest way the
family has found to get a second theme, and it is worth adopting before an app has one rather
than after.

**The eyebrow as a landmark rather than a label** (§3.2). A one-word tracked kicker is found
rather than read, which is why the general ban on all-caps does not apply to it.

Departs in one place: this is the densest interface in the family and the only one using a
deliberately neutral typeface. The reason is in §0. Document it, so quiet type does not
become a house default in apps that could carry more.
