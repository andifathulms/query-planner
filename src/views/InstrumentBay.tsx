/**
 * The instrument bay (DESIGN.md §4.3).
 *
 * Tabbed: correlation, histogram, sample, timeline, recovery. One at a time,
 * full width, on panel ground.
 *
 * Recovery is the only tab that changes the state above it, since creating a
 * statistic re-plans. It is marked distinctly for that reason.
 */
import { useStore } from '../state/store.js';
import { INSTRUMENTS, type InstrumentId } from '../state/types.js';
import { Correlation } from './Correlation/Correlation.js';
import { Histogram } from './Histogram/Histogram.js';
import { Sample } from './Sample/Sample.js';
import { Timeline } from './Timeline/Timeline.js';
import { Recovery } from './Recovery/Recovery.js';
import './InstrumentBay.css';

export function InstrumentBay() {
  const { state, dispatch, result } = useStore();
  const active = state.selected.instrument;
  const { bundle, spec, execution, planning } = result;

  return (
    <section className="bay panel" aria-label="Instruments">
      <div className="bay-tabs" role="tablist" aria-label="Instruments">
        {INSTRUMENTS.map((instrument) => (
          <button
            key={instrument.id}
            type="button"
            role="tab"
            id={`tab-${instrument.id}`}
            aria-selected={active === instrument.id}
            aria-controls={`panel-${instrument.id}`}
            tabIndex={active === instrument.id ? 0 : -1}
            className={`bay-tab t-small${active === instrument.id ? ' is-active' : ''}`
              + (instrument.id === 'recovery' ? ' is-acting' : '')}
            onClick={() => dispatch({ type: 'select', patch: { instrument: instrument.id } })}
            onKeyDown={(e) => moveTab(e, active, (id) => dispatch({ type: 'select', patch: { instrument: id } }))}
          >
            {instrument.label}
          </button>
        ))}
      </div>

      <div
        className="bay-panel"
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
        tabIndex={0}
      >
        {active === 'correlation' && (
          <Correlation
            schema={bundle.schema}
            statistics={bundle.statistics}
            spec={spec}
            correlation={state.generator.correlation}
            onCorrelation={(correlation) => dispatch({ type: 'generator', patch: { correlation } })}
          />
        )}
        {active === 'histogram' && (
          <Histogram schema={bundle.schema} statistics={bundle.statistics} spec={spec} />
        )}
        {active === 'sample' && (
          <Sample
            schema={bundle.schema}
            statistics={bundle.statistics}
            samples={bundle.samples}
            spec={spec}
            sampleSize={state.sampleSize}
            onSampleSize={(value) => dispatch({ type: 'sampleSize', value })}
          />
        )}
        {active === 'timeline' && <Timeline plan={planning?.winner ?? null} execution={execution} />}
        {active === 'recovery' && <Recovery />}
      </div>
    </section>
  );
}

/** Left and right move between tabs, as the tablist pattern expects. */
function moveTab(
  event: React.KeyboardEvent,
  active: InstrumentId,
  select: (id: InstrumentId) => void,
): void {
  const index = INSTRUMENTS.findIndex((i) => i.id === active);
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % INSTRUMENTS.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + INSTRUMENTS.length) % INSTRUMENTS.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = INSTRUMENTS.length - 1;
  else return;
  event.preventDefault();
  select(INSTRUMENTS[next].id);
  document.getElementById(`tab-${INSTRUMENTS[next].id}`)?.focus();
}
