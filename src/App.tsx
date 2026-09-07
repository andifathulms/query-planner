/**
 * The shell (DESIGN.md §4.1).
 *
 * Left to right, top to bottom, the layout is the derivation: query, search,
 * candidates, chosen plan, evidence. The lattice sits above the plan tree
 * because it produces it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from './state/store.js';
import { SqlInput } from './ui/SqlInput.js';
import { CostBar } from './ui/CostBar.js';
import { SpanLegend } from './ui/Span.js';
import { PlanDetail } from './ui/PlanDetail.js';
import { DatasetControls } from './ui/DatasetControls.js';
import { DataTable } from './ui/DataTable.js';
import { ModelNotes } from './ui/ModelNotes.js';
import { exportPlan } from './ui/exportPlan.js';
import { PlanTree } from './views/PlanTree/PlanTree.js';
import { Lattice } from './views/Lattice/Lattice.js';
import { CostBreakdown } from './views/CostBreakdown/CostBreakdown.js';
import { InstrumentBay } from './views/InstrumentBay.js';
import { ThemeToggle } from './ui/ThemeToggle.js';
import { Mark } from './ui/Mark.js';
import { MakerSignature } from './ui/MakerSignature.js';
import { Lede } from './ui/Lede.js';
import { PlanAnnouncement } from './ui/PlanAnnouncement.js';
import { Select } from './ui/Select.js';
import { useFill, usePrefersReducedMotion } from './ui/useFill.js';
import { DEFAULT_COST_PARAMS, type Plan } from './planner/types.js';
import type { DpCell } from './planner/selinger.js';
import { DATASETS } from './storage/datasets/index.js';
import { EXAMPLES } from './state/types.js';
import { cost as formatCost, exact, ms, rows } from './ui/format.js';
import { walkPlan, planLabel } from './planner/types.js';
import './App.css';

export function App() {
  const { state, dispatch, result } = useStore();
  const { planning, execution, error, bundle } = result;

  const selectNode = useCallback(
    (node: string | null) => dispatch({ type: 'select', patch: { node } }),
    [dispatch],
  );
  const selectCell = useCallback(
    (cell: string | null) => dispatch({ type: 'select', patch: { cell } }),
    [dispatch],
  );

  // The fill lives here rather than inside the lattice, because the second half
  // of the orchestrated moment happens outside it: when the final cell resolves,
  // its plan descends into the tree below (DESIGN.md §6.3). That descent is what
  // makes the two views one thing — without it the lattice is a pretty chart
  // beside a plan; with it, the lattice visibly produces the plan.
  const reducedMotion = usePrefersReducedMotion();
  const fill = useFill(planning?.order ?? [], reducedMotion);
  const descending = useDescent(fill.complete, planning?.winner?.id ?? null, reducedMotion);

  const totalRows = [...bundle.schema.tables.values()]
    .reduce((sum, t) => sum + t.rowCount, 0);

  const selectedNode = useMemo(() => {
    if (!planning || !state.selected.node) return null;
    let found: Plan | null = null;
    walkPlan(planning.winner, (node) => {
      if (node.id === state.selected.node) found = node;
    });
    return found as Plan | null;
  }, [planning, state.selected.node]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <Mark />
          <h1 className="t-h2">Query planner</h1>
        </div>
        <div className="app-status">
          <label className="app-dataset">
            <span className="visually-hidden">Dataset</span>
            <Select
              value={state.dataset}
              onChange={(e) => dispatch({ type: 'dataset', dataset: e.target.value as 'wilayah' })}
            >
              {DATASETS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </Select>
          </label>
          <span className="t-data app-rowcount">{rows(totalRows)} rows</span>
          <ThemeToggle />
        </div>
      </header>

      <Lede
        estimatedRows={planning?.winner.estimatedRows ?? null}
        actualRows={rootActualRows(planning, execution)}
      />

      <main className="app-main">
        <section className="app-query panel" aria-label="Query">
          <SqlInput
            sql={state.sql}
            error={error}
            onChange={(sql) => dispatch({ type: 'sql', sql })}
          />
          {/* One control row under the field: choose a query, or shape the data
              it runs against. Both belong with the statement, not in the title
              bar beside the product name where revision 1 put the generator. */}
          <div className="app-query-controls">
            <Select
              aria-label="Example queries"
              value=""
              onChange={(e) => {
                const example = EXAMPLES.find((x) => x.label === e.target.value);
                if (example) dispatch({ type: 'sql', sql: example.sql });
              }}
            >
              <option value="">examples…</option>
              {EXAMPLES.map((x) => <option key={x.label} value={x.label}>{x.label}</option>)}
            </Select>
            <DatasetControls
            rows={state.generator.rows}
            zipf={state.generator.zipf}
            seed={state.seed}
            allowCartesian={state.allowCartesian}
            onRows={(value) => dispatch({ type: 'generator', patch: { rows: value } })}
            onZipf={(zipf) => dispatch({ type: 'generator', patch: { zipf } })}
            onSeed={(value) => dispatch({ type: 'seed', value })}
            onCartesian={(value) => dispatch({ type: 'cartesian', value })}
            />
          </div>
        </section>

        <section className="app-search panel" aria-label="The search">
          <div className="panel-head">
            <span className="panel-head-title">
              <span className="eyebrow">Search</span>
              <h2 className="t-h2">Every subset the planner considered</h2>
            </span>
            {planning && (
              <span className="panel-head-meta t-data">planned in {ms(planning.stats.planningMs)}</span>
            )}
          </div>
          {/* Cells read `ckp`, `ck`, `cp`. Nothing said those were the aliases
              from the reader's own FROM clause, or that the number was a cost. */}
          <p className="t-prose app-search-key">
            Each box is one combination of the tables in your query, holding the cheapest
            plan found for it and that plan&rsquo;s cost. A dashed box is a combination with
            no join condition to connect it.
          </p>
          {/* The key described a table of results and omitted the recurrence,
              which is the difference between a grid of costs and the reason the
              search is tractable at all. */}
          <p className="t-prose app-search-recurrence">
            Each level is built only from the level below it: a three-table plan is found
            by joining a two-table winner to one more table, never by trying every
            ordering again.
            {planning && ` That reuse is why this query took ${exact(planning.stats.candidates)} `
              + `candidate plans across ${exact(planning.stats.subsets)} combinations, `
              + 'rather than one for every possible join order.'}
          </p>
          <Lattice
            planning={planning}
            selectedKey={state.selected.cell}
            onSelect={selectCell}
            fill={fill}
          />
        </section>

        <section
          className={`app-plan panel${descending ? ' is-descending' : ''}${fill.complete ? '' : ' is-waiting'}`}
          aria-label="The chosen plan"
          aria-busy={!fill.complete}
        >
          <div className="panel-head">
            <span className="panel-head-title">
              <span className="eyebrow">Plan</span>
              <h2 className="t-h2">What it chose, against what happened</h2>
            </span>
            <span className="panel-head-meta"><SpanLegend /></span>
          </div>
          {/* The paired encoding is the app's one idea and it was only ever
              stated as two 6 px marks and the words "estimated · actual" in a
              panel head. Said plainly, once, beside the tree that uses it. */}
          <p className="t-prose app-plan-key">
            Every node carries what the planner predicted, drawn hollow and dashed, against
            what it measured, drawn solid. The distance between the two marks is the error.
          </p>
          <PlanAnnouncement
            plan={planning?.winner ?? null}
            stats={execution?.stats ?? null}
          />
          <PlanTree
            plan={planning?.winner ?? null}
            stats={execution?.stats ?? null}
            selectedId={state.selected.node}
            onSelect={selectNode}
          />

          {planning && (
            <DataTable
              caption="The plan"
              columns={['node', 'estimated', 'actual', 'cost', 'width']}
              rows={planRows(planning.winner, execution)}
            />
          )}

          {selectedNode && (
            <PlanDetail
              plan={selectedNode}
              stats={execution?.stats.get(selectedNode.id) ?? null}
              allStats={execution?.stats ?? null}
              onClose={() => selectNode(null)}
            />
          )}
        </section>

        <section className="app-cost panel" aria-label="Cost breakdown">
          <div className="panel-head">
            <span className="panel-head-title">
              <span className="eyebrow">Cost</span>
              <h2 className="t-h2">What each candidate costs</h2>
            </span>
          </div>
          {/* Cost has no unit and nothing said so, which makes the whole panel
              uninterpretable and the plan flip meaningless: a reader who thinks
              72.1 is milliseconds concludes the app is simply wrong when it
              takes 6 ms. */}
          <p className="t-prose app-cost-unit">
            Cost is not a time. It is Postgres&rsquo;s own unit, fixed by defining one
            sequential page read as 1.0, so every other cost below is a multiple of that
            one read. Only the ratios between the parameters matter, which is why dragging
            <code> random_page_cost</code> from 4.0 to 1.1 says &ldquo;on this disk a random
            read costs barely more than a sequential one&rdquo;.
          </p>
          <p className="t-prose app-cost-hint">
            {state.selected.cell
              ? 'Candidates for the selected lattice cell, decomposed into the terms the cost model produced.'
              : 'Every plan considered for the whole query, cheapest first. Select a lattice cell above to see one join order in isolation.'}
          </p>
          {/* With nothing selected the panel used to show the winner alone,
              which made a heading about candidates true of exactly one of them
              and left no runner-up to measure the decision against. The root
              cell is the whole query's candidate list, which is what a reader
              who has not clicked anything is asking about. */}
          <CostBreakdown
            cell={planning?.cells.find((c) => c.key === state.selected.cell) ?? rootCell(planning)}
            fallback={planning?.winner ?? null}
          />
        </section>

        <section className="app-result panel" aria-label="Result">
          <div className="panel-head">
            <span className="panel-head-title">
              <span className="eyebrow">Result</span>
              <h2 className="t-h2">The rows the plan produced</h2>
            </span>
            <div className="app-result-meta">
              {execution && (
                <p className="t-small">
                  {exact(execution.producedRows)} rows · {ms(execution.totalMs)}
                  {execution.rows.length < execution.producedRows
                    && ` · showing the first ${execution.rows.length}`}
                </p>
              )}
              {planning && (
                <button
                  type="button"
                  className="control"
                  onClick={() => downloadPlan(state.sql, planning, execution)}
                >
                  export JSON
                </button>
              )}
            </div>
          </div>
          {execution ? <ResultGrid execution={execution} /> : (
            <p className="t-prose app-placeholder">
              No rows yet. The result appears here once the query above parses and runs.
            </p>
          )}
        </section>
        <InstrumentBay />

        <section className="app-notes panel" aria-label="Model notes">
          <ModelNotes />
        </section>

        <MakerSignature />
      </main>

      <footer className="app-footer">
        <CostBar
          params={state.costParams}
          onChange={(patch) => dispatch({ type: 'cost', patch })}
          onReset={() => dispatch({ type: 'cost', patch: { ...DEFAULT_COST_PARAMS } })}
        />
      </footer>
    </div>
  );
}

