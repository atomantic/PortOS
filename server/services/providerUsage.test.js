import { describe, it, expect, vi, beforeEach } from 'vitest';

// providerUsage imports the provider config service (toolkit-backed) and the
// claude CLI wrapper — mock both so this suite stays hermetic.
vi.mock('./providers.js', () => ({
  // getAllProviders returns the wrapped { activeProvider, providers } shape —
  // getProviderQuotas must unwrap `.providers` before resolving families.
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: null, providers: [] })
}));
vi.mock('./claudeCodeUsage.js', () => ({
  getClaudeCodeUsage: vi.fn()
}));
// The agy/grok adapters drive a real TUI over a PTY — mock the scrape so these
// tests exercise the parse + fetch wiring without spawning a subprocess.
vi.mock('../lib/tuiUsageScrape.js', () => ({
  scrapeTuiUsage: vi.fn()
}));

import {
  parseCodexRateLimits, mapCodexQuota, resolveEnabledFamilies, getProviderQuotas,
  parseAgyUsage, parseGrokUsage, agyRefreshToIso, __resetUsageScrapeCache,
} from './providerUsage.js';
import { getAllProviders } from './providers.js';
import { scrapeTuiUsage } from '../lib/tuiUsageScrape.js';

// Synthetic Antigravity `/usage` panel — invented values, redacted account, in
// the real rendered shape. The bar percentage is percent REMAINING; a full bar
// with "Quota available" has no reset.
const AGY_PANEL = `└ Models & Quota

  Account: user@example.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [█████████████████████████████████████████████████░] 98.99%
    99% remaining · Refreshes in 167h 57m

  Five Hour Limit
    [████████████████████████████████████████░░░░░░░░░░] 80.00%
    80% remaining · Refreshes in 4h 30m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
`;

// Synthetic Grok `/usage show` output — `Weekly limit: N%` is percent USED.
const GROK_PANEL = 'noise noise  Weekly limit: 42% Next reset: August 1, 06:07   trailing noise';

// Synthetic rollout line matching the codex event_msg/token_count shape —
// invented values only, never a transcript from a real session.
const codexLine = (rateLimits, timestamp = '2026-01-01T00:00:00.000Z') =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: rateLimits } });

const SAMPLE_RATE_LIMITS = {
  limit_id: 'codex',
  primary: { used_percent: 7.0, window_minutes: 300, resets_at: 1767225600 },
  secondary: { used_percent: 26.0, window_minutes: 10080, resets_at: 1767830400 },
  plan_type: 'pro'
};

