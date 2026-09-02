/**
 * The execution timeline (DESIGN.md §5.7, PRD §5.7).
 *
 * One track per plan node, positioned by tree depth, on a horizontal time axis.
 * Each track shows its startup period hollow and its output period solid, so
 * pipelining and blocking are visually distinct: a hash join's build side is a
 * long hollow bar with nothing emitted, then output begins; a nested loop's
 * output starts almost at zero.
 *
 * This view is why `LIMIT 10` changes which plan is right. Spills appear as
 * `--warn` marks at the moment they occur.
 */
import { useMemo } from 'react';
import { OperatorGlyph } from '../PlanTree/glyphs.js';
import { exact, ms, plural } from '../../ui/format.js';
import { planLabel, walkPlan, type Plan } from '../../planner/types.js';
import type { ExecutionResult } from '../../executor/execute.js';
import './Timeline.css';

const TRACK_H = 22;
const LABEL_W = 190;

export interface TimelineProps {
  plan: Plan | null;
  execution: ExecutionResult | null;
}

export function Timeline({ plan, execution }: TimelineProps) {
  const tracks = useMemo(() => buildTracks(plan, execution), [plan, execution]);

  if (!plan || !execution || tracks.length === 0) {
    return <p className="t-small timeline-empty">Nothing has been executed.</p>;
  }

  const total = Math.max(execution.totalMs, 0.001);
  const blocking = tracks.filter((t) => t.blocking);

  return (
    <div className="timeline">
      <div className="timeline-tracks scroll-x">
        <svg
          width="100%"
          height={tracks.length * TRACK_H + 18}
          role="img"
          aria-label={`Execution timeline over ${ms(execution.totalMs)}`}
        >
          {tracks.map((track, i) => (
            <g key={track.id} transform={`translate(0, ${i * TRACK_H})`} className="timeline-track">
              <title>
                {`${track.label}\nstartup ${ms(track.startupMs)}, `
                  + `output ${ms(track.endMs - track.startupMs)}, `
                  + `${exact(track.rows)} ${plural(track.rows, 'row')}`}
              </title>

              <g transform={`translate(${track.depth * 10 + 2}, 4)`}>
                <OperatorGlyph operator={track.operator} size={11} />
              </g>
              <text className="t-micro timeline-label" x={track.depth * 10 + 18} y={TRACK_H / 2 + 3}>
                {track.operator}
              </text>

              <g transform={`translate(${LABEL_W}, 0)`} className="timeline-bar">
                {/* Startup: the node is working and emitting nothing. Hollow,
                    because it is time spent on a promise. */}
                <rect
                  className="timeline-startup"
                  x={`${(track.startMs / total) * 100}%`}
                  y={5}
                  width={`${(Math.max(0, track.startupMs - track.startMs) / total) * 100}%`}
                  height={TRACK_H - 12}
                />
                {/* Output: rows are coming out. Solid, because it is measured. */}
                <rect
                  className="timeline-output"
                  x={`${(track.startupMs / total) * 100}%`}
                  y={5}
                  width={`${(Math.max(0, track.endMs - track.startupMs) / total) * 100}%`}
                  height={TRACK_H - 12}
                />
                {track.spills > 0 && (
                  <circle
                    className="timeline-spill"
                    cx={`${(track.startupMs / total) * 100}%`}
                    cy={TRACK_H / 2}
                    r={3}
                  />
                )}
              </g>

              <text className="t-micro timeline-rows" x="100%" dx={-4} y={TRACK_H / 2 + 3}>
                {exact(track.rows)}
              </text>
            </g>
          ))}

          <g transform={`translate(${LABEL_W}, ${tracks.length * TRACK_H})`}>
            <line x1={0} y1={0} x2="100%" y2={0} stroke="var(--rule)" />
            <text className="t-micro timeline-axis" x={0} y={12}>0</text>
            <text className="t-micro timeline-axis" x="100%" dx={-4} y={12} textAnchor="end">
              {ms(execution.totalMs)}
            </text>
          </g>
        </svg>
      </div>

      <div className="timeline-legend t-micro" aria-hidden="true">
        <span><svg width={14} height={9}><rect className="timeline-startup" width={14} height={9} /></svg> startup</span>
        <span><svg width={14} height={9}><rect className="timeline-output" width={14} height={9} /></svg> output</span>
      </div>

      <p className="t-small timeline-note">
        {blocking.length > 0
          ? `${blocking.map((t) => t.operator).join(', ')} `
            + `${blocking.length === 1 ? 'is blocking' : 'are blocking'}: nothing comes out until `
            + `${blocking.length === 1 ? 'its input is' : 'their inputs are'} exhausted. `
            + 'That is why a small LIMIT prefers a plan that pipelines.'
          : 'Every operator in this plan pipelines: the first row arrives almost immediately, '
            + 'which is what makes it cheap under a small LIMIT.'}
      </p>
    </div>
  );
}

interface Track {
  id: string;
  label: string;
  operator: Plan['operator'];
  depth: number;
  startMs: number;
  /** When the first row emerged. Before this the node produced nothing. */
  startupMs: number;
  endMs: number;
  rows: number;
  spills: number;
  blocking: boolean;
}

/**
 * A track per node, in tree order.
 *
 * A node counts as blocking when its startup period is a substantial share of
 * its lifetime — which is the measured version of the definition rather than a
 * lookup table of operator names, and so it reflects what actually happened.
 */
function buildTracks(plan: Plan | null, execution: ExecutionResult | null): Track[] {
  if (!plan || !execution) return [];
  const tracks: Track[] = [];

  walkPlan(plan, (node, depth) => {
    const stats = execution.stats.get(node.id);
    if (!stats) return;
    const start = stats.startTimeMs ?? 0;
    const end = stats.endTimeMs ?? execution.totalMs;
    const firstRow = stats.firstRowTimeMs ?? end;
    const span = Math.max(end - start, 1e-6);

    tracks.push({
      id: node.id,
      label: planLabel(node),
      operator: node.operator,
      depth,
      startMs: start,
      startupMs: Math.max(start, firstRow),
      endMs: Math.max(end, firstRow),
      rows: stats.actualRows,
      spills: stats.spills,
      blocking: (firstRow - start) / span > 0.4,
    });
  });

  return tracks;
}
