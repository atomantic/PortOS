import { describe, it, expect } from 'vitest';
import {
  DAYS_PER_MONTH,
  resolveSavingsWindow,
  prorateMonthlyCost,
  savingsPercent,
  costMultiplier,
  attributeReportCostToFamilies,
  buildSubscriptionSavings
} from './subscriptionSavings.js';

const window7 = { start: '2026-02-01', end: '2026-02-07', days: 7 };
const window30 = { start: '2026-02-01', end: '2026-03-02', days: 30 };

describe('resolveSavingsWindow', () => {
  it('counts an explicit range inclusively', () => {
    expect(resolveSavingsWindow({ from: '2026-02-01', to: '2026-02-07', today: '2026-03-01' }))
      .toEqual(window7);
  });

  it('clamps an open end to today rather than billing the future', () => {
    expect(resolveSavingsWindow({ from: '2026-02-25', to: null, today: '2026-03-01' }))
      .toEqual({ start: '2026-02-25', end: '2026-03-01', days: 5 });
  });

  it('clamps a future `to` to today', () => {
    expect(resolveSavingsWindow({ from: '2026-02-25', to: '2026-12-31', today: '2026-03-01' }).end)
      .toBe('2026-03-01');
  });

  it('starts an unbounded range at the first recorded activity', () => {
    expect(resolveSavingsWindow({ firstActivityDay: '2026-01-30', today: '2026-02-01' }))
      .toEqual({ start: '2026-01-30', end: '2026-02-01', days: 3 });
  });

  it('is empty when nothing has been recorded yet', () => {
    expect(resolveSavingsWindow({ today: '2026-02-01' })).toEqual({ start: null, end: '2026-02-01', days: 0 });
  });

  it('is empty when the window starts after it ends', () => {
    expect(resolveSavingsWindow({ from: '2026-05-01', to: null, today: '2026-02-01' }).days).toBe(0);
  });

  it('crosses a leap day correctly', () => {
    expect(resolveSavingsWindow({ from: '2028-02-27', to: '2028-03-01', today: '2028-06-01' }).days).toBe(4);
  });

  it('rejects a caller that forgot to pass today', () => {
    expect(() => resolveSavingsWindow({ from: '2026-01-01' })).toThrow(TypeError);
  });
});

describe('prorateMonthlyCost', () => {
  it('charges a full average month for a month-long window', () => {
    expect(prorateMonthlyCost(200, DAYS_PER_MONTH)).toBe(200);
  });

  it('charges a week of a $200 plan', () => {
    expect(prorateMonthlyCost(200, 7)).toBeCloseTo(46.0, 1);
  });

  it('treats an unpriced, negative, or zero-day plan as costing nothing', () => {
    expect(prorateMonthlyCost(0, 30)).toBe(0);
    expect(prorateMonthlyCost(-5, 30)).toBe(0);
    expect(prorateMonthlyCost(200, 0)).toBe(0);
  });
});

describe('savingsPercent / costMultiplier', () => {
  it('reports the share of the API bill avoided', () => {
    expect(savingsPercent(1000, 800)).toBe(80);
  });

  // The distinction the sentinel convention exists for: an unused plan has no
  // percentage, which is NOT the same statement as "you saved 0%".
  it('returns null, not 0, when there is nothing to divide by', () => {
    expect(savingsPercent(0, -50)).toBeNull();
    expect(costMultiplier(500, 0)).toBeNull();
  });

  it('reports API value per dollar of plan spend', () => {
    expect(costMultiplier(500, 50)).toBe(10);
    expect(costMultiplier(0, 50)).toBe(0);
  });
});