describe('parseCodexRateLimits', () => {
  it('returns the newest rate_limits event in the log', () => {
    const older = codexLine({ ...SAMPLE_RATE_LIMITS, primary: { ...SAMPLE_RATE_LIMITS.primary, used_percent: 3 } }, '2026-01-01T00:00:00Z');
    const newer = codexLine(SAMPLE_RATE_LIMITS, '2026-01-02T00:00:00Z');
    const text = [older, '{"type":"other"}', newer, '{"type":"trailing"}'].join('\n');
    const found = parseCodexRateLimits(text);
    expect(found.timestamp).toBe('2026-01-02T00:00:00Z');
    expect(found.rateLimits.primary.used_percent).toBe(7);
  });

  it('skips a clipped (unparseable) line and keeps scanning', () => {
    const clipped = codexLine(SAMPLE_RATE_LIMITS).slice(20); // broken head from a tail-read
    const good = codexLine(SAMPLE_RATE_LIMITS);
    // clipped line is NEWER (later in file) — parser must fall back to the good one
    expect(parseCodexRateLimits([good, clipped].join('\n'))).not.toBeNull();
  });

  it('returns null when no rate_limits event exists', () => {
    expect(parseCodexRateLimits('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull();
    expect(parseCodexRateLimits('')).toBeNull();
  });
});

describe('mapCodexQuota', () => {
  it('maps primary/secondary windows to the common limit shape', () => {
    const quota = mapCodexQuota(SAMPLE_RATE_LIMITS, '2026-01-02T00:00:00Z');
    expect(quota).toMatchObject({ family: 'codex', supported: true, plan: 'pro', approximate: true });
    expect(quota.limits).toHaveLength(2);
    expect(quota.limits[0]).toMatchObject({ key: 'session', label: 'Current 5h window', percentUsed: 7, percentRemaining: 93 });
    expect(quota.limits[1]).toMatchObject({ key: 'week', label: 'Current week', percentUsed: 26, percentRemaining: 74 });
    expect(quota.limits[0].resetsAt).toBe(new Date(1767225600 * 1000).toISOString());
    expect(quota.note).toContain('2026-01-02T00:00:00Z');
  });

  it('omits windows with no usable used_percent', () => {
    const quota = mapCodexQuota({ primary: { used_percent: 50, window_minutes: 300 }, secondary: null, plan_type: null }, null);
    expect(quota.limits).toHaveLength(1);
    expect(quota.plan).toBe('unknown');
  });
});

describe('resolveEnabledFamilies', () => {
  const providers = [
    { id: 'claude-code', enabled: true, type: 'cli', command: 'claude' },
    { id: 'claude-code-tui', enabled: true, type: 'tui', command: 'claude' },
    { id: 'claude-ollama', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true },
    { id: 'codex', enabled: true, type: 'cli', command: 'codex' },
    { id: 'antigravity-cli', enabled: false, type: 'cli', command: 'agy' },
    { id: 'grok', enabled: true, type: 'api', endpoint: 'https://api.x.ai/v1' },
    { id: 'ollama', enabled: true, type: 'api', endpoint: 'http://localhost:11434/v1' }
  ];

  it('dedupes CLI+TUI variants into one family and skips disabled providers', () => {
    const families = resolveEnabledFamilies(providers).map((f) => f.id);
    expect(families).toEqual(['claude', 'codex', 'grok']); // agy disabled; ollama maps to no family
  });

  it('does not map ollama-backed wrappers to ANY family (local models have no subscription quota)', () => {
    const families = resolveEnabledFamilies([
      { id: 'claude-ollama', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true },
      { id: 'codex-ollama', enabled: true, type: 'cli', command: 'codex', ollamaBacked: true },
      { id: 'grok-ollama', enabled: true, type: 'cli', command: 'grok', ollamaBacked: true }
    ]);
    expect(families).toEqual([]);
  });

  it('matches the agy family when enabled', () => {
    const families = resolveEnabledFamilies([{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }]);
    expect(families.map((f) => f.id)).toEqual(['agy']);
  });

  it('returns empty for empty/undefined provider lists', () => {
    expect(resolveEnabledFamilies([])).toEqual([]);
    expect(resolveEnabledFamilies(undefined)).toEqual([]);
  });
});

describe('getProviderQuotas', () => {
  it('unwraps the { providers } object shape from getAllProviders', async () => {
    // Regression: getAllProviders returns { activeProvider, providers }, not a
    // bare array — passing the object straight into resolveEnabledFamilies threw
    // "(providers || []).filter is not a function" and broke the Usage page.
    getAllProviders.mockResolvedValueOnce({
      activeProvider: 'grok',
      providers: [{ id: 'grok', enabled: true, type: 'api', endpoint: 'https://api.x.ai/v1' }]
    });
    scrapeTuiUsage.mockResolvedValue('Weekly limit: 5% Next reset: Jan 1, 00:00');
    const quotas = await getProviderQuotas();
    expect(Array.isArray(quotas)).toBe(true);
    expect(quotas.map((q) => q.family)).toEqual(['grok']);
  });
});

describe('agyRefreshToIso', () => {
  const NOW = Date.parse('2026-07-14T20:00:00.000Z');

  it('parses hours + minutes into an absolute ISO reset time', () => {
    expect(agyRefreshToIso('167h 57m', NOW)).toBe(new Date(NOW + (167 * 3600 + 57 * 60) * 1000).toISOString());
    expect(agyRefreshToIso('4h 30m', NOW)).toBe(new Date(NOW + (4 * 3600 + 30 * 60) * 1000).toISOString());
  });

  it('parses days and standalone hours', () => {
    expect(agyRefreshToIso('2d 3h', NOW)).toBe(new Date(NOW + (2 * 86400 + 3 * 3600) * 1000).toISOString());
    expect(agyRefreshToIso('12h', NOW)).toBe(new Date(NOW + 12 * 3600 * 1000).toISOString());
  });

  it('returns null when no duration token is present', () => {
    expect(agyRefreshToIso('soon')).toBeNull();
    expect(agyRefreshToIso(null)).toBeNull();
    expect(agyRefreshToIso('')).toBeNull();
  });
});

describe('parseAgyUsage', () => {
  const NOW = Date.parse('2026-07-14T20:00:00.000Z');

  it('maps each model group + window, treating the bar percentage as REMAINING', () => {
    const { limits, groups } = parseAgyUsage(AGY_PANEL, { now: NOW });
    expect(groups).toBe(2);
    expect(limits).toHaveLength(4);

    const gemWeek = limits.find((l) => l.key === 'gemini-weekly');
    // 98.99% remaining → 1% used (100 - 98.99 = 1.01, rounded).
    expect(gemWeek).toMatchObject({ label: 'Gemini · Weekly', percentUsed: 1, percentRemaining: 99, model: 'Gemini' });
    expect(gemWeek.resetsAt).toBe(new Date(NOW + (167 * 3600 + 57 * 60) * 1000).toISOString());

    const gem5h = limits.find((l) => l.key === 'gemini-5-hour');
    expect(gem5h).toMatchObject({ label: 'Gemini · 5-hour', percentUsed: 20, percentRemaining: 80 });
  });

  it('preserves acronyms in group labels and null-resets a fully-available window', () => {
    const { limits } = parseAgyUsage(AGY_PANEL, { now: NOW });
    const cgWeek = limits.find((l) => l.key === 'claude-gpt-weekly');
    // "CLAUDE AND GPT MODELS" → "Claude/GPT" (GPT acronym kept); 100% remaining,
    // "Quota available" → 0% used, no reset.
    expect(cgWeek).toMatchObject({ label: 'Claude/GPT · Weekly', percentUsed: 0, percentRemaining: 100, resetsAt: null });
  });

  it('returns no limits for text without a model group', () => {
    expect(parseAgyUsage('Welcome to the Antigravity CLI').limits).toEqual([]);
    expect(parseAgyUsage('').limits).toEqual([]);
  });
});

describe('parseGrokUsage', () => {
  it('reads the weekly limit as percent USED and passes the reset string through', () => {
    const { limits } = parseGrokUsage(GROK_PANEL);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ key: 'weekly', label: 'Weekly', percentUsed: 42, percentRemaining: 58, resetsAt: 'August 1, 06:07' });
  });

  it('returns no limits when the panel has no weekly-limit line', () => {
    expect(parseGrokUsage('Grok Build Beta  0.2.101').limits).toEqual([]);
    expect(parseGrokUsage(undefined).limits).toEqual([]);
  });
});