/** The cell holding every candidate for the whole query, which is the top level. */
function rootCell(
  planning: ReturnType<typeof useStore>['result']['planning'],
): DpCell | null {
  if (!planning) return null;
  const top = Math.max(...planning.cells.map((c) => c.level));
  return planning.cells.find((c) => c.level === top) ?? null;
}

/** The root node's measured row count, which is what the estimate is judged against. */
function rootActualRows(
  planning: ReturnType<typeof useStore>['result']['planning'],
  execution: ReturnType<typeof useStore>['result']['execution'],
): number | null {
  if (!planning || !execution) return null;
  return execution.stats.get(planning.winner.id)?.actualRows ?? null;
}

/**
 * True for the length of the descent, once the search has resolved.
 *
 * No caption and no arrow: the descent carries it. Under reduced motion it is an
 * instant state change (§6.7).
 */
function useDescent(complete: boolean, planId: string | null, reducedMotion: boolean): boolean {
  const [descending, setDescending] = useState(false);
  useEffect(() => {
    if (!complete || reducedMotion || planId === null) { setDescending(false); return; }
    setDescending(true);
    const timer = setTimeout(() => setDescending(false), 500);
    return () => clearTimeout(timer);
  }, [complete, planId, reducedMotion]);
  return descending;
}

/** The plan as rows, for the keyboard-reachable equivalent of the tree. */
function planRows(
  plan: Plan, execution: ReturnType<typeof useStore>['result']['execution'],
): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  walkPlan(plan, (node, depth) => {
    const stats = execution?.stats.get(node.id);
    out.push([
      `${'　'.repeat(depth)}${planLabel(node)}`,
      exact(node.estimatedRows),
      stats ? exact(stats.actualRows) : '-',
      formatCost(node.cost.total),
      node.rowWidth,
    ]);
  });
  return out;
}

