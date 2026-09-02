/**
 * The planner's entry point: SQL to a plan, with the whole search retained.
 */
import { parse } from '../parser/parser.js';
import type { Statistics } from '../stats/types.js';
import { resolveQuery, PlanningError } from './resolve.js';
import { enumerate, type EnumerationOptions, type EnumerationResult } from './selinger.js';

export function plan(
  sql: string, statistics: Statistics, options: EnumerationOptions,
): EnumerationResult {
  const stmt = parse(sql);
  const spec = resolveQuery(stmt, statistics);
  return enumerate(spec, statistics, options);
}

export { PlanningError, resolveQuery, enumerate };
export type { EnumerationResult, EnumerationOptions };
export * from './types.js';
export { SIMPLIFICATIONS } from './cost.js';
export { cellLabel, setKey, finishPlan } from './selinger.js';
export type { DpCell } from './selinger.js';
export { interestingOrders } from './orders.js';
export { describeScan } from './paths.js';
