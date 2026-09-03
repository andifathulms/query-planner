/**
 * The generator and search controls.
 *
 * Table size, skew and seed shape the data the statistics are drawn from; the
 * cartesian toggle changes what the search is allowed to consider. All of them
 * serialise to the URL, so a surprising plan is reproducible from a link.
 *
 * Correlation is not here: it belongs beside the plot that shows what it does
 * (DESIGN.md §5.3), and putting it in two places would suggest they were two
 * different controls.
 */
import { exact } from './format.js';
import './DatasetControls.css';

export interface DatasetControlsProps {
  rows: number;
  zipf: number;
  seed: number;
  allowCartesian: boolean;
  onRows: (value: number) => void;
  onZipf: (value: number) => void;
  onSeed: (value: number) => void;
  onCartesian: (value: boolean) => void;
}

export function DatasetControls({
  rows, zipf, seed, allowCartesian, onRows, onZipf, onSeed, onCartesian,
}: DatasetControlsProps) {
  return (
    <details className="dataset-controls disclosure">
      <summary>Generator</summary>
      <div className="dataset-controls-body">
        <label className="dataset-control t-label">
          <span>rows</span>
          <input
            type="range"
            className="range"
            min={Math.log10(2000)}
            max={Math.log10(1_000_000)}
            step={0.01}
            value={Math.log10(rows)}
            aria-valuetext={`${exact(rows)} rows`}
            onChange={(e) => onRows(roundToTwoFigures(10 ** Number(e.target.value)))}
          />
          <output className="t-data">{exact(rows)}</output>
        </label>

        <label className="dataset-control t-label">
          <span>skew</span>
          <input
            type="range"
            className="range"
            min={0}
            max={1.5}
            step={0.01}
            value={zipf}
            aria-valuetext={`Zipf exponent ${zipf.toFixed(2)}`}
            onChange={(e) => onZipf(Number(e.target.value))}
          />
          <output className="t-data">{zipf.toFixed(2)}</output>
        </label>

        <label className="dataset-control t-label">
          <span>seed</span>
          <input
            type="number"
            className="field dataset-seed"
            min={0}
            max={999999}
            value={seed}
            onChange={(e) => onSeed(Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </label>

        <label className="dataset-toggle t-label">
          <input
            type="checkbox"
            className="checkbox"
            checked={allowCartesian}
            onChange={(e) => onCartesian(e.target.checked)}
          />
          <span>allow cartesian products</span>
        </label>

        <p className="t-micro dataset-note">
          The same seed, size and skew always produce the same data, the same statistics
          and the same plan. Everything here is in the address bar.
        </p>
      </div>
    </details>
  );
}

/** Keep the URL short and the value reproducible from what is displayed. */
function roundToTwoFigures(v: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(v) - 1);
  return Math.max(2000, Math.round(v / magnitude) * magnitude);
}
