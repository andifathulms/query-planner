/**
 * The sample (DESIGN.md §5.6, PRD §5.6).
 *
 * The table as a dense grid, sampled rows in ink and unsampled rows faint. At a
 * million rows this is a texture rather than a table, which is correct: it shows
 * what fraction the statistics actually saw.
 *
 * Beside it, the estimate from the sample against the estimate from a full scan,
 * as a paired span. Shrinking the sample degrades the estimate and eventually
 * flips the plan — which is why ANALYZE matters, shown rather than asserted.
 */
import { useMemo, useState } from 'react';
import { analyzeColumn } from '../../stats/column.js';
import { proportionStandardError, reservoirSample } from '../../stats/sample.js';
import { estimateExpr } from '../../planner/selectivity.js';
import { makeContext } from '../../planner/cardinality.js';
import { conjoin } from '../../planner/paths.js';
import { measureExpr, restrictionsFor, tableFor } from '../../state/truth.js';
import { Span } from '../../ui/Span.js';
import { exact, percent, selectivity as formatSelectivity } from '../../ui/format.js';
import type { Sample as SampleType } from '../../stats/sample.js';
import type { Statistics } from '../../stats/types.js';
import type { QuerySpec } from '../../planner/types.js';
import type { Schema } from '../../storage/table.js';
import { DataTable } from '../../ui/DataTable.js';
import { Select } from '../../ui/Select.js';
import './Sample.css';

/** The grid is a texture: one mark per row up to this many, then per block. */
const GRID_COLUMNS = 120;
const GRID_ROWS = 44;

/** The three estimates the split is computed from, all already on screen. */
interface Comparison {
  fromSample: number;
  fromFullScan: number;
  measured: number;
  rowCount: number;
  error: number;
}

export interface SampleProps {
  schema: Schema;
  statistics: Statistics;
  samples: Map<string, SampleType>;
  spec: QuerySpec | null;
  sampleSize: number;
  onSampleSize: (value: number) => void;
}

export function Sample({
  schema, statistics, samples, spec, sampleSize, onSampleSize,
}: SampleProps) {
  const relations = spec?.relations ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  // Default to a relation that carries a predicate. The comparison this view
  // exists for — the estimate from the sample against the estimate from every
  // row — needs something to estimate, and the first relation in the FROM
  // clause is frequently the one with no WHERE clause on it.
  const withRestrictions = spec
    ? relations.find((r) => restrictionsFor(spec, r.alias).length > 0)
    : undefined;
  const relation = relations.find((r) => r.alias === chosen)
    ?? withRestrictions ?? relations[0] ?? null;

  const sample = relation ? samples.get(relation.table) ?? null : null;
  const table = relation && spec ? tableFor(schema, spec, relation.alias) : null;

  const comparison: Comparison | null = useMemo(() => {
    if (!relation || !spec || !table || !sample) return null;
    const restrictions = restrictionsFor(spec, relation.alias);
    if (restrictions.length === 0) return null;

    const expr = conjoin(restrictions.map((r) => r.expr));
    const fromSample = estimateExpr(expr, makeContext(spec, statistics)).selectivity;

    // The same estimator, given statistics collected from every row. This is
    // what the estimate would be with no sampling error at all — the honest
    // comparison, since it isolates the sample from the model.
    const full = reservoirSample(table.rowCount, table.rowCount, sample.seed);
    const fullStats: Statistics = {
      ...statistics,
      tables: new Map(statistics.tables),
    };
    const tableStats = statistics.tables.get(relation.table);
    if (tableStats) {
      const columns = new Map(tableStats.columns);
      for (const name of columns.keys()) {
        columns.set(name, analyzeColumn(table, name, full, 100));
      }
      fullStats.tables.set(relation.table, { ...tableStats, columns });
    }
    const fromFullScan = estimateExpr(expr, makeContext(spec, fullStats)).selectivity;
    const measured = measureExpr(table, expr) / Math.max(1, table.rowCount);

    return {
      fromSample, fromFullScan, measured,
      rowCount: table.rowCount,
      error: proportionStandardError(fromSample, sample),
    };
  }, [relation, spec, table, sample, statistics]);

  if (!relation || !sample || !table) {
    return <p className="t-small sample-empty">No table in scope.</p>;
  }

  const fraction = sample.rowIds.length / Math.max(1, sample.populationSize);

  return (
    <div className="sample">
      <div className="sample-controls">
        <label className="t-small">
          <span className="visually-hidden">Table</span>
          <Select value={relation.alias} onChange={(e) => setChosen(e.target.value)}>
            {relations.map((r) => (
              <option key={r.alias} value={r.alias}>{r.table} {r.alias}</option>
            ))}
          </Select>
        </label>

        <label className="sample-slider t-small">
          <span>sample size</span>
          <input
            type="range"
            className="range"
            min={Math.log10(100)}
            max={Math.log10(500_000)}
            step={0.01}
            value={Math.log10(sampleSize)}
            aria-valuetext={`${exact(sampleSize)} rows`}
            onChange={(e) => onSampleSize(Math.round(10 ** Number(e.target.value)))}
          />
          <output className="t-data">{exact(sampleSize)}</output>
        </label>

        <p className="t-small sample-fraction">
          {exact(sample.rowIds.length)} of {exact(sample.populationSize)} rows seen
          {' · '}{percent(fraction, fraction < 0.01 ? 3 : 1)}
        </p>
      </div>

      <SampleGrid sample={sample} />

      {comparison && (
        <DataTable
          caption="The estimates"
          columns={['source', 'selectivity', 'rows']}
          rows={[
            ['this sample', formatSelectivity(comparison.fromSample), exact(comparison.fromSample * comparison.rowCount)],
            ['a full scan', formatSelectivity(comparison.fromFullScan), exact(comparison.fromFullScan * comparison.rowCount)],
            ['measured', formatSelectivity(comparison.measured), exact(comparison.measured * comparison.rowCount)],
          ]}
        />
      )}

      {comparison ? (
        <div className="sample-comparison">
          <div className="sample-pair">
            <svg width={300} height={16} aria-hidden="true">
              <Span
                believed={Math.max(1, comparison.fromSample * comparison.rowCount)}
                actual={Math.max(1, comparison.measured * comparison.rowCount)}
                min={1}
                max={Math.max(10, comparison.rowCount)}
                width={292}
                height={14}
              />
            </svg>
            <p className="t-small">
              from this sample {formatSelectivity(comparison.fromSample)}
              {' · '}from a full scan {formatSelectivity(comparison.fromFullScan)}
              {' · '}measured {formatSelectivity(comparison.measured)}
            </p>
          </div>
          <p className="t-small sample-error">
            Sampling error on this estimate is about
            {' '}±{percent(1.96 * comparison.error, 3)} at 95% confidence. Shrink the sample
            and it widens; the plan above eventually flips.
          </p>

          {/* The app commits to showing sampling error honestly (PRD §6.3) and
              did, which left every affordance here inviting the reader to blame
              the sample for an error the sample cannot cause. Independence
              failure does not shrink as the sample grows. Splitting the two is
              the difference between "collect more" and "collect differently". */}
          <ErrorSplit comparison={comparison} />
        </div>
      ) : (
        <p className="t-small sample-empty">
          Add a WHERE clause on this table to compare the sampled estimate with the truth.
        </p>
      )}
    </div>
  );
}

