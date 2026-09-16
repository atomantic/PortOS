import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real settings store writes data/settings.json; this suite only cares
// about the merge semantics on top of it, so it stands in an in-memory one.
let stored = {};
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => structuredClone(stored)),
  updateSettingsWith: vi.fn(async (mutate) => {
    stored = await mutate(structuredClone(stored));
    return structuredClone(stored);
  }),
}));

// The provider store is the thing the enable toggle writes through. Standing it
// in keeps providers.json (and the toolkit graph behind it) out of the suite
// while still proving the fan-out lands on the right records.
let providerRecords = [];
const updateProvider = vi.fn(async (id, patch) => {
  providerRecords = providerRecords.map((p) => (p.id === id ? { ...p, ...patch } : p));
  return providerRecords.find((p) => p.id === id);
});
vi.mock('./providers.js', () => ({
  getAllProviders: vi.fn(async () => ({ providers: structuredClone(providerRecords) })),
  updateProvider: (...args) => updateProvider(...args),
}));

// subscriptionCosts pulls providerUsage's PTY-scrape graph in transitively.
// Only the stored-price read is needed here.
vi.mock('./subscriptionCosts.js', () => ({
  getSubscriptionCosts: vi.fn(async () => structuredClone(stored.subscriptionCosts || {})),
}));

import {
  getPlanTiers,
  savePlanTiers,
  groupProvidersByFamily,
  buildSubscriptionFamilies,
  getSubscriptionOverview,
  setSubscriptionEnabled,
} from './subscriptions.js';

// Real provider-config shapes, so the matchers in lib/providerFamilies.js are
// what these tests exercise rather than a stand-in that can drift from them.
const claudeCli = { id: 'claude-code', name: 'Claude Code', enabled: true, type: 'cli', command: 'claude' };
const claudeAlt = { id: 'claude-code-alt', name: 'Claude (alt)', enabled: false, type: 'cli', command: 'claude' };
const codexCli = { id: 'codex-cli', name: 'Codex', enabled: false, type: 'cli', command: 'codex' };
const claudeOnOllama = { id: 'claude-ollama', name: 'Local', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true };

beforeEach(() => {
  stored = {};
  providerRecords = [];
  updateProvider.mockClear();
});

describe('plan tier persistence', () => {
  it('merges a patch, keeping omitted families and clearing the ones sent empty', async () => {
    await savePlanTiers({ claude: 'Max 20x', codex: 'Pro' });
    expect(await getPlanTiers()).toEqual({ claude: 'Max 20x', codex: 'Pro' });

    // Omitted keeps, '' clears — the same absent-vs-intentionally-empty split
    // the price map holds, so an editor submitting one row can still remove it.
    await savePlanTiers({ codex: '' });
    expect(await getPlanTiers()).toEqual({ claude: 'Max 20x' });

    await savePlanTiers({ claude: null });
    expect(await getPlanTiers()).toEqual({});
  });

  it('trims and caps a stored tier, and never stores a whitespace-only label', async () => {
    await savePlanTiers({ claude: '  Max 5x  ', codex: '   ', agy: 'x'.repeat(200) });
    const tiers = await getPlanTiers();
    expect(tiers.claude).toBe('Max 5x');
    expect(tiers).not.toHaveProperty('codex');
    expect(tiers.agy).toHaveLength(60);
  });
});

describe('groupProvidersByFamily', () => {
  it('maps each provider to its family and skips local-runtime wrappers', () => {
    const grouped = groupProvidersByFamily([claudeCli, claudeAlt, codexCli, claudeOnOllama]);
    expect(grouped.get('claude').map((p) => p.id)).toEqual(['claude-code', 'claude-code-alt']);
    expect(grouped.get('codex').map((p) => p.id)).toEqual(['codex-cli']);
    // An Ollama-backed `claude` wrapper runs a local model — no subscription to
    // manage, so it must not make the Claude plan look enabled.
    expect(grouped.get('claude')).not.toContainEqual(expect.objectContaining({ id: 'claude-ollama' }));
  });
});

