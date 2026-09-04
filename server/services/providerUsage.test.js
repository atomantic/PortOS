import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// providerUsage imports the provider config service (toolkit-backed) and the
// claude CLI wrapper — mock both so this suite stays hermetic.
vi.mock('./providers.js', () => ({
  // getAllProviders returns the wrapped { activeProvider, providers } shape —
  // getProviderQuotas must unwrap `.providers` before resolving families.
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: null, providers: [] })
}));
vi.mock('./claudeCodeUsage.js', () => ({
  getClaudeCodeUsage: vi.fn(),
  systemTimeZone: vi.fn(() => null) // default: no machine TZ → env unchanged
}));
// The agy/grok adapters drive a real TUI over a PTY — mock the scrape so these
// tests exercise the parse + fetch wiring without spawning a subprocess.
vi.mock('../lib/tuiUsageScrape.js', () => ({
  scrapeTuiUsage: vi.fn()
}));
// The image-gen card keys off imageGen SETTINGS (a cloud image backend is
// enabled per-mode, independently of the agent-provider registry). Default to
// none enabled so the family assertions below stay about provider families.
vi.mock('./settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ imageGen: {} })
}));
vi.mock('./imageGenQuota.js', () => ({
  IMAGE_GEN_FAMILY: 'imagegen',
  getImageGenQuota: vi.fn(async ({ enabledModes }) => (enabledModes.length ? {
    family: 'imagegen', label: 'Image Gen', supported: true, burnable: false,
    limits: [], activity: [], metrics: enabledModes.map((m) => ({ key: m, label: m, value: '0 renders · 24h' })),
    approximate: true, fetchedAt: new Date().toISOString()
  } : null))
}));

// The federation layer `getProviderQuotas` folds in reads AND WRITES this
// machine's real `data/` store: `getFleetQuotaEntries` returns whatever peers
// have published, and `recordLocalQuotaCards` persists the cards it was handed
// to `data/provider-quotas.json` (then invalidates the `usage` sync checksum, so
// peers pull it). Unmocked, that made this suite non-hermetic in both
// directions — it read a developer's live peer readings into assertions that
// expect `limits: []`, and it wrote these fixtures' fake agy/grok cards over
// their genuine ones. Green in CI only because CI has no peer data.
// The merge and the store have their own coverage (lib/fleetQuotas.test.js,
// services/peerUsage.test.js); this file's boundary is local card assembly.
vi.mock('./peerUsage.js', () => ({
  getFleetQuotaEntries: vi.fn().mockResolvedValue([])
}));
vi.mock('./providerQuotaShare.js', () => ({
  recordLocalQuotaCards: vi.fn().mockResolvedValue(null)
}));
vi.mock('./usageFleetBilling.js', () => ({
  getApiBilledInstanceIds: vi.fn().mockResolvedValue([])
}));

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseCodexRateLimits, mapCodexQuota, fetchCodexQuota, resolveEnabledFamilies, getProviderQuotas,
  parseAgyUsage, parseGrokUsage, agyRefreshToIso, __resetUsageScrapeCache,
} from './providerUsage.js';
import { getAllProviders } from './providers.js';
import { scrapeTuiUsage } from '../lib/tuiUsageScrape.js';
import { systemTimeZone } from './claudeCodeUsage.js';
import { getSettings } from './settings.js';
import { getImageGenQuota } from './imageGenQuota.js';

// Synthetic Antigravity `/usage` panel — invented values, redacted account, in
// the agy 1.1.x rendered shape (`… Limit Remaining`). The bar percentage is
// percent REMAINING; a full bar with "Quota available" has no reset.
const AGY_PANEL = `└ Models & Quota

  Account: user@example.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit Remaining
    [█████████████████████████████████████████████████░] 98.99%
    99% remaining · Refreshes in 167h 57m

  Five Hour Limit Remaining
    [████████████████████████████████████████░░░░░░░░░░] 80.00%
    80% remaining · Refreshes in 4h 30m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available
`;

// Pre-1.1.x panel: rows ended in bare "Limit" (no " Remaining" suffix). Kept so
// an older agy binary still parses after the 1.1.x rename.
const AGY_PANEL_LEGACY = AGY_PANEL
  .replaceAll('Weekly Limit Remaining', 'Weekly Limit')
  .replaceAll('Five Hour Limit Remaining', 'Five Hour Limit');

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

