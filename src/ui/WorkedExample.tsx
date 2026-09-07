/**
 * One query, followed from a sample of rows to a chosen plan and a measured
 * result, with the numbers this run actually produced.
 *
 * Every step of this derivation was already visible somewhere in the app: the
 * sample in one tab, the frequencies in another, the multiplication in a trace
 * behind a click, the cost in a third panel, the elapsed time in a fourth. What
 * was missing was the chain. A newcomer was handed the conclusion of a
 * derivation whose steps were each individually on screen and never connected,
 * and had no way to see that step four is what causes step six.
 *
 * It reads its numbers from the same objects the instruments render, so it can
 * never quote a figure the rest of the page disagrees with. Where a step rests
 * on an assumption, the step says so rather than a footnote saying so.
 */
import { useEffect, useState } from 'react';
import { walkPlan, planLabel, type Plan, type SelectivityTrace } from '../planner/types.js';
import type { NodeStats } from '../executor/trace.js';
import { cost as formatCost, errorRatio, exact, selectivity as formatSelectivity } from './format.js';
import { formulaFor } from './traceFormula.js';
import './WorkedExample.css';

const KEY = 'query-planner:worked-example';

export interface WorkedExampleProps {
  plan: Plan | null;
  stats: Map<string, NodeStats> | null;
  sampleSize: number;
  totalRows: number;
}

/**
 * The trace that multiplies two or more clause selectivities together, if this
 * query has one. That multiplication is the app's subject, so the walkthrough is
 * offered only for a query that performs it.
 */
function findIndependence(plan: Plan): SelectivityTrace | null {
  let found: SelectivityTrace | null = null;
  const walk = (t: SelectivityTrace): void => {
    if (!found && t.method === 'independence' && (t.children?.length ?? 0) >= 2) found = t;
    for (const c of t.children ?? []) walk(c);
  };
  walkPlan(plan, (node) => node.traces.forEach(walk));
  return found;
}

/** The scan the independence trace belongs to, for naming the relation. */
function findScan(plan: Plan, trace: SelectivityTrace): Plan | null {
  let owner: Plan | null = null;
  walkPlan(plan, (node) => {
    const has = (t: SelectivityTrace): boolean =>
      t === trace || (t.children ?? []).some(has);
    if (!owner && node.traces.some(has)) owner = node;
  });
  return owner;
}

export function WorkedExample({ plan, stats, sampleSize, totalRows }: WorkedExampleProps) {
  const [open, setOpen] = useState(read);
  useEffect(() => { write(open); }, [open]);

  if (!plan) return null;
  const independence = findIndependence(plan);
  if (!independence) return null;

  const scan = findScan(plan, independence);
  const children = independence.children ?? [];
  const formula = formulaFor(independence);
  const rootActual = stats?.get(plan.id)?.actualRows ?? null;
  const scanEstimate = scan?.estimatedRows ?? null;
  const scanActual = scan ? stats?.get(scan.id)?.actualRows ?? null : null;
  const ratio = rootActual !== null ? errorRatio(plan.estimatedRows, rootActual) : null;

  return (
    <details
      className="worked disclosure"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Follow this query from a sample of rows to a chosen plan</summary>

      <ol className="worked-steps">
        <li>
          <p className="t-prose">
            The statistics were built by reading <b>{exact(sampleSize)} rows</b> of the{' '}
            {exact(totalRows)} in the database, not all of them. Everything below descends
            from that sample, so every estimate carries its sampling error.
          </p>
        </li>

        {children.map((child, i) => (
          <li key={i}>
            <p className="t-prose">
              For <code>{child.clause}</code>, the estimator found{' '}
              <b>{formatSelectivity(child.result)}</b>
              {child.assumptions[0] ? `, because ${lowerFirst(child.assumptions[0])}` : '.'}
            </p>
          </li>
        ))}

        <li>
          <p className="t-prose">
            Having no statistic about the two columns together, it assumed they were
            independent and <b>multiplied</b> the two:{' '}
            {formula?.verified && <code>{formula.expression} = </code>}
            <b>{formatSelectivity(independence.result)}</b>. This is the step the whole app
            is about, and it is an assumption rather than a measurement.
          </p>
        </li>

        {scanEstimate !== null && (
          <li>
            <p className="t-prose">
              Applied to the table, that predicted <b>{exact(scanEstimate)} rows</b> out of{' '}
              {scan ? planLabel(scan) : 'the scan'}.
            </p>
          </li>
        )}

        <li>
          <p className="t-prose">
            The planner costed every plan on that prediction and chose{' '}
            <b>{planLabel(plan)}</b> at a cost of {formatCost(plan.cost.total)}. A cheap
            plan for {exact(plan.estimatedRows)} rows is not necessarily a cheap plan for
            more.
          </p>
        </li>

        {rootActual !== null && (
          <li>
            <p className="t-prose">
              Running it produced <b>{exact(rootActual)} rows</b>
              {scanActual !== null && scanEstimate !== null
                && ` (the scan alone produced ${exact(scanActual)}, not ${exact(scanEstimate)})`}
              .{ratio && ratio.direction !== 'exact'
                && ` The estimate was ${ratio.label} ${ratio.direction === 'under' ? 'too low' : 'too high'}.`}
            </p>
          </li>
        )}

        <li>
          <p className="t-prose">
            The multiplication in step {children.length + 2} is why. Knowing one of these
            columns tells you a great deal about the other, so treating them as unrelated
            understates how many rows survive both. The correlation tab draws that gap as
            an area, and the recovery tab builds the statistic that closes it.
          </p>
        </li>
      </ol>
    </details>
  );
}

/** Assumption strings are written as sentences; here they continue one. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* Storage can throw outright in a private window, so both directions are
 * guarded and the walkthrough simply opens by default when it cannot persist. */
function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'closed';
  } catch { return true; }
}

function write(open: boolean): void {
  try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch { /* not persisted */ }
}
