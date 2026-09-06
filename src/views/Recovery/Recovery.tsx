/**
 * The recovery (DESIGN.md §5.8, §6.4, PRD §5.8).
 *
 * The app's thesis resolved, as a before and after.
 *
 * Before: independence assumed, the estimate wrong by orders of magnitude, the
 * plan collapsed. Create the multivariate statistic. After: the estimate
 * corrected, the plan re-planned, the execution re-run, the actual time
 * compared. That whole chain running from one click is the payoff.
 *
 * All three kinds are offered, with what each repairs and what it costs to
 * store, because the trade is the reader's to weigh (PRD §6.4: no verdict).
 */
import { useMemo } from 'react';
import { useStore } from '../../state/store.js';
import { runQuery } from '../../state/engine.js';
import { measureExpr, tableFor } from '../../state/truth.js';
import { conjoin } from '../../planner/paths.js';
import { createMultivariate, KIND_LABELS, REPAIRS, specKey, type MultivariateSpec } from '../../stats/multivariate/index.js';
import { DEFAULT_STATISTICS_TARGET } from '../../stats/column.js';
import { Span } from '../../ui/Span.js';
import { bytes, directionWord, errorRatio, exact, list, ms } from '../../ui/format.js';
import { usePrefersReducedMotion } from '../../ui/useFill.js';
import type { MultivariateKind } from '../../stats/types.js';
import { walkPlan, type Plan, type QuerySpec } from '../../planner/types.js';
import { SIMPLIFICATIONS } from '../../planner/index.js';
import './Recovery.css';

const KINDS: MultivariateKind[] = ['dependencies', 'ndistinct', 'mcv'];

export function Recovery() {
  const { state, dispatch, result } = useStore();
  const reducedMotion = usePrefersReducedMotion();
  const { spec, bundle, planning, execution } = result;

  const groups = useMemo(() => candidateGroups(spec), [spec]);

  // The before state: the same query with no multivariate statistics at all.
  // Computed rather than remembered, so the comparison is exact even after a
  // reload from a link that already had statistics in it.
  const before = useMemo(() => {
    if (state.multivariate.length === 0) return null;
    return runQuery({ ...state, multivariate: [] });
  }, [state]);

  if (!spec || !planning) {
    return <p className="t-prose recovery-empty">
        No plan to repair yet. This view needs a query that parses, so that there is an
        estimate to correct.
      </p>;
  }

  if (groups.length === 0) {
    return (
      <p className="t-prose recovery-empty">
        Multivariate statistics describe a group of columns on one table. This query
        constrains or groups by fewer than two columns of any single table, so there is
        nothing for one to correct.
      </p>
    );
  }

  const truth = measureTruth(spec, bundle.schema);
  const after = { planning, execution };

  return (
    <div className={`recovery${reducedMotion ? ' is-static' : ''}`}>
      <div className="recovery-groups">
        {groups.map((group) => (
          <Group
            key={`${group.table}:${group.columns.join(',')}`}
            group={group}
            created={state.multivariate}
            onCreate={(kinds) => dispatch({
              type: 'createStatistic',
              spec: { table: group.table, columns: group.columns, kinds },
            })}
            onDrop={(kinds) => dispatch({
              type: 'dropStatistic',
              spec: { table: group.table, columns: group.columns, kinds },
            })}
            storageFor={(kinds) => {
              const sample = bundle.samples.get(group.table);
              if (!sample) return 0;
              try {
                return createMultivariate(
                  bundle.schema, sample,
                  { table: group.table, columns: group.columns, kinds },
                  DEFAULT_STATISTICS_TARGET,
                ).storageBytes;
              } catch {
                return 0;
              }
            }}
          />
        ))}
      </div>

      {before ? (
        <BeforeAfter
          beforeRows={before.planning?.winner.estimatedRows ?? 0}
          afterRows={after.planning.winner.estimatedRows}
          truth={truth}
          beforeMs={before.execution?.totalMs ?? null}
          afterMs={after.execution?.totalMs ?? null}
          beforeOperators={operatorsOf(before.planning?.winner ?? null)}
          afterOperators={operatorsOf(after.planning.winner)}
        />
      ) : (
        <p className="t-prose recovery-note">
          No multivariate statistic exists yet, so the estimate above assumes independence.
          Create one and the estimate, the plan and the elapsed time all change together.
        </p>
      )}
    </div>
  );
}

