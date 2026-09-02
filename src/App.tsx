/**
 * The shell (DESIGN.md §4.1).
 *
 * Left to right, top to bottom, the layout is the derivation: query, search,
 * candidates, chosen plan, evidence. The lattice sits above the plan tree
 * because it produces it.
 */
import { useCallback } from 'react';
import { useStore } from './state/store.js';
import { SqlInput } from './ui/SqlInput.js';
import { CostBar } from './ui/CostBar.js';
import { SpanLegend } from './ui/Span.js';
import { PlanTree } from './views/PlanTree/PlanTree.js';
import { DEFAULT_COST_PARAMS } from './planner/types.js';
import { DATASETS } from './storage/datasets/index.js';
import { exact, ms, rows } from './ui/format.js';
import './App.css';

export function App() {
  const { state, dispatch, result } = useStore();
  const { planning, execution, error, bundle } = result;

  const selectNode = useCallback(
    (node: string | null) => dispatch({ type: 'select', patch: { node } }),
    [dispatch],
  );

  const totalRows = [...bundle.schema.tables.values()]
    .reduce((sum, t) => sum + t.rowCount, 0);

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
            {planning && (
              <p className="t-small">
                {exact(planning.stats.filledSubsets)} of {exact(planning.stats.subsets)} subsets
                {' · '}{exact(planning.stats.candidates)} candidates
                {' · '}{exact(planning.stats.ordersKept)} orders kept
                {' · '}{ms(planning.stats.planningMs)}
              </p>
            )}
          </div>
          <p className="t-small app-placeholder">
            The lattice is built in the next step.
          </p>
        </section>

        <section className="app-plan panel" aria-label="The chosen plan">
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
        </section>

        <section className="app-result panel" aria-label="Result">
          <div className="app-panel-head">
            <h2 className="t-h2">Result</h2>
            {execution && (
              <p className="t-small">
                {exact(execution.producedRows)} rows · {ms(execution.totalMs)}
                {execution.rows.length < execution.producedRows
                  && ` · showing the first ${execution.rows.length}`}
              </p>
            )}
          </div>
          {execution ? <ResultGrid execution={execution} /> : (
            <p className="t-small app-placeholder">Nothing executed.</p>
          )}
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