describe('attributeReportCostToFamilies', () => {
  const report = {
    providers: [
      { id: 'claude-code', family: 'claude', estimatedCost: 100 },
      { id: 'claude-tui', family: 'claude', estimatedCost: 20 },
      { id: 'codex-cli', family: 'codex', estimatedCost: 25 },
      { id: 'legacy', family: null, estimatedCost: 12.5 },
      { id: 'ollama-local', family: null, estimatedCost: 0 }
    ]
  };

  it('sums each family and leaves unattributed rows out of it', () => {
    const { byFamily, unmatched } = attributeReportCostToFamilies(report);
    expect(byFamily.get('claude')).toBe(120);
    expect(byFamily.get('codex')).toBe(25);
    expect(unmatched).toBe(12.5);
  });

  it('is empty-safe on a missing report', () => {
    expect(attributeReportCostToFamilies(null)).toEqual({ byFamily: new Map(), sources: new Map(), unmatched: 0 });
  });

  it('reports a family as estimated or mixed unless every row is measured', () => {
    const { sources } = attributeReportCostToFamilies({
      providers: [
        { family: 'agy', estimatedCost: 1, source: 'estimate' },
        { family: 'grok', estimatedCost: 1, source: 'measured' },
        { family: 'grok', estimatedCost: 1, source: 'estimate' },
        { family: 'claude', estimatedCost: 1, source: 'measured' },
        { family: 'codex', estimatedCost: 1 }
      ]
    });
    expect(Object.fromEntries(sources)).toEqual({ agy: 'estimate', grok: 'mixed', claude: 'measured', codex: 'estimate' });
  });
});

describe('buildSubscriptionSavings', () => {
  const entries = [
    { family: 'claude', label: 'Claude Code', monthlyCost: 200, apiCost: 812.44 },
    { family: 'codex', label: 'Codex', monthlyCost: 0, apiCost: 40 }
  ];

  it('prices each plan over the window and totals only the priced ones', () => {
    const result = buildSubscriptionSavings({ entries, range: window30 });
    const claude = result.families.find((f) => f.family === 'claude');
    expect(claude.configured).toBe(true);
    expect(claude.periodCost).toBeCloseTo(197.12, 1);
    expect(claude.savings).toBeCloseTo(615.32, 1);
    expect(result.totals.apiCost).toBe(812.44);      // codex is unpriced → excluded
    expect(result.totals.monthlyCost).toBe(200);
    expect(result.configured).toBe(true);
    expect(result.range).toBe(window30);
  });

  it('keeps unpriced plans visible but out of the totals', () => {
    const codex = buildSubscriptionSavings({ entries, range: window30 }).families.find((f) => f.family === 'codex');
    expect(codex).toMatchObject({ configured: false, periodCost: 0, savings: 0, multiplier: null });
    expect(codex.apiCost).toBe(40);
  });

  it('reports a plan that cost more than it did as a negative saving', () => {
    const result = buildSubscriptionSavings({
      entries: [{ family: 'grok', label: 'Grok', monthlyCost: 300, apiCost: 1 }],
      range: window30
    });
    expect(result.totals.savings).toBeLessThan(0);
    expect(result.totals.multiplier).toBeCloseTo(0, 1);
  });

  it('reports uncovered API spend separately from savings', () => {
    const result = buildSubscriptionSavings({ entries, range: window30, unmatchedApiCost: 12.5 });
    expect(result.unmatchedApiCost).toBe(12.5);
    expect(result.totals.savings).toBeCloseTo(615.32, 1);   // unaffected
  });

  it('is empty-but-valid with no families', () => {
    const result = buildSubscriptionSavings({ entries: [], range: window7 });
    expect(result).toMatchObject({ configured: false, families: [], unmatchedApiCost: 0 });
    expect(result.totals).toMatchObject({ periodCost: 0, apiCost: 0, savings: 0, savingsPercent: null, multiplier: null });
  });

  it('charges nothing for a zero-day window', () => {
    const result = buildSubscriptionSavings({ entries, range: { start: null, end: '2026-02-01', days: 0 } });
    expect(result.totals.periodCost).toBe(0);
    expect(result.families[0].configured).toBe(true);  // still priced, just not billed
  });
});
