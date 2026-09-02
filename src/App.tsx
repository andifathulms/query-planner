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
import { useFill, usePrefersReducedMotion } from './ui/useFill.js';
import { DEFAULT_COST_PARAMS, type Plan } from './planner/types.js';
import { DATASETS } from './storage/datasets/index.js';
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
        <h1 className="t-h2">Query planner</h1>
        <p className="t-small app-tagline">
          Why your SQL is slow, and what the database believed when it chose
        </p>
        <div className="app-dataset t-small">
          <label>
            <span className="visually-hidden">Dataset</span>
            <select
              value={state.dataset}
              onChange={(e) => dispatch({ type: 'dataset', dataset: e.target.value as 'wilayah' })}
            >
              {DATASETS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <span aria-hidden="true">·</span>
          <span>{rows(totalRows)} rows</span>
        </div>
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
      </header>

      <main className="app-main">
        <section className="app-query panel" aria-label="Query">
          <SqlInput
            sql={state.sql}
            error={error}
            onChange={(sql) => dispatch({ type: 'sql', sql })}
          />
        </section>

        <section className="app-search panel" aria-label="The search">
          <div className="app-panel-head">
            <h2 className="t-h2">The search</h2>
            {planning && <p className="t-small">planned in {ms(planning.stats.planningMs)}</p>}
          </div>
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
          <div className="app-panel-head">
            <h2 className="t-h2">The plan</h2>
            <SpanLegend />
          </div>
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
              onClose={() => selectNode(null)}
            />
          )}
        </section>

        <section className="app-cost panel" aria-label="Cost breakdown">
          <div className="app-panel-head">
            <h2 className="t-h2">Cost breakdown</h2>
            <p className="t-small">
              {state.selected.cell ? 'candidates for the selected cell' : 'select a lattice cell'}
            </p>
          </div>
          <CostBreakdown
            cell={planning?.cells.find((c) => c.key === state.selected.cell) ?? null}
            fallback={planning?.winner ?? null}
          />
        </section>

        <section className="app-result panel" aria-label="Result">
          <div className="app-panel-head">
            <h2 className="t-h2">Result</h2>
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
                  className="t-small app-export"
                  onClick={() => downloadPlan(state.sql, planning, execution)}
                >
                  export JSON
                </button>
              )}
            </div>
          </div>
          {execution ? <ResultGrid execution={execution} /> : (
            <p className="t-small app-placeholder">Nothing executed.</p>
          )}
        </section>
        <InstrumentBay />

        <section className="app-notes panel" aria-label="Model notes">
          <ModelNotes />
        </section>
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
      stats ? exact(stats.actualRows) : '—',
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

function ResultGrid({ execution }: { execution: NonNullable<ReturnType<typeof useStore>['result']['execution']> }) {
  const shown = execution.rows.slice(0, 60);
  return (
    <div className="app-grid scroll-x">
      <table className="t-data">
        <thead>
          <tr>{execution.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
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
