/**
 * The error decomposition, against hand-computed cases.
 *
 * The identity that matters is that the two factors multiply back to the node's
 * whole error. If they ever do not, the attribution is telling a story the
 * numbers do not support.
 */
import { describe, it, expect } from 'vitest';
import { errorSource, largestSource, magnitude } from '../src/ui/errorSource.js';
import type { Plan } from '../src/planner/types.js';
import type { NodeStats } from '../src/executor/trace.js';

function stats(actualRows: number): NodeStats {
  return {
    actualRows, actualTimeMs: 0, loops: 1, spills: 0,
    firstRowTimeMs: null, startTimeMs: null, endTimeMs: null,
  };
}

/** A scan, reduced to the two fields the decomposition reads. */
function scan(id: string, estimatedRows: number): Plan {
  return { id, operator: 'Seq Scan', estimatedRows } as unknown as Plan;
}

function join(id: string, estimatedRows: number, outer: Plan, inner: Plan): Plan {
  return { id, operator: 'Hash Join', estimatedRows, outer, inner } as unknown as Plan;
}

describe('errorSource', () => {
  it('attributes all of a leaf error to the leaf', () => {
    const leaf = scan('a', 10);
    const all = new Map([['a', stats(40)]]);
    expect(errorSource(leaf, all.get('a'), all)).toEqual({
      inherited: 1, introduced: 4, total: 4,
    });
  });

  it('separates error arriving from below from error added here', () => {
    // Children estimated 10 and 10, measured 40 and 10: 4x arrives from below.
    // The join predicted 20 and produced 400, so its own error is 400/(4*20) = 5.
    const l = scan('l', 10);
    const r = scan('r', 10);
    const j = join('j', 20, l, r);
    const all = new Map([['l', stats(40)], ['r', stats(10)], ['j', stats(400)]]);

    const source = errorSource(j, all.get('j'), all)!;
    expect(source.inherited).toBeCloseTo(4);
    expect(source.introduced).toBeCloseTo(5);
    expect(source.total).toBeCloseTo(20);
  });

  it('always multiplies back to the whole error', () => {
    const l = scan('l', 7);
    const r = scan('r', 130);
    const j = join('j', 33, l, r);
    const all = new Map([['l', stats(19)], ['r', stats(91)], ['j', stats(2404)]]);
    const s = errorSource(j, all.get('j'), all)!;
    expect(s.inherited * s.introduced).toBeCloseTo(s.total);
    expect(s.total).toBeCloseTo(2404 / 33);
  });

  it('credits a faithful join with introducing nothing', () => {
    // Both children 10x low; the join applies the same selectivity to the truth
    // and lands exactly on it, so it added no error of its own.
    const l = scan('l', 10);
    const r = scan('r', 10);
    const j = join('j', 50, l, r);
    const all = new Map([['l', stats(100)], ['r', stats(100)], ['j', stats(5000)]]);
    const s = errorSource(j, all.get('j'), all)!;
    expect(s.introduced).toBeCloseTo(1);
    expect(s.inherited).toBeCloseTo(100);
  });

  it('declines to decompose a node whose children were not measured', () => {
    const l = scan('l', 10);
    const r = scan('r', 10);
    const j = join('j', 20, l, r);
    const all = new Map([['j', stats(400)]]);
    expect(errorSource(j, all.get('j'), all)).toBeNull();
  });
});

describe('largestSource', () => {
  it('names the node that added the most, not the node with the biggest total', () => {
    // The root's total error is the largest by construction. The useful answer
    // is the leaf that actually introduced it.
    const l = scan('l', 1);
    const r = scan('r', 10);
    const j = join('j', 10, l, r);
    const all = new Map([['l', stats(50)], ['r', stats(10)], ['j', stats(500)]]);
    expect(largestSource(j, all)!.plan.id).toBe('l');
  });

  it('treats an over-estimate as as much of a miss as an under-estimate', () => {
    expect(magnitude(4)).toBe(4);
    expect(magnitude(0.25)).toBe(4);
  });
});
