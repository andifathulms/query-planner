/**
 * The performance the interface depends on (PRD §8.3, §8.4).
 *
 * Two numbers matter, and both are about the same thing: dragging a cost
 * parameter has to re-plan and re-render on the frame, because that is what
 * makes the plan flip feel like an interaction rather than an event.
 */
import { describe, it, expect } from 'vitest';
import { runQuery } from '../src/state/engine.js';
import { defaultState } from '../src/state/url.js';
import type { AppState } from '../src/state/types.js';

const JOIN = `SELECT p.pekerjaan, k.nama, c.nama, b.nama
FROM penduduk p
JOIN kelurahan k ON p.kelurahan_id = k.id
JOIN kecamatan c ON k.kecamatan_id = c.id
JOIN kabupaten b ON c.kabupaten_id = b.id
WHERE k.kota = 'Surabaya'`;

function drag(state: AppState, values: number[]): number[] {
  return values.map((random_page_cost) => {
    const started = performance.now();
    runQuery({ ...state, costParams: { ...state.costParams, random_page_cost } });
    return performance.now() - started;
  });
}

describe('dragging a cost parameter', () => {
  const state: AppState = { ...defaultState(), sql: JOIN };

  it('re-plans and re-executes a four-table join inside a frame', () => {
    // Warm: the first call builds 120,000 rows and collects statistics, which a
    // drag never repeats.
    runQuery(state);
    const frames = drag(state, [3.9, 3.8, 3.7, 3.6, 3.5, 3.4, 3.3, 3.2]);
    const median = [...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)];
    // 16.7 ms is a frame at 60 fps. The margin is deliberate: the render has to
    // fit in the same frame.
    expect(median).toBeLessThan(16);
  });

  it('does not regenerate the dataset when only a cost parameter moves', () => {
    runQuery(state);
    const first = runQuery(state);
    const second = runQuery({ ...state, costParams: { ...state.costParams, random_page_cost: 2 } });
    // The same schema object, so no rows were regenerated and no sample redrawn.
    expect(second.bundle.schema).toBe(first.bundle.schema);
    expect(second.bundle.samples).toBe(first.bundle.samples);
  });

  it('reuses the actuals while the winning plan is unchanged', () => {
    runQuery(state);
    const a = runQuery({ ...state, costParams: { ...state.costParams, random_page_cost: 3.9 } });
    const b = runQuery({ ...state, costParams: { ...state.costParams, random_page_cost: 3.8 } });
    // Same plan, same data: the execution is the same object, not a re-run.
    if (a.planning!.winner.id === b.planning!.winner.id) {
      expect(b.execution).toBe(a.execution);
    }
  });

  it('re-executes when the plan actually flips', () => {
    const flipping: AppState = {
      ...defaultState(),
      sql: 'SELECT p.pekerjaan FROM penduduk p WHERE p.umur = 40',
    };
    const hdd = runQuery({ ...flipping, costParams: { ...flipping.costParams, random_page_cost: 4 } });
    const ssd = runQuery({ ...flipping, costParams: { ...flipping.costParams, random_page_cost: 1.1 } });
    expect(hdd.planning!.winner.operator).toBe('Seq Scan');
    expect(ssd.planning!.winner.operator).toBe('Index Scan');
    expect(ssd.execution).not.toBe(hdd.execution);
    // Both plans return the same rows, whichever scan was chosen.
    expect(ssd.execution!.producedRows).toBe(hdd.execution!.producedRows);
  });
});
