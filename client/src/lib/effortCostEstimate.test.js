import { describe, it, expect } from 'vitest';
import { deriveEffortCostRatios, withEstimatedCosts } from './effortCostEstimate.js';

const BENCHMARK = 'Artificial Analysis Intelligence Index v4.2';

const row = (model, effort, cost) => ({
  id: `${model}-${effort}`,
  model,
  effort,
  benchmark: BENCHMARK,
  quality: { value: 50 },
  costPerTask: cost == null ? null : { value: cost },
});

// One family publishing a full ladder calibrates the shape; the second borrows
// it from its own max anchor.
const catalog = [
  row('full-curve', 'low', 0.1),
  row('full-curve', 'medium', 0.2),
  row('full-curve', 'high', 0.5),
  row('full-curve', 'max', 1),
  row('anchored', 'low', null),
  row('anchored', 'high', null),
  row('anchored', 'max', 10),
];

describe('deriveEffortCostRatios', () => {
  it('measures each effort against its family anchor', () => {
    const ratios = deriveEffortCostRatios(catalog);
    expect(ratios.get('max')).toBe(1);
    expect(ratios.get('low')).toBeCloseTo(0.1);
    expect(ratios.get('high')).toBeCloseTo(0.5);
  });

  it('ignores families that publish fewer than two ladder costs', () => {
    expect(deriveEffortCostRatios([row('anchored', 'max', 10)]).size).toBe(0);
  });

  it('calibrates only against families anchored at the highest published effort', () => {
    // 'short' tops out at high, so its high/high = 1 must not pool with
    // full-curve's high/max = 0.5 — the two have different denominators.
    const ratios = deriveEffortCostRatios([
      ...catalog,
      row('short', 'medium', 5),
      row('short', 'high', 10),
    ]);
    expect(ratios.get('high')).toBeCloseTo(0.5);
    expect(ratios.get('medium')).toBeCloseTo(0.2);
  });
});

describe('withEstimatedCosts', () => {
  it('scales the ratio curve onto a family with a single published anchor', () => {
    const byId = new Map(withEstimatedCosts(catalog).map(entry => [entry.id, entry]));
    expect(byId.get('anchored-low').estimatedCostPerTask.value).toBeCloseTo(1);
    expect(byId.get('anchored-high').estimatedCostPerTask.value).toBeCloseTo(5);
    expect(byId.get('anchored-low').costEstimated).toBe(true);
    expect(byId.get('anchored-low').estimatedCostPerTask.anchorEffort).toBe('max');
  });

  it('leaves published costs untouched and unflagged', () => {
    const published = withEstimatedCosts(catalog).find(entry => entry.id === 'anchored-max');
    expect(published.costEstimated).toBeUndefined();
    expect(published.costPerTask.value).toBe(10);
    expect(published.estimatedCostPerTask).toBeUndefined();
  });

  it('estimates nothing for a family with no published cost at any effort', () => {
    const orphan = withEstimatedCosts([...catalog, row('unpriced', 'low', null)]).find(
      entry => entry.id === 'unpriced-low'
    );
    expect(orphan.costEstimated).toBeUndefined();
  });

  it('keeps families on separate benchmarks apart', () => {
    const other = { ...row('anchored', 'low', null), benchmark: 'Other Index v1' };
    const estimated = withEstimatedCosts([...catalog, other]).filter(entry => entry.benchmark === 'Other Index v1');
    expect(estimated[0].costEstimated).toBeUndefined();
  });

  it('does not estimate model-level configurations that are not points on the ladder', () => {
    const nonLadder = row('anchored', 'non-reasoning', null);
    const estimated = withEstimatedCosts([...catalog, nonLadder]).find(
      entry => entry.effort === 'non-reasoning'
    );
    expect(estimated.costEstimated).toBeUndefined();
  });
});
