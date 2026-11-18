import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real settings store writes data/settings.json; this suite only cares
// about the merge semantics on top of it, so it stands in an in-memory one.
let stored = {};
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => structuredClone(stored)),
  updateSettingsWith: vi.fn(async (mutate) => {
    stored = await mutate(structuredClone(stored));
    return structuredClone(stored);
  })
}));

// providerUsage drags in the TUI-scrape/PTY graph. Only `resolveEnabledFamilies`
// is needed here, and it is the one piece that must know about spawnable
// providers — the pure identity half (familyForProvider/familyLabel) is
// imported for real from lib/provider/providerFamilies.js and exercised by these tests.
vi.mock('./provider/providerUsage.js', () => ({
  resolveEnabledFamilies: vi.fn((providers) =>
    (providers || []).filter((p) => p.enabled).map((p) => ({ id: p.expectFamily, label: p.expectLabel })))
}));

import {
  normalizeCost,
  normalizeSubscriptionCosts,
  getSubscriptionCosts,
  saveSubscriptionCosts,
  resolveSubscriptionFamilies,
  getSubscriptionSavings
} from './subscriptionCosts.js';

// Real provider-config shapes, so the family matchers in lib/provider/providerFamilies.js
// are the thing under test rather than a stand-in that can't drift with them.
const providers = [
  { id: 'claude-code', enabled: true, type: 'cli', command: 'claude', expectFamily: 'claude', expectLabel: 'Claude Code' },
  { id: 'codex-cli', enabled: true, type: 'cli', command: 'codex', expectFamily: 'codex', expectLabel: 'Codex' }
];

beforeEach(() => {
  stored = {};
  vi.clearAllMocks();
});

describe('normalizeCost', () => {
  it('keeps a positive price, rounded to cents', () => {
    expect(normalizeCost(200)).toBe(200);
    expect(normalizeCost(20.005)).toBe(20.01);
  });

  // ONE rule for read and write: an over-cap price is cleared on both sides, so
  // it can never read as "not priced" while still sitting in settings.json.
  it('clears zero, negative, over-cap, and unparseable prices', () => {
    for (const value of [0, -1, 1e9, 'x', null, undefined, NaN]) {
      expect(normalizeCost(value)).toBeNull();
    }
  });
});

describe('normalizeSubscriptionCosts', () => {
  it('keeps positive prices and drops cleared ones', () => {
    expect(normalizeSubscriptionCosts({ claude: 200, codex: 0, agy: 1e9 })).toEqual({ claude: 200 });
  });

  it('tolerates a non-object stored value', () => {
    expect(normalizeSubscriptionCosts(null)).toEqual({});
    expect(normalizeSubscriptionCosts('nope')).toEqual({});
  });
});

describe('saveSubscriptionCosts', () => {
  it('persists a price and reads it back', async () => {
    expect(await saveSubscriptionCosts({ claude: 200 })).toEqual({ claude: 200 });
    expect(await getSubscriptionCosts()).toEqual({ claude: 200 });
  });

  it('leaves an omitted family alone but clears one sent as null', async () => {
    await saveSubscriptionCosts({ claude: 200, codex: 20 });
    expect(await saveSubscriptionCosts({ codex: null })).toEqual({ claude: 200 });
  });

  it('treats 0 as a clear, not a $0 plan', async () => {
    await saveSubscriptionCosts({ claude: 200 });
    expect(await saveSubscriptionCosts({ claude: 0 })).toEqual({});
  });

  it('preserves unrelated settings keys', async () => {
    stored = { timezone: 'UTC' };
    await saveSubscriptionCosts({ claude: 200 });
    expect(stored.timezone).toBe('UTC');
  });
});

describe('resolveSubscriptionFamilies', () => {
  it('offers every enabled family', () => {
    expect(resolveSubscriptionFamilies(providers, {})).toEqual([
      { family: 'claude', label: 'Claude Code', enabled: true },
      { family: 'codex', label: 'Codex', enabled: true }
    ]);
  });

  // Otherwise toggling a provider off would hide — and on the next save,
  // silently discard — the price of a plan the user still pays for.
  it('keeps a priced family whose provider is no longer enabled', () => {
    const rows = resolveSubscriptionFamilies(providers, { grok: 30 });
    expect(rows).toContainEqual({ family: 'grok', label: 'Grok', enabled: false });
  });

  // Without this the spend has no editor row, so it is stranded in "usage no
  // subscription covers" and the user can never account for it.
  it('offers a row for a disabled family that still has spend in the window', () => {
    const rows = resolveSubscriptionFamilies(providers, {}, ['agy']);
    expect(rows).toContainEqual({ family: 'agy', label: 'Antigravity', enabled: false });
  });

  it('does not duplicate a family that is both priced and spent', () => {
    const rows = resolveSubscriptionFamilies(providers, { grok: 30 }, ['grok']);
    expect(rows.filter((r) => r.family === 'grok')).toHaveLength(1);
  });
});

describe('getSubscriptionSavings', () => {
  it('compares a plan price against the API cost its family ran up', async () => {
    await saveSubscriptionCosts({ claude: 200 });
    const savings = await getSubscriptionSavings({
      report: { providers: [{ id: 'claude-code', family: 'claude', estimatedCost: 500 }] },
      providers,
      from: '2026-02-01',
      to: '2026-02-28',
      today: '2026-03-05'
    });
    const claude = savings.families.find((f) => f.family === 'claude');
    expect(savings.range.days).toBe(28);
    expect(claude.periodCost).toBeCloseTo(184, 0);
    expect(claude.savings).toBeCloseTo(316, 0);
    expect(savings.totals.savings).toBeCloseTo(316, 0);
  });

  it('reports API cost from a family the user has not priced as uncovered', async () => {
    const savings = await getSubscriptionSavings({
      report: { providers: [{ id: 'codex-cli', family: 'codex', estimatedCost: 25 }] },
      providers,
      from: '2026-02-01',
      to: '2026-02-07',
      today: '2026-03-05'
    });
    expect(savings.configured).toBe(false);
    expect(savings.totals.apiCost).toBe(0);
    expect(savings.families.find((f) => f.family === 'codex').apiCost).toBe(25);
  });

  it('gives spend from a no-longer-enabled family its own priceable row', async () => {
    const savings = await getSubscriptionSavings({
      report: { providers: [{ id: 'agy-cli', family: 'agy', estimatedCost: 60 }] },
      providers,
      from: '2026-02-01',
      to: '2026-02-07',
      today: '2026-03-05'
    });
    expect(savings.families.find((f) => f.family === 'agy')).toMatchObject({ apiCost: 60, enabled: false });
    expect(savings.unmatchedApiCost).toBe(0);
  });

  it('reports cost no family covers as uncovered, not as savings', async () => {
    const savings = await getSubscriptionSavings({
      report: { providers: [{ id: 'legacy', family: null, estimatedCost: 12.5 }] },
      providers,
      from: '2026-02-01',
      to: '2026-02-07',
      today: '2026-03-05'
    });
    expect(savings.unmatchedApiCost).toBe(12.5);
    expect(savings.totals.savings).toBe(0);
  });

  it('prorates an unbounded range from the first recorded activity', async () => {
    await saveSubscriptionCosts({ claude: 200 });
    const savings = await getSubscriptionSavings({
      report: { providers: [] },
      providers,
      firstActivityDay: '2026-02-01',
      today: '2026-02-10'
    });
    expect(savings.range.days).toBe(10);
    expect(savings.totals.periodCost).toBeCloseTo(65.7, 1);
  });
});
