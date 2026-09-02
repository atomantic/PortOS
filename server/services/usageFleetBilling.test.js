import { describe, it, expect, vi, beforeEach } from 'vitest';

let stored = {};
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => structuredClone(stored)),
  updateSettingsWith: vi.fn(async (mutate) => {
    stored = await mutate(structuredClone(stored));
    return structuredClone(stored);
  }),
}));

import {
  normalizeApiBilledInstanceIds,
  getApiBilledInstanceIds,
  saveApiBilledInstanceIds,
  setInstanceUsesSubscriptions,
  USAGE_API_BILLED_SETTINGS_KEY,
  MAX_API_BILLED_IDS,
} from './usageFleetBilling.js';

beforeEach(() => {
  stored = {};
  vi.clearAllMocks();
});

describe('normalizeApiBilledInstanceIds', () => {
  it('keeps unique non-empty ids and drops everything else', () => {
    expect(normalizeApiBilledInstanceIds(['inst-a', 'inst-a', '', null, 'inst-b'])).toEqual(['inst-a', 'inst-b']);
  });

  it('tolerates a non-array stored value', () => {
    expect(normalizeApiBilledInstanceIds(null)).toEqual([]);
    expect(normalizeApiBilledInstanceIds({ 'inst-a': true })).toEqual([]);
  });

  it('caps the list so a hand-edit cannot grow settings without bound', () => {
    const ids = Array.from({ length: MAX_API_BILLED_IDS + 5 }, (_, i) => `inst-${i}`);
    expect(normalizeApiBilledInstanceIds(ids)).toHaveLength(MAX_API_BILLED_IDS);
  });
});

describe('setInstanceUsesSubscriptions', () => {
  it('marks an instance API-billed and reads it back', async () => {
    expect(await setInstanceUsesSubscriptions('inst-peer', false)).toEqual(['inst-peer']);
    expect(await getApiBilledInstanceIds()).toEqual(['inst-peer']);
    expect(stored[USAGE_API_BILLED_SETTINGS_KEY]).toEqual(['inst-peer']);
  });

  it('puts the instance back on subscriptions by removing it from the set', async () => {
    await setInstanceUsesSubscriptions('inst-peer', false);
    expect(await setInstanceUsesSubscriptions('inst-peer', true)).toEqual([]);
  });

  // A blank id would otherwise sit in settings.json forever with no row that
  // could ever clear it — the same hole an unknown subscription family key
  // would open.
  it('ignores a blank instance id', async () => {
    expect(await setInstanceUsesSubscriptions('', false)).toEqual([]);
    expect(await getApiBilledInstanceIds()).toEqual([]);
  });
});

describe('saveApiBilledInstanceIds', () => {
  it('replaces the whole set, dropping invalid entries', async () => {
    await setInstanceUsesSubscriptions('inst-old', false);
    expect(await saveApiBilledInstanceIds(['inst-new', '', 'inst-new'])).toEqual(['inst-new']);
  });
});
