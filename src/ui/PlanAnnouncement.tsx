/**
 * What just changed, for a reader who cannot see it change.
 *
 * The app's payoff happens silently. Dragging random_page_cost past its
 * threshold flips the winning plan; creating a statistic in the recovery tab
 * re-plans and re-executes the query. Both redraw most of the screen and neither
 * said a word, so a screen reader user got the interface's answer only by going
 * looking for it (WCAG 4.1.3).
 *
 * Two things govern what is announced. It is keyed on the plan's *shape* rather
 * than its cost, because a cost slider moves numbers on every frame of a drag
 * and announcing those would be a firehose; the shape changes exactly when the
 * decision changes, which is the event worth hearing. And it carries the verdict
 * with it, because "the plan changed" without "and it is now 83 times low" is
 * half a sentence.
 */
import { walkPlan, planLabel, type Plan } from '../planner/types.js';
import type { NodeStats } from '../executor/trace.js';
import { directionWord, errorRatio, exact } from './format.js';

export interface PlanAnnouncementProps {
  plan: Plan | null;
  stats: Map<string, NodeStats> | null;
}

/** Operators and their relations, in tree order. Costs deliberately excluded. */
export function planShape(plan: Plan): string {
  const parts: string[] = [];
  walkPlan(plan, (node, depth) => parts.push(`${depth}:${planLabel(node)}`));
  return parts.join('|');
}

export function PlanAnnouncement({ plan, stats }: PlanAnnouncementProps) {
  return <p className="visually-hidden" role="status">{describe(plan, stats)}</p>;
}

/**
 * The message, built from the shape and the measurement and from nothing else.
 *
 * No memo and no debounce, because a live region announces when its text changes
 * and this text does not mention cost. Dragging a cost parameter re-plans on
 * every frame; as long as the winning shape holds, every frame produces the same
 * string, React writes no new text node, and nothing is spoken. The announcement
 * arrives exactly when the decision changes.
 */
function describe(plan: Plan | null, stats: Map<string, NodeStats> | null): string {
  if (!plan) return '';
  const head = `Plan: ${planLabel(plan)}, estimated ${exact(plan.estimatedRows)} rows`;

  const rootActual = stats ? stats.get(plan.id)?.actualRows ?? null : null;
  if (rootActual === null) return `${head}.`;

  const ratio = errorRatio(plan.estimatedRows, rootActual);
  if (ratio.direction === 'exact') return `${head}, and that is what it produced.`;
  return `${head}, produced ${exact(rootActual)}, `
    + `${ratio.label} ${directionWord(ratio.direction)}.`;
}
