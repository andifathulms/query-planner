/**
 * The cost parameter bar (DESIGN.md §4.2).
 *
 * Pinned to the bottom, full width. Every cost parameter as a live slider with
 * its default marked. These are the app's continuous controls: they map directly
 * with zero easing and re-plan on the frame (§6.1).
 *
 * `random_page_cost` gets the most width and carries a marker at 1.1, because
 * dragging from 4.0 to 1.1 and watching the plan flip is the single most useful
 * thing a DBA can learn here.
 */
import { useState } from 'react';
import { DEFAULT_COST_PARAMS, type CostParams } from '../planner/types.js';
import { bytes } from './format.js';
import './CostBar.css';

interface SliderSpec {
  key: keyof CostParams;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Sliders are linear in the exponent where the range spans decades. */
  log?: boolean;
  format: (v: number) => string;
  /** An annotated position, drawn as a tick with a caption. */
  marker?: { at: number; label: string };
  wide?: boolean;
  /** Kept in the mobile bar rather than moving behind the sheet (§4.5). */
  primary?: boolean;
}

const SLIDERS: SliderSpec[] = [
  {
    key: 'random_page_cost', label: 'random_page_cost',
    min: 1, max: 20, step: 0.05,
    format: (v) => v.toFixed(2),
    marker: { at: 1.1, label: 'SSD' },
    wide: true, primary: true,
  },
  {
    key: 'seq_page_cost', label: 'seq_page_cost',
    min: 0.1, max: 10, step: 0.05, format: (v) => v.toFixed(2),
  },
  {
    key: 'work_mem', label: 'work_mem',
    min: 64 * 1024, max: 1024 * 1024 * 1024, step: 1, log: true,
    format: bytes, primary: true,
  },
  {
    key: 'effective_cache_size', label: 'effective_cache_size',
    min: 8 * 1024 * 1024, max: 64 * 1024 * 1024 * 1024, step: 1, log: true,
    format: bytes,
  },
  {
    key: 'cpu_tuple_cost', label: 'cpu_tuple_cost',
    min: 0.001, max: 0.2, step: 0.001, format: (v) => v.toFixed(3),
  },
  {
    key: 'cpu_index_tuple_cost', label: 'cpu_index_tuple_cost',
    min: 0.0005, max: 0.1, step: 0.0005, format: (v) => v.toFixed(4),
  },
  {
    key: 'cpu_operator_cost', label: 'cpu_operator_cost',
    min: 0.0005, max: 0.05, step: 0.0005, format: (v) => v.toFixed(4),
  },
];

export interface CostBarProps {
  params: CostParams;
  onChange: (patch: Partial<CostParams>) => void;
  onReset: () => void;
}

export function CostBar({ params, onChange, onReset }: CostBarProps) {
  const [expanded, setExpanded] = useState(false);
  const changed = (Object.keys(DEFAULT_COST_PARAMS) as Array<keyof CostParams>)
    .filter((k) => params[k] !== DEFAULT_COST_PARAMS[k]);

  return (
    <div
      className={`cost-bar${expanded ? ' is-expanded' : ''}`}
      role="group"
      aria-label="Cost parameters"
    >
      <span className="eyebrow cost-bar-eyebrow">Cost</span>
      <div className="cost-bar-sliders">
        {SLIDERS.map((spec) => (
          <Slider
            key={spec.key}
            spec={spec}
            value={params[spec.key]}
            onChange={(v) => onChange({ [spec.key]: v } as Partial<CostParams>)}
          />
        ))}
      </div>
      {/* Only visible below 1100 px, where the secondary sliders are hidden. */}
      <button
        type="button"
        className="control cost-bar-more"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? 'fewer' : 'all parameters'}
      </button>

      <button
        type="button"
        className="control cost-bar-reset"
        onClick={onReset}
        disabled={changed.length === 0}
      >
        reset{changed.length > 0 ? ` (${changed.length})` : ''}
      </button>
    </div>
  );
}

function Slider({
  spec, value, onChange,
}: { spec: SliderSpec; value: number; onChange: (v: number) => void }) {
  const toSlider = (v: number): number =>
    (spec.log ? Math.log10(Math.max(v, spec.min)) : v);
  const fromSlider = (v: number): number =>
    (spec.log ? 10 ** v : v);

  const sliderMin = toSlider(spec.min);
  const sliderMax = toSlider(spec.max);
  const sliderStep = spec.log ? (sliderMax - sliderMin) / 240 : spec.step;

  const defaultValue = DEFAULT_COST_PARAMS[spec.key];
  const isDefault = Math.abs(value - defaultValue) < 1e-9;
  const fraction = (toSlider(value) - sliderMin) / (sliderMax - sliderMin);
  const defaultFraction = (toSlider(defaultValue) - sliderMin) / (sliderMax - sliderMin);
  const markerFraction = spec.marker
    ? (toSlider(spec.marker.at) - sliderMin) / (sliderMax - sliderMin)
    : null;

  return (
    <label className={`cost-slider${spec.wide ? ' is-wide' : ''}${spec.primary ? ' is-primary' : ''}`}>
      <span className="cost-slider-label t-data">{spec.label}</span>
      <span className="cost-slider-track">
        <input
          type="range"
          className="range"
          min={sliderMin}
          max={sliderMax}
          step={sliderStep}
          value={toSlider(value)}
          aria-valuetext={spec.format(value)}
          onChange={(e) => onChange(round(fromSlider(Number(e.target.value)), spec))}
        />
        {/* The default, marked so a reader can see how far they have moved. */}
        <span
          className="cost-slider-default"
          style={{ left: `${defaultFraction * 100}%` }}
          aria-hidden="true"
        />
        {markerFraction !== null && (
          /* random_page_cost's SSD marker sits at 1.1 on a range starting at 1,
             which is half a percent along: centred, its caption hangs off the
             left edge of the bar. At either end the caption aligns inward while
             the tick stays exactly where the value is. */
          <span
            className="cost-slider-marker"
            data-edge={markerFraction < 0.12 ? 'start' : markerFraction > 0.88 ? 'end' : undefined}
            style={{ left: `${markerFraction * 100}%` }}
            aria-hidden="true"
          >
            <span className="t-micro cost-slider-marker-label">{spec.marker!.label}</span>
          </span>
        )}
      </span>
      <output className={`cost-slider-value t-data${isDefault ? '' : ' is-changed'}`}>
        {spec.format(value)}
      </output>
      <span className="visually-hidden">{`${Math.round(fraction * 100)}% of range`}</span>
    </label>
  );
}

/** Snap to the declared step so a dragged value is reproducible from the URL. */
function round(v: number, spec: SliderSpec): number {
  if (spec.log) {
    // Round to three significant figures; a byte-count slider does not need
    // more, and it keeps the URL short.
    const magnitude = 10 ** Math.floor(Math.log10(v) - 2);
    return Math.round(v / magnitude) * magnitude;
  }
  return Math.round(v / spec.step) * spec.step;
}
