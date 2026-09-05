/**
 * The orientation strip: what this is, and what it just found.
 *
 * A stranger's first five seconds used to go: dark panel, monospace, seven
 * snake_case sliders, a grid of three-letter boxes. That reads as an internal
 * debugger for people who already know what a query planner is. The one sentence
 * explaining otherwise was 11.5 px of muted text wedged between the title and a
 * dropdown, and the app's actual finding was below the fold.
 *
 * Both live here instead, at the top, at reading size: the idea on the left, and
 * on the right the number this particular query produced. The sentence also does
 * the work of introducing the estimate-against-truth pairing that every
 * instrument below relies on, so the reader meets the idea before the encoding.
 *
 * The ratio is the same `errorRatio` the plan tree's verdict block uses, so the
 * two can never disagree.
 */
import { errorRatio, exact } from './format.js';
import './Lede.css';

export interface LedeProps {
  estimatedRows: number | null;
  actualRows: number | null;
}

export function Lede({ estimatedRows, actualRows }: LedeProps) {
  const ratio = estimatedRows !== null && actualRows !== null
    ? errorRatio(estimatedRows, actualRows)
    : null;

  return (
    <section className="lede" aria-label="What this is">
      <p className="t-prose lede-copy">
        Databases guess how many rows a query will return, then choose a plan from the
        guess. This one shows you the guess, every plan it considered, and what actually
        happened when it ran.
      </p>

      {ratio && (
        <div className={`lede-verdict${ratio.direction === 'under' ? ' is-under' : ''}`}>
          <span className="t-figure lede-verdict-figure">{ratio.label}</span>
          <span className="lede-verdict-label">
            {ratio.direction === 'exact'
              ? 'the guess was right'
              : `the guess was ${ratio.direction === 'under' ? 'low' : 'high'}`}
            <span className="lede-verdict-detail">
              {exact(estimatedRows!)} estimated, {exact(actualRows!)} actual
            </span>
          </span>
        </div>
      )}
    </section>
  );
}
