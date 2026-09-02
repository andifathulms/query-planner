/**
 * Plan export (PRD §8.9).
 *
 * A plan as JSON, in a shape close enough to `EXPLAIN (FORMAT JSON)` that a
 * reader who knows Postgres's output can read it without a key — the same
 * discipline as the operator names. Estimates and actuals sit side by side,
 * which real `EXPLAIN ANALYZE` also does.
 */
import { planChildren, type Plan } from '../planner/types.js';
import type { ExecutionResult } from '../executor/execute.js';
import type { EnumerationResult } from '../planner/index.js';

export interface ExportedNode {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Startup Cost': number;
  'Total Cost': number;
  'Plan Rows': number;
  'Plan Width': number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  Spills?: number;
  Filter?: string;
  'Join Condition'?: string;
  'Sort Key'?: string[];
  'Group Key'?: string[];
  Assumptions?: string[];
  Plans?: ExportedNode[];
}

export interface ExportedPlan {
  query: string;
  Plan: ExportedNode;
  Planning: {
    subsets: number;
    filledSubsets: number;
    candidates: number;
    ordersKept: number;
    'Planning Time': number;
  };
  Execution?: { 'Execution Time': number; Rows: number };
  Note: string;
}

export function exportPlan(
  sql: string, planning: EnumerationResult, execution: ExecutionResult | null,
): ExportedPlan {
  return {
    query: sql,
    Plan: exportNode(planning.winner, execution),
    Planning: {
      subsets: planning.stats.subsets,
      filledSubsets: planning.stats.filledSubsets,
      candidates: planning.stats.candidates,
      ordersKept: planning.stats.ordersKept,
      'Planning Time': round(planning.stats.planningMs),
    },
    ...(execution
      ? { Execution: { 'Execution Time': round(execution.totalMs), Rows: execution.producedRows } }
      : {}),
    // Stated once, plainly, where the numbers are (PRD §6.2).
    Note:
      'Estimates and actuals come from one engine, so their pairing is exact. '
      + 'Real Postgres would give different numbers: this cost model is simplified, '
      + 'and every simplification that affects a decision is listed in the app.',
  };
}

function exportNode(plan: Plan, execution: ExecutionResult | null): ExportedNode {
  const stats = execution?.stats.get(plan.id);
  const node: ExportedNode = {
    'Node Type': plan.operator,
    'Startup Cost': round(plan.cost.startup),
    'Total Cost': round(plan.cost.total),
    'Plan Rows': Math.round(plan.estimatedRows),
    'Plan Width': plan.rowWidth,
  };

  if (plan.operator === 'Seq Scan' || plan.operator === 'Index Scan') {
    node['Relation Name'] = plan.relation.table;
    node.Alias = plan.relation.alias;
    if (plan.index) node['Index Name'] = `${plan.relation.table}_${plan.index.column}_idx`;
    if (plan.filters.length > 0) node.Filter = plan.filters.map((f) => f.text).join(' AND ');
  }
  if (plan.operator === 'Nested Loop' || plan.operator === 'Hash Join' || plan.operator === 'Merge Join') {
    if (plan.clause) node['Join Condition'] = plan.clause.text;
  }
  if (plan.operator === 'Sort') {
    node['Sort Key'] = plan.sortKeys.map((k) => `${k.relation}.${k.column} ${k.direction}`);
  }
  if (plan.operator === 'HashAggregate' || plan.operator === 'GroupAggregate') {
    node['Group Key'] = plan.groupBy.map((_, i) => `key${i + 1}`);
  }

  if (stats) {
    node['Actual Rows'] = stats.actualRows;
    node['Actual Loops'] = Math.max(1, stats.loops);
    if (stats.firstRowTimeMs !== null) node['Actual Startup Time'] = round(stats.firstRowTimeMs);
    if (stats.endTimeMs !== null) node['Actual Total Time'] = round(stats.endTimeMs);
    if (stats.spills > 0) node.Spills = stats.spills;
  }

  // The assumptions are the part real EXPLAIN never shows, and the reason the
  // export is worth having.
  const assumptions = plan.traces.flatMap((t) => t.assumptions);
  if (assumptions.length > 0) node.Assumptions = assumptions;

  const children = planChildren(plan);
  if (children.length > 0) node.Plans = children.map((c) => exportNode(c, execution));

  return node;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
