import { describe, it, expect, vi } from 'vitest';

// providerUsage imports the provider config service (toolkit-backed) and the
// claude CLI wrapper — mock both so this suite stays hermetic.
vi.mock('./providers.js', () => ({
  getAllProviders: vi.fn().mockResolvedValue([])
}));
vi.mock('./claudeCodeUsage.js', () => ({
  getClaudeCodeUsage: vi.fn()
}));

import { parseCodexRateLimits, mapCodexQuota, resolveEnabledFamilies } from './providerUsage.js';

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

  it('does not map ollama-backed claude wrappers to the claude family', () => {
    const families = resolveEnabledFamilies([
      { id: 'claude-ollama', enabled: true, type: 'cli', command: 'claude', ollamaBacked: true }
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
