/**
 * What a screen reader hears when the interface changes under it.
 *
 * The app's payoff is a plan flipping: drag random_page_cost past its threshold,
 * or create a statistic, and most of the screen redraws. None of it was
 * announced (WCAG 4.1.3). The rule pinned here is narrow and load-bearing: the
 * announcement is a function of the plan's shape and its measurement and never
 * of cost, so a slider drag that does not change the decision stays silent
 * rather than speaking on every frame.
 */
import { describe, it, expect } from 'vitest';
import { planShape } from '../src/ui/PlanAnnouncement.js';
import { plan } from '../src/planner/index.js';
import { analyze } from '../src/stats/column.js';
import { buildDataset } from '../src/storage/datasets/index.js';
import { DEFAULT_COST_PARAMS, type CostParams } from '../src/planner/types.js';

const schema = buildDataset('wilayah', { rows: 30_000, correlation: 0.9, zipf: 0.7, seed: 11 });
const { statistics } = analyze(schema, { sampleSize: 4000, seed: 11 });

const SQL = `
  SELECT p.pekerjaan, k.nama
  FROM penduduk p
  JOIN kelurahan k ON p.kelurahan_id = k.id
  WHERE k.kota = 'Kupang'
`;

const shapeAt = (params: CostParams): string =>
  planShape(plan(SQL, statistics, { params }).winner);

const at = (random_page_cost: number): CostParams =>
  ({ ...DEFAULT_COST_PARAMS, random_page_cost });

describe('the announced plan shape', () => {
  it('holds still while a cost parameter moves without flipping the plan', () => {
    // Two neighbouring values on the same side of every threshold. A drag across
    // this range must produce one unchanging string, or the live region speaks
    // on every frame.
    expect(shapeAt(at(4.0))).toBe(shapeAt(at(4.05)));
    expect(shapeAt(at(4.0))).toBe(shapeAt(at(4.1)));
  });

  it('carries no cost figure, so no number can make it differ on its own', () => {
    const shape = shapeAt(DEFAULT_COST_PARAMS);
    expect(shape).not.toMatch(/\d+\.\d\d/);
    expect(shape).toMatch(/Scan|Join|Loop/);
  });

  it('is a pure function of the plan, so equal plans announce equally', () => {
    expect(shapeAt(at(4.0))).toBe(shapeAt(at(4.0)));
  });

  it('differs once the operators or their order differ', () => {
    // Sweeping the full range must reach at least two distinct shapes; if it did
    // not, the announcement could never fire and the test above would be vacuous.
    const shapes = new Set([1.1, 2, 4, 8, 20].map((v) => shapeAt(at(v))));
    expect(shapes.size).toBeGreaterThan(1);
  });
});