/**
 * Write the plan out as a file.
 *
 * A blob URL rather than a server round trip: nothing leaves the device
 * (PRD §6.5).
 */
function downloadPlan(
  sql: string,
  planning: NonNullable<ReturnType<typeof useStore>['result']['planning']>,
  execution: ReturnType<typeof useStore>['result']['execution'],
): void {
  const json = JSON.stringify(exportPlan(sql, planning, execution), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'query-plan.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** Column headings, with the ambiguous ones qualified by their relation. */
function headings(execution: { columns: string[]; columnSources: string[] }): string[] {
  const seen = new Map<string, number>();
  for (const c of execution.columns) seen.set(c, (seen.get(c) ?? 0) + 1);
  return execution.columns.map(
    (c, i) => ((seen.get(c) ?? 0) > 1 ? execution.columnSources[i] : c),
  );
}

function ResultGrid({ execution }: { execution: NonNullable<ReturnType<typeof useStore>['result']['execution']> }) {
  // Every row the executor kept. Slicing to 60 here while the meta line above
  // said "showing the first 500" made the interface state something untrue about
  // itself, which in an app about estimates being wrong is the one thing it
  // cannot afford. The grid scrolls.
  const shown = execution.rows;
  return (
    <div className="app-grid scroll-x">
      <table className="grid-table t-data">
        {/* Every DataTable ships a hidden caption; the table holding the actual
            answer was the one without a name (WCAG 1.3.1). */}
        <caption className="visually-hidden">
          The rows the plan produced, showing {exact(execution.rows.length)} of{' '}
          {exact(execution.producedRows)}
        </caption>
        <thead>
          {/* A join can project two columns of the same name — `SELECT k.nama,
              c.nama` returns `nama` twice, as Postgres does. Faithful, and
              unreadable in a grid, so an ambiguous heading is qualified with the
              relation it came from. */}
          <tr>{headings(execution).map((c, i) => <th key={i} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} className={v === null ? 'is-null' : undefined}>
                  {v === null ? 'NULL' : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