describe('TUI usage fetchers (via getProviderQuotas)', () => {
  beforeEach(() => {
    __resetUsageScrapeCache();
    scrapeTuiUsage.mockReset();
  });

  it('surfaces a supported Antigravity card with parsed limits', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    const [card] = await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ command: 'agy', slashCommand: '/usage' }));
    expect(card).toMatchObject({ family: 'agy', supported: true });
    expect(card.error).toBeUndefined();
    expect(card.limits).toHaveLength(4);
  });

  it("drives the matched provider's configured command and envVars, not the bare binary", async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'agy', providers: [
      { id: 'antigravity-cli', enabled: true, type: 'cli', command: '/opt/tools/agy', envVars: { AGY_TOKEN: 'x' } },
    ] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ command: '/opt/tools/agy', env: { AGY_TOKEN: 'x' } }));
  });

  it('surfaces a supported-but-error card when a CLI provider scrape yields no parseable data', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [{ id: 'grok-tui', enabled: true, type: 'tui', command: 'grok' }] });
    scrapeTuiUsage.mockResolvedValueOnce('unrecognized banner, no usage line');
    const [card] = await getProviderQuotas();
    expect(card).toMatchObject({ family: 'grok', supported: true });
    expect(card.limits).toEqual([]);
    expect(card.error).toMatch(/No quota data/);
  });

  it('does NOT scrape when only the API provider is enabled — reports it unsupported', async () => {
    // The built-in `grok` API provider matches the family by id, but the /usage
    // panel is a CLI/TUI surface; scraping would launch an unrelated (possibly
    // absent) binary against a different account. Regression for that.
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [{ id: 'grok', enabled: true, type: 'api', endpoint: 'https://api.x.ai/v1' }] });
    const [card] = await getProviderQuotas();
    expect(scrapeTuiUsage).not.toHaveBeenCalled();
    expect(card).toMatchObject({ family: 'grok', supported: false });
    expect(card.limits).toEqual([]);
  });

  it('caches a scrape and folds a bypassing refresh into a fresh call', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    scrapeTuiUsage.mockResolvedValue(AGY_PANEL);
    await getProviderQuotas();
    await getProviderQuotas(); // cache hit — no second scrape
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(1);
    await getProviderQuotas({ refresh: true }); // bypasses cache
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(2);
  });
});