// Fixed clock BEFORE both sample resets, so window-expiry filtering is
// deterministic instead of "whenever the suite happens to run".
const SAMPLE_NOW = Date.parse('2025-12-31T12:00:00Z');

// Shape Codex emits for its window-less credits bucket: a rate_limits payload
// with both meters null. Invented values only.
const CREDITS_ONLY_RATE_LIMITS = {
  limit_id: 'premium',
  primary: null,
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
  plan_type: null,
  rate_limit_reached_type: null
};

describe('parseCodexRateLimits', () => {
  it('returns the newest rate_limits event in the log', () => {
    const older = codexLine({ ...SAMPLE_RATE_LIMITS, primary: { ...SAMPLE_RATE_LIMITS.primary, used_percent: 3 } }, '2026-01-01T00:00:00Z');
    const newer = codexLine(SAMPLE_RATE_LIMITS, '2026-01-02T00:00:00Z');
    const text = [older, '{"type":"other"}', newer, '{"type":"trailing"}'].join('\n');
    const found = parseCodexRateLimits(text, { now: SAMPLE_NOW });
    expect(found.timestamp).toBe('2026-01-02T00:00:00Z');
    expect(found.rateLimits.primary.used_percent).toBe(7);
  });

  it('prefers an older payload WITH windows over a newer window-less one', () => {
    // The regression: an exhausted quota's newest event is the credits bucket,
    // which carries no meters. Taking it hid the real "100% used" reading.
    const withWindows = codexLine({ ...SAMPLE_RATE_LIMITS, primary: { ...SAMPLE_RATE_LIMITS.primary, used_percent: 100 } }, '2026-01-01T00:00:00Z');
    const creditsOnly = codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T00:30:00Z');
    const found = parseCodexRateLimits([withWindows, creditsOnly].join('\n'), { now: SAMPLE_NOW });
    expect(found.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(found.rateLimits.primary.used_percent).toBe(100);
  });

  it('falls back to the newest window-less payload when nothing better exists', () => {
    const older = codexLine({ ...CREDITS_ONLY_RATE_LIMITS, limit_id: 'stale' }, '2026-01-01T00:00:00Z');
    const newer = codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T00:30:00Z');
    const found = parseCodexRateLimits([older, newer].join('\n'), { now: SAMPLE_NOW });
    expect(found.timestamp).toBe('2026-01-01T00:30:00Z');
    expect(found.rateLimits.limit_id).toBe('premium');
  });

  it('does not treat an already-reset window as a reason to prefer a payload', () => {
    // Both windows expired, so the newest payload wins on recency alone.
    const expired = codexLine(SAMPLE_RATE_LIMITS, '2026-01-01T00:00:00Z');
    const creditsOnly = codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T00:30:00Z');
    const afterReset = Date.parse('2026-02-01T00:00:00Z'); // past both resets_at
    const found = parseCodexRateLimits([expired, creditsOnly].join('\n'), { now: afterReset });
    expect(found.timestamp).toBe('2026-01-01T00:30:00Z');
  });

  it('skips a clipped (unparseable) line and keeps scanning', () => {
    const clipped = codexLine(SAMPLE_RATE_LIMITS).slice(20); // broken head from a tail-read
    const good = codexLine(SAMPLE_RATE_LIMITS);
    // clipped line is NEWER (later in file) — parser must fall back to the good one
    expect(parseCodexRateLimits([good, clipped].join('\n'), { now: SAMPLE_NOW })).not.toBeNull();
  });

  it('returns null when no rate_limits event exists', () => {
    expect(parseCodexRateLimits('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull();
    expect(parseCodexRateLimits('')).toBeNull();
  });
});

describe('mapCodexQuota', () => {
  it('maps primary/secondary windows to the common limit shape', () => {
    const quota = mapCodexQuota(SAMPLE_RATE_LIMITS, '2026-01-02T00:00:00Z', { now: SAMPLE_NOW });
    expect(quota).toMatchObject({ family: 'codex', supported: true, plan: 'pro', approximate: true });
    expect(quota.limits).toHaveLength(2);
    expect(quota.limits[0]).toMatchObject({ key: 'session', label: 'Current 5h window', percentUsed: 7, percentRemaining: 93 });
    expect(quota.limits[1]).toMatchObject({ key: 'week', label: 'Current week', percentUsed: 26, percentRemaining: 74 });
    expect(quota.limits[0].resetsAt).toBe(new Date(1767225600 * 1000).toISOString());
    expect(quota.note).toContain('2026-01-02T00:00:00Z');
    expect(quota.error).toBeUndefined();
  });

  it('renders a fully-spent window as a 100%-used meter, not an empty card', () => {
    const spent = { ...SAMPLE_RATE_LIMITS, primary: null, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1767830400 } };
    const quota = mapCodexQuota(spent, '2026-01-02T00:00:00Z', { now: SAMPLE_NOW });
    expect(quota.limits).toHaveLength(1);
    expect(quota.limits[0]).toMatchObject({ key: 'week', percentUsed: 100, percentRemaining: 0 });
    expect(quota.error).toBeUndefined();
  });

  it('omits windows with no usable used_percent', () => {
    const quota = mapCodexQuota({ primary: { used_percent: 50, window_minutes: 300 }, secondary: null, plan_type: null }, null, { now: SAMPLE_NOW });
    expect(quota.limits).toHaveLength(1);
    expect(quota.plan).toBe('unknown');
  });

  it('drops a window whose reset has already passed', () => {
    const quota = mapCodexQuota(SAMPLE_RATE_LIMITS, null, { now: Date.parse('2026-01-05T00:00:00Z') });
    expect(quota.limits.map((l) => l.key)).toEqual(['week']); // 5h window reset on the 1st
  });

  it('explains a window-less credits payload instead of leaving the card blank', () => {
    const quota = mapCodexQuota(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T00:30:00Z', { now: SAMPLE_NOW });
    expect(quota.limits).toHaveLength(0);
    expect(quota.error).toContain('credit balance 0');
    expect(quota.error).toContain('premium');
  });

  it('names the reached limit type when the payload reports one', () => {
    const quota = mapCodexQuota({ ...CREDITS_ONLY_RATE_LIMITS, rate_limit_reached_type: 'weekly' }, null, { now: SAMPLE_NOW });
    expect(quota.error).toContain('weekly');
  });

  it('says the windows have reset when every reported window expired', () => {
    const quota = mapCodexQuota(SAMPLE_RATE_LIMITS, null, { now: Date.parse('2026-02-01T00:00:00Z') });
    expect(quota.limits).toHaveLength(0);
    expect(quota.error).toContain('has since reset');
  });
});

describe('fetchCodexQuota', () => {
  // Codex lays sessions out as sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl.
  const writeSession = async (codexHome, { day, name, lines }) => {
    const dir = join(codexHome, 'sessions', ...day.split('-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `rollout-${name}.jsonl`), `${lines.join('\n')}\n`);
  };

  let codexHome;
  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'portos-codex-usage-'));
  });
  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  const NOW = Date.parse('2026-01-01T06:00:00Z');
  const liveWindow = (usedPercent) => ({
    limit_id: 'codex',
    primary: null,
    secondary: { used_percent: usedPercent, window_minutes: 10080, resets_at: NOW / 1000 + 86400 },
    plan_type: 'pro'
  });

  it('reports the spent meter from an older SESSION when the newest one has no windows', async () => {
    // The reported bug end to end: the last session Codex ran only reported its
    // window-less credits bucket, so the exhausted weekly meter recorded by the
    // session before it went missing and the card read as "nothing to report".
    await writeSession(codexHome, { day: '2026-01-01', name: '2026-01-01T04-00-00-aaa', lines: [codexLine(liveWindow(100), '2026-01-01T04:00:00Z')] });
    await writeSession(codexHome, { day: '2026-01-01', name: '2026-01-01T05-00-00-bbb', lines: [codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T05:00:00Z')] });

    const quota = await fetchCodexQuota({ codexHome, now: NOW });
    expect(quota.limits).toHaveLength(1);
    expect(quota.limits[0]).toMatchObject({ key: 'week', percentUsed: 100 });
    expect(quota.note).toContain('2026-01-01T04:00:00Z');
    expect(quota.error).toBeUndefined();
  });

  it('explains itself when no session anywhere reports a window', async () => {
    await writeSession(codexHome, { day: '2026-01-01', name: '2026-01-01T05-00-00-bbb', lines: [codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T05:00:00Z')] });

    const quota = await fetchCodexQuota({ codexHome, now: NOW });
    expect(quota.limits).toHaveLength(0);
    expect(quota.error).toContain('credit balance 0');
    expect(quota.note).toContain('2026-01-01T05:00:00Z'); // the reading's age still travels
  });

  it('stops reading sessions older than the longest window once it has a fallback', async () => {
    // Nothing that old can hold an unexpired meter, so re-reading it every poll
    // is pure cost — this adapter has no cache to absorb it.
    await writeSession(codexHome, { day: '2025-12-01', name: '2025-12-01T05-00-00-ccc', lines: [codexLine(liveWindow(42), '2025-12-01T05:00:00Z')] });
    await writeSession(codexHome, { day: '2026-01-01', name: '2026-01-01T05-00-00-bbb', lines: [codexLine(CREDITS_ONLY_RATE_LIMITS, '2026-01-01T05:00:00Z')] });

    const quota = await fetchCodexQuota({ codexHome, now: NOW });
    expect(quota.limits).toHaveLength(0); // the month-old session was never opened
    expect(quota.note).toContain('2026-01-01T05:00:00Z');
  });

  it('says to run Codex once when there are no session logs at all', async () => {
    const quota = await fetchCodexQuota({ codexHome, now: NOW });
    expect(quota).toMatchObject({ family: 'codex', supported: true, limits: [] });
    expect(quota.error).toContain('No Codex session logs found');
  });
});

describe('resolveEnabledFamilies', () => {
  const providers = [
    { id: 'claude-code', enabled: true, type: 'cli', command: 'claude' },
    { id: 'claude-code-tui', enabled: true, type: 'tui', command: 'claude' },
    { id: 'claude-ollama', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true },
    { id: 'claude-mtplx', enabled: true, type: 'cli', command: 'claude', mtplxBacked: true },
    { id: 'codex', enabled: true, type: 'cli', command: 'codex' },
    { id: 'antigravity-cli', enabled: false, type: 'cli', command: 'agy' },
    { id: 'grok', enabled: true, type: 'api', endpoint: 'https://api.x.ai/v1' },
    { id: 'ollama', enabled: true, type: 'api', endpoint: 'http://localhost:11434/v1' }
  ];

  it('dedupes CLI+TUI variants into one family and skips disabled providers', () => {
    const families = resolveEnabledFamilies(providers).map((f) => f.id);
    expect(families).toEqual(['claude', 'codex', 'grok']); // agy disabled; ollama maps to no family
  });

  it('does not map local-runtime wrappers to ANY family (local models have no subscription quota)', () => {
    const families = resolveEnabledFamilies([
      { id: 'claude-ollama', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true },
      { id: 'codex-ollama', enabled: true, type: 'cli', command: 'codex', ollamaBacked: true },
      { id: 'grok-ollama', enabled: true, type: 'cli', command: 'grok', ollamaBacked: true },
      { id: 'claude-mtplx', enabled: true, type: 'cli', command: 'claude', mtplxBacked: true },
      { id: 'codex-mtplx', enabled: true, type: 'cli', command: 'codex', mtplxBacked: true },
      { id: 'grok-mtplx', enabled: true, type: 'cli', command: 'grok', mtplxBacked: true }
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
  // The TUI-scrape cache and the mock call counts both outlive a single test —
  // reset so the per-family assertions below aren't order-dependent.
  beforeEach(() => {
    __resetUsageScrapeCache();
    scrapeTuiUsage.mockReset();
    getImageGenQuota.mockClear();
  });

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

  it('adds an image-gen card when a cloud image backend is enabled', async () => {
    // Antigravity's /usage panel reports only its token groups — the imagen
    // backend that renders the pixels has no row there, so the image card is
    // derived from observed renders instead (see imageGenQuota.js).
    getAllProviders.mockResolvedValueOnce({ activeProvider: null, providers: [] });
    getSettings.mockResolvedValueOnce({ imageGen: { agy: { enabled: true }, local: { enabled: true } } });
    const quotas = await getProviderQuotas();
    expect(quotas.map((q) => q.family)).toEqual(['imagegen']);
    // Only the cloud backend is tracked — local renders spend no remote quota.
    expect(getImageGenQuota).toHaveBeenCalledWith({ enabledModes: ['agy'] });
  });

  it('omits the image-gen card entirely when only local image gen is on', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: null, providers: [] });
    getSettings.mockResolvedValueOnce({ imageGen: { local: { enabled: true } } });
    expect(await getProviderQuotas()).toEqual([]);
  });

  it('reads only the requested family — the point of the per-card refresh', async () => {
    // A second family's reading is a second multi-second TUI spawn, so asking
    // for one card must not scrape the other (nor derive the image card).
    getAllProviders.mockResolvedValueOnce({
      activeProvider: null,
      providers: [
        { id: 'grok', enabled: true, type: 'tui', command: 'grok' },
        { id: 'agy', enabled: true, type: 'tui', command: 'agy' }
      ]
    });
    getSettings.mockResolvedValueOnce({ imageGen: { agy: { enabled: true } } });
    scrapeTuiUsage.mockResolvedValue('Weekly limit: 5% Next reset: Jan 1, 00:00');
    const quotas = await getProviderQuotas({ family: 'grok' });
    expect(quotas.map((q) => q.family)).toEqual(['grok']);
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(1);
    expect(getImageGenQuota).not.toHaveBeenCalled();
  });

  it('reads the image-gen card alone when it is the requested family', async () => {
    getAllProviders.mockResolvedValueOnce({
      activeProvider: null,
      providers: [{ id: 'grok', enabled: true, type: 'tui', command: 'grok' }]
    });
    getSettings.mockResolvedValueOnce({ imageGen: { agy: { enabled: true } } });
    const quotas = await getProviderQuotas({ family: 'imagegen' });
    expect(quotas.map((q) => q.family)).toEqual(['imagegen']);
    expect(scrapeTuiUsage).not.toHaveBeenCalled();
  });

  it('returns nothing for a family that is no longer enabled', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: null, providers: [] });
    expect(await getProviderQuotas({ family: 'grok' })).toEqual([]);
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

  it('still parses pre-1.1.x panels that end window rows in bare "Limit"', () => {
    // agy renamed "Weekly Limit" → "Weekly Limit Remaining"; older binaries still
    // emit the bare form, and both must produce the same keys/labels.
    const { limits, groups } = parseAgyUsage(AGY_PANEL_LEGACY, { now: NOW });
    expect(groups).toBe(2);
    expect(limits).toHaveLength(4);
    expect(limits.map((l) => l.key).sort()).toEqual([
      'claude-gpt-5-hour', 'claude-gpt-weekly', 'gemini-5-hour', 'gemini-weekly',
    ]);
    expect(limits.find((l) => l.key === 'gemini-weekly')).toMatchObject({
      label: 'Gemini · Weekly', percentUsed: 1, percentRemaining: 99,
    });
  });

  it('keeps used + remaining summing to 100 on half-percent values', () => {
    // 98.50% remaining rounds to used 2 / left 99 = 101% if rounded independently.
    const panel = AGY_PANEL.replace('98.99%', '98.50%').replace('99% remaining', '98% remaining');
    const gemWeek = parseAgyUsage(panel, { now: NOW }).limits.find((l) => l.key === 'gemini-weekly');
    expect(gemWeek.percentUsed + gemWeek.percentRemaining).toBe(100);
    expect(gemWeek).toMatchObject({ percentUsed: 2, percentRemaining: 98 });
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

  it('dedups repainted frames to one row per key (no duplicate React keys)', () => {
    // The append-only PTY buffer can contain the panel twice if the TUI
    // repaints; latest-wins so keys stay unique and the newer value survives.
    const repainted = AGY_PANEL + '\n' + AGY_PANEL.replace('98.99%', '55.00%').replace('99% remaining', '55% remaining');
    const { limits } = parseAgyUsage(repainted, { now: NOW });
    expect(limits).toHaveLength(4);
    expect(new Set(limits.map((l) => l.key)).size).toBe(4);
    expect(limits.find((l) => l.key === 'gemini-weekly').percentRemaining).toBe(55); // newest frame won
  });
});

describe('parseGrokUsage', () => {
  // The panel's `Next reset` states no year and no zone, so it resolves against
  // an injected `now` + the zone the fetcher forced on the child.
  const opts = { now: Date.parse('2026-07-26T12:00:00.000Z'), timezone: 'UTC' };

  it('reads the weekly limit as percent USED and normalizes the reset to ISO', () => {
    const { limits } = parseGrokUsage(GROK_PANEL, opts);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ key: 'weekly', label: 'Weekly', percentUsed: 42, percentRemaining: 58, resetsAt: '2026-08-01T06:07:00.000Z' });
  });

  it('returns no limits when the panel has no weekly-limit line', () => {
    expect(parseGrokUsage('Grok Build Beta  0.2.101', opts).limits).toEqual([]);
    expect(parseGrokUsage(undefined, opts).limits).toEqual([]);
  });

  it('takes the freshest (last) frame when the panel is repainted', () => {
    const repainted = 'Weekly limit: 10% Next reset: July 1, 00:00\nWeekly limit: 73% Next reset: August 1, 06:07';
    const { limits } = parseGrokUsage(repainted, opts);
    expect(limits[0]).toMatchObject({ percentUsed: 73, percentRemaining: 27, resetsAt: '2026-08-01T06:07:00.000Z' });
  });

  it('emits a null reset rather than a raw string when the panel states none', () => {
    expect(parseGrokUsage('Weekly limit: 42%', opts).limits[0]).toMatchObject({ percentUsed: 42, resetsAt: null });
  });

  it('parses a Monthly window and both windows when present', () => {
    expect(parseGrokUsage('Monthly limit: 30% Next reset: Sep 1', opts).limits[0])
      .toMatchObject({ key: 'monthly', label: 'Monthly', scope: 'month', percentUsed: 30, percentRemaining: 70 });
    const both = parseGrokUsage('Weekly limit: 12% Monthly limit: 45% Next reset: Sep 1', opts).limits;
    expect(both.map((l) => l.key).sort()).toEqual(['monthly', 'weekly']);
  });

  it('parses multi-line Grok 1.0 TUI panel with plan descriptor and Resets: header', () => {
    const boxPanel = `
      Weekly limit (SuperGrok)│
      ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░8%│
      Resets: August 1, 06:07│
    `;
    const { limits } = parseGrokUsage(boxPanel, opts);
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      key: 'weekly',
      label: 'Weekly',
      percentUsed: 8,
      percentRemaining: 92,
      resetsAt: '2026-08-01T06:07:00.000Z',
    });
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

  it('forwards a TUI provider\'s interactive args but drops a CLI provider\'s headless args', async () => {
    // TUI provider: args are interactive → forwarded.
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [
      { id: 'grok-tui', enabled: true, type: 'tui', command: 'grok', args: ['--project', 'p1'] },
    ] });
    scrapeTuiUsage.mockResolvedValueOnce('Weekly limit: 5% Next reset: Jan 1');
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ command: 'grok', args: ['--project', 'p1'] }));

    __resetUsageScrapeCache();
    scrapeTuiUsage.mockReset();
    // CLI provider: args are headless one-shot flags → dropped.
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [
      { id: 'grok-cli', enabled: true, type: 'cli', command: 'grok', args: ['--prompt-file', '/dev/stdin'] },
    ] });
    scrapeTuiUsage.mockResolvedValueOnce('Weekly limit: 5% Next reset: Jan 1');
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ command: 'grok', args: [] }));
  });

  it('prefers a TUI provider over a CLI provider when both are enabled', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [
      { id: 'grok-cli', enabled: true, type: 'cli', command: 'grok', args: ['-p'] },
      { id: 'grok-tui', enabled: true, type: 'tui', command: 'grok', args: ['--project', 'p1'] },
    ] });
    scrapeTuiUsage.mockResolvedValueOnce('Weekly limit: 5% Next reset: Jan 1');
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ args: ['--project', 'p1'] }));
  });

  it('passes the machine timezone into the scrape env when resolved', async () => {
    systemTimeZone.mockReturnValueOnce('America/New_York');
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'grok', providers: [{ id: 'grok-tui', enabled: true, type: 'tui', command: 'grok' }] });
    scrapeTuiUsage.mockResolvedValueOnce('Weekly limit: 5% Next reset: Jan 1');
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ TZ: 'America/New_York' }) }));
  });

  it('re-scrapes (does not serve a stale cache entry) when the provider config changes', async () => {
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy', envVars: { ACCT: 'a' } }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    await getProviderQuotas();
    // Same family, different account (envVars) → different cache key → fresh scrape.
    getAllProviders.mockResolvedValueOnce({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy', envVars: { ACCT: 'b' } }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    await getProviderQuotas();
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(2);
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
    await getProviderQuotas({ wait: 'fresh' }); // bypasses cache
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(2);
  });

  // A scrape is a multi-second PTY spawn. Blocking on the TTL lapse is what made
  // the Quota Burn / Usage pages take ~7s to open after a few idle minutes.
  it('serves a STALE reading without waiting on the revalidating scrape', async () => {
    vi.useFakeTimers();
    getAllProviders.mockResolvedValue({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    const [first] = await getProviderQuotas();

    // Past the 5-minute TTL, with a scrape that never settles: a blocking cache
    // would hang here forever. Stale-while-revalidate answers immediately.
    vi.advanceTimersByTime(6 * 60 * 1000);
    scrapeTuiUsage.mockReturnValueOnce(new Promise(() => {}));
    const [stale] = await getProviderQuotas();
    expect(stale.fetchedAt).toBe(first.fetchedAt); // the honest age of what we served
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(2); // …and the refresh did start
    vi.useRealTimers();
  });

  // The cold case a stale value can't cover: nothing cached at all, e.g. the
  // first page load after a server restart.
  it("returns a pending card instead of blocking on a COLD cache under wait:'never'", async () => {
    getAllProviders.mockResolvedValue({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    let release;
    scrapeTuiUsage.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const [pending] = await getProviderQuotas({ wait: 'never' });
    expect(pending).toMatchObject({ family: 'agy', supported: true, pending: true, limits: [] });

    // The scrape was STARTED, not skipped — once it lands the next read is real.
    release(AGY_PANEL);
    await vi.waitFor(async () => {
      const [card] = await getProviderQuotas({ wait: 'never' });
      expect(card.pending).toBeUndefined();
      expect(card.limits).toHaveLength(4);
    });
    expect(scrapeTuiUsage).toHaveBeenCalledTimes(1);
  });

  it("blocks for a real reading under the default wait and under wait:'fresh'", async () => {
    getAllProviders.mockResolvedValue({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    const [card] = await getProviderQuotas(); // default 'cached': cold ⇒ waits
    expect(card.pending).toBeUndefined();
    expect(card.limits).toHaveLength(4);

    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    const [refreshed] = await getProviderQuotas({ wait: 'fresh' });
    expect(refreshed.pending).toBeUndefined();
    expect(refreshed.limits).toHaveLength(4);
  });

  it('keeps the last good reading when a background revalidation fails', async () => {
    vi.useFakeTimers();
    getAllProviders.mockResolvedValue({ activeProvider: 'agy', providers: [{ id: 'antigravity-cli', enabled: true, type: 'cli', command: 'agy' }] });
    scrapeTuiUsage.mockResolvedValueOnce(AGY_PANEL);
    const [first] = await getProviderQuotas();

    vi.advanceTimersByTime(6 * 60 * 1000);
    scrapeTuiUsage.mockRejectedValueOnce(new Error('pty spawn failed'));
    const [served] = await getProviderQuotas();
    expect(served.limits).toHaveLength(4); // stale, not an error card
    await vi.advanceTimersByTimeAsync(0); // let the failed revalidation settle

    // A transient PTY hiccup must not evict the entry and force the next caller
    // to block on a full scrape.
    scrapeTuiUsage.mockReturnValueOnce(new Promise(() => {}));
    const [afterFailure] = await getProviderQuotas();
    expect(afterFailure.fetchedAt).toBe(first.fetchedAt);
    vi.useRealTimers();
  });
});