/**
 * How much of the gap a bigger sample could close, and how much it could not.
 *
 * Both halves are already computed: the estimate from this sample, the estimate
 * the same model gives when it sees every row, and the measured truth. The first
 * gap is sampling error and shrinks with the sample. The second is the model
 * being wrong about the data, and no sample size touches it.
 */
function ErrorSplit({ comparison }: { comparison: Comparison }) {
  const sampling = Math.abs(comparison.fromSample - comparison.fromFullScan);
  const model = Math.abs(comparison.fromFullScan - comparison.measured);
  const total = sampling + model;
  if (total <= 0) return null;

  const modelShare = model / total;
  return (
    <div className="sample-split">
      <p className="t-prose">
        Of the distance between this estimate and the truth,{' '}
        <strong>{percent(modelShare, 0)} is the model rather than the sample</strong>:
        it is what remains when the same estimator is shown every row in the table.
        Only the other {percent(1 - modelShare, 0)} would narrow if you sampled more.
      </p>
      <dl className="sample-split-figures t-data">
        <div>
          <dt className="t-small">sampling error</dt>
          <dd>{formatSelectivity(sampling)}</dd>
        </div>
        <div>
          <dt className="t-small">model error</dt>
          <dd className="is-model">{formatSelectivity(model)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The grid.
 *
 * One mark per block of rows, shaded by how much of the block the sample saw. At
 * a million rows a per-row grid would be 8,000 screens tall; the block is the
 * honest rendering of the same fact.
 */
function SampleGrid({ sample }: { sample: SampleType }) {
  const blocks = GRID_COLUMNS * GRID_ROWS;
  const perBlock = Math.max(1, Math.ceil(sample.populationSize / blocks));

  const counts = useMemo(() => {
    const out = new Uint16Array(blocks);
    for (const id of sample.rowIds) {
      const block = Math.min(blocks - 1, Math.floor(id / perBlock));
      if (out[block] < 65535) out[block]++;
    }
    return out;
  }, [sample, blocks, perBlock]);

  const cell = 5;
  return (
    <div className="sample-grid scroll-x">
      <svg
        width={GRID_COLUMNS * cell}
        height={GRID_ROWS * cell}
        role="img"
        aria-label={
          `${exact(sample.rowIds.length)} of ${exact(sample.populationSize)} rows were sampled, `
          + `drawn as a grid of ${blocks} blocks of about ${exact(perBlock)} rows each.`
        }
      >
        {Array.from({ length: blocks }, (_, i) => {
          const seen = counts[i] / perBlock;
          if (i * perBlock >= sample.populationSize) return null;
          return (
            <rect
              key={i}
              x={(i % GRID_COLUMNS) * cell}
              y={Math.floor(i / GRID_COLUMNS) * cell}
              width={cell - 1}
              height={cell - 1}
              className={seen > 0 ? 'sample-cell is-seen' : 'sample-cell'}
              style={seen > 0 ? { opacity: Math.min(1, 0.35 + seen * 3) } : undefined}
            />
          );
        })}
      </svg>
    </div>
  );
}