function Group({
  group, created, onCreate, onDrop, storageFor,
}: {
  group: ColumnGroup;
  created: MultivariateSpec[];
  onCreate: (kinds: MultivariateKind[]) => void;
  onDrop: (kinds: MultivariateKind[]) => void;
  storageFor: (kinds: MultivariateKind[]) => number;
}) {
  return (
    <div className="recovery-group">
      <h3 className="t-data recovery-group-name">
        {group.table} ({group.columns.join(', ')})
      </h3>
      <p className="t-prose recovery-group-why">{group.why}</p>

      <ul className="recovery-kinds">
        {KINDS.map((kind) => {
          const spec: MultivariateSpec = {
            table: group.table, columns: group.columns, kinds: [kind],
          };
          const exists = created.some((m) => specKey(m) === specKey(spec));
          return (
            <li key={kind} className="recovery-kind">
              <div className="recovery-kind-head">
                <code className="t-data">{KIND_LABELS[kind]}</code>
                <span className="t-micro recovery-kind-cost">{bytes(storageFor([kind]))}</span>
                <button
                  type="button"
                  className="control recovery-action"
                  onClick={() => (exists ? onDrop([kind]) : onCreate([kind]))}
                >
                  {exists ? 'drop' : 'create'}
                </button>
              </div>
              <p className="t-prose recovery-kind-repairs">{REPAIRS[kind]}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Before and after on the same axes.
 *
 * Staged in the order of the causal chain — estimate, then plan, then elapsed
 * time — because the chain is the lesson (§6.4).
 */
function BeforeAfter({
  beforeRows, afterRows, truth, beforeMs, afterMs, beforeOperators, afterOperators,
}: {
  beforeRows: number;
  afterRows: number;
  truth: number | null;
  beforeMs: number | null;
  afterMs: number | null;
  beforeOperators: string[];
  afterOperators: string[];
}) {
  const actual = truth ?? afterRows;
  const beforeRatio = errorRatio(beforeRows, actual);
  const afterRatio = errorRatio(afterRows, actual);
  const max = Math.max(10, beforeRows, afterRows, actual);
  const planChanged = beforeOperators.join(' ') !== afterOperators.join(' ');

  return (
    <div className="recovery-compare">
      <h3 className="t-h2">Before and after</h3>

      <div className="recovery-stage" style={{ '--stage': 1 } as React.CSSProperties}>
        <span className="t-small recovery-stage-label">the estimate</span>
        <svg width={300} height={16} aria-hidden="true">
          <Span believed={Math.max(1, beforeRows)} actual={Math.max(1, actual)}
            min={1} max={max} width={292} height={14} />
        </svg>
        <span className="t-data recovery-stage-value">
          {exact(beforeRows)} → {exact(afterRows)}, truth {exact(actual)}
        </span>
      </div>

      <div className="recovery-stage" style={{ '--stage': 2 } as React.CSSProperties}>
        <span className="t-small recovery-stage-label">the error</span>
        <span className={`t-figure${beforeRatio.direction === 'under' ? ' is-under' : ''}`}>
          {beforeRatio.label}
        </span>
        <span className="t-small recovery-arrow" aria-hidden="true">→</span>
        <span className="t-figure">{afterRatio.label}</span>
        <span className="t-small recovery-stage-note">
          {directionWord(beforeRatio.direction)}, then {directionWord(afterRatio.direction)}
        </span>
      </div>

      <div className="recovery-stage" style={{ '--stage': 3 } as React.CSSProperties}>
        <span className="t-small recovery-stage-label">the plan</span>
        <span className="t-data recovery-stage-value">
          {planChanged
            ? `${list(unique(beforeOperators))} → ${list(unique(afterOperators))}`
            : 'unchanged'}
        </span>
      </div>

      {beforeMs !== null && afterMs !== null && (
        <div className="recovery-stage" style={{ '--stage': 4 } as React.CSSProperties}>
          <span className="t-small recovery-stage-label">elapsed</span>
          <span className="t-data recovery-stage-value">
            {ms(beforeMs)} → {ms(afterMs)}
          </span>
          <span className="t-small recovery-stage-note">
            {/* Elapsed time on one machine, once, and measuring something the
                cost model is not reasoning about. Stated as what it is rather
                than presented as a benchmark. */}
            one run each, in this browser
          </span>
          <p className="t-prose recovery-elapsed-note">{SIMPLIFICATIONS.elapsed}</p>
        </div>
      )}
    </div>
  );
}

// ── Which column groups are worth offering ───────────────────────────────────

interface ColumnGroup {
  table: string;
  columns: string[];
  why: string;
}

/**
 * Groups the query would actually benefit from: columns constrained together on
 * one relation, and columns grouped together.
 *
 * Offering every pair of every table would be a catalogue rather than a repair.
 */
function candidateGroups(spec: QuerySpec | null): ColumnGroup[] {
  if (!spec) return [];
  const out: ColumnGroup[] = [];
  const seen = new Set<string>();

  const add = (alias: string, columns: string[], why: string): void => {
    const relation = spec.relations.find((r) => r.alias === alias);
    if (!relation || columns.length < 2) return;
    const unique = [...new Set(columns)].sort();
    if (unique.length < 2) return;
    const key = `${relation.table}:${unique.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ table: relation.table, columns: unique, why });
  };

  // Equality predicates on one relation: the case functional dependencies and a
  // multivariate MCV repair.
  const byRelation = new Map<string, string[]>();
  for (const restriction of spec.restrictions) {
    const e = restriction.expr;
    if (e.kind !== 'binary' || e.op !== '=') continue;
    const column = e.left.kind === 'column' && e.right.kind === 'literal' ? e.left.name
      : e.right.kind === 'column' && e.left.kind === 'literal' ? e.right.name : null;
    if (!column) continue;
    byRelation.set(restriction.relation, [...(byRelation.get(restriction.relation) ?? []), column]);
  }
  for (const [alias, columns] of byRelation) {
    add(alias, columns, `Constrained together by the WHERE clause, and multiplied under independence.`);
  }

  // GROUP BY over several columns of one relation: what n-distinct repairs.
  const grouped = new Map<string, string[]>();
  for (const expr of spec.groupBy) {
    if (expr.kind !== 'column') continue;
    const alias = expr.table ?? spec.relations[0]?.alias;
    if (!alias) continue;
    grouped.set(alias, [...(grouped.get(alias) ?? []), expr.name]);
  }
  for (const [alias, columns] of grouped) {
    add(alias, columns, 'Grouped together, so the number of groups is the product of two distinct counts.');
  }

  return out;
}

/** The true row count for the query's single-table restrictions. */
function measureTruth(spec: QuerySpec, schema: Parameters<typeof tableFor>[0]): number | null {
  const relation = spec.relations[0];
  if (!relation) return null;
  const restrictions = spec.restrictions.filter((r) => r.relation === relation.alias);
  if (restrictions.length === 0) return null;
  const table = tableFor(schema, spec, relation.alias);
  if (!table) return null;
  return measureExpr(table, conjoin(restrictions.map((r) => r.expr)));
}

function operatorsOf(plan: Plan | null): string[] {
  if (!plan) return [];
  const out: string[] = [];
  walkPlan(plan, (node) => out.push(node.operator));
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