describe('buildSubscriptionFamilies', () => {
  it('reports a plan as enabled when ANY of its providers is on', () => {
    const [claude] = buildSubscriptionFamilies({ providers: [claudeCli, claudeAlt] });
    expect(claude).toMatchObject({ family: 'claude', enabled: true });
    expect(claude.providers).toEqual([
      { id: 'claude-code', name: 'Claude Code', enabled: true },
      { id: 'claude-code-alt', name: 'Claude (alt)', enabled: false },
    ]);
  });

  it('keeps a priced family with every provider disabled — its price must stay visible', () => {
    const rows = buildSubscriptionFamilies({ providers: [codexCli], costs: { codex: 20 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ family: 'codex', enabled: false, monthlyCost: 20 });
  });

  it('keeps a priced or tiered family that has no providers at all', () => {
    const rows = buildSubscriptionFamilies({ providers: [], costs: { grok: 30 }, tiers: { agy: 'Pro' } });
    expect(rows.map((r) => r.family).sort()).toEqual(['agy', 'grok']);
    expect(rows.find((r) => r.family === 'grok')).toMatchObject({ monthlyCost: 30, providers: [] });
    expect(rows.find((r) => r.family === 'agy')).toMatchObject({ planTier: 'Pro', providers: [] });
  });

  it('omits a family that is neither configured nor priced', () => {
    const rows = buildSubscriptionFamilies({ providers: [claudeCli] });
    expect(rows.map((r) => r.family)).toEqual(['claude']);
  });

  it('still rows a stored family id the registry no longer knows, so its price is clearable', () => {
    const rows = buildSubscriptionFamilies({ providers: [], costs: { retired: 12 } });
    expect(rows).toEqual([expect.objectContaining({ family: 'retired', label: 'retired', monthlyCost: 12 })]);
  });
});

describe('getSubscriptionOverview', () => {
  it('joins provider membership, stored prices and stored tiers into one row set', async () => {
    providerRecords = [claudeCli, codexCli];
    stored = { subscriptionCosts: { claude: 100 }, subscriptionPlanTiers: { claude: 'Max 5x' } };
    const overview = await getSubscriptionOverview();
    expect(overview.costs).toEqual({ claude: 100 });
    expect(overview.tiers).toEqual({ claude: 'Max 5x' });
    expect(overview.families).toEqual([
      expect.objectContaining({ family: 'claude', enabled: true, monthlyCost: 100, planTier: 'Max 5x' }),
      expect.objectContaining({ family: 'codex', enabled: false, monthlyCost: 0, planTier: null }),
    ]);
  });
});

describe('setSubscriptionEnabled', () => {
  it('flips every provider in the family and leaves the others alone', async () => {
    providerRecords = [claudeCli, claudeAlt, codexCli];
    const result = await setSubscriptionEnabled('claude', false);
    expect(result).toMatchObject({ family: 'claude', enabled: false, applied: true });
    // Only the one that actually had to change was written.
    expect(result.changed).toEqual(['claude-code']);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('claude-code', { enabled: false });
    expect(providerRecords.find((p) => p.id === 'codex-cli').enabled).toBe(false);
  });

  it('enables every disabled provider in the family', async () => {
    providerRecords = [claudeCli, claudeAlt];
    const result = await setSubscriptionEnabled('claude', true);
    expect(result.changed).toEqual(['claude-code-alt']);
    expect(providerRecords.every((p) => p.enabled)).toBe(true);
  });

  it('never touches a local-runtime wrapper that happens to launch the same binary', async () => {
    providerRecords = [claudeCli, claudeOnOllama];
    await setSubscriptionEnabled('claude', false);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('claude-code', { enabled: false });
  });

  it('keeps a stored price when the plan is switched off', async () => {
    providerRecords = [codexCli, { ...codexCli, id: 'codex-2', enabled: true }];
    stored = { subscriptionCosts: { codex: 20 } };
    await setSubscriptionEnabled('codex', false);
    const overview = await getSubscriptionOverview();
    expect(overview.costs).toEqual({ codex: 20 });
    expect(overview.families).toEqual([
      expect.objectContaining({ family: 'codex', enabled: false, monthlyCost: 20 }),
    ]);
  });

  it('reports applied:false for a priced family with nothing local to toggle', async () => {
    providerRecords = [];
    const result = await setSubscriptionEnabled('grok', true);
    expect(result).toEqual({ family: 'grok', enabled: false, applied: false, changed: [] });
    expect(updateProvider).not.toHaveBeenCalled();
  });
});
