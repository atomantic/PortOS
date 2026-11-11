import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./codexUsageSources.js', async () => {
  const actual = await vi.importActual('./codexUsageSources.js');
  return { ...actual, readCodexAccountingSources: vi.fn() };
});

const { readCodexAccountingSources, codexSessionClaimKey } = await import('./codexUsageSources.js');
const { codexUsageProviderIdFromList, planCodexSpeedRepair } = await import('./codexSpeedRepair.js');

const sessionId = 'hashed-session';
const priorityRollout = [
  { type: 'session_meta', payload: { id: 'raw-session', cwd: '/example/workspace', model: 'gpt-5.3-codex' } },
  { timestamp: '2026-07-01T10:00:00.000Z', payload: { type: 'thread_settings_applied', service_tier: 'priority' } },
  { timestamp: '2026-07-01T10:01:00.000Z', payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100,
  } } } },
];

function inventory(sessions, issues = {}) {
  return { sessions, coverage: { issues } };
}

beforeEach(() => {
  readCodexAccountingSources.mockReset();
});

describe('planCodexSpeedRepair', () => {
  it('adds the covered fast subset a legacy high-water never stored, and not the base tokens', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([{
      id: sessionId,
      paths: [],
      loadRecords: async () => priorityRollout,
    }]));
    const plan = await planCodexSpeedRepair({
      reconciledRuns: {
        run: { codexHighWater: [[codexSessionClaimKey(sessionId), {
          messages: 1, tokensIn: 1000, tokensOut: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
        }]] },
      },
    });
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0].repairId).toBe(`codex-speed:v1:${sessionId}`);
    expect(plan.additions[0].day).toBe('2026-07-01');
    expect(plan.additions[0].record).toMatchObject({
      messages: 0, fastTokensIn: 1000, fastTokensOut: 100, source: 'measured', model: 'gpt-5.3-codex',
    });
    expect(plan.additions[0].record.tokensIn).toBeUndefined();
    const again = await planCodexSpeedRepair({
      repairIds: [plan.additions[0].repairId],
      reconciledRuns: {
        run: { codexHighWater: [[codexSessionClaimKey(sessionId), {
          messages: 1, tokensIn: 1000, tokensOut: 100, fastTokensIn: 1000, fastTokensOut: 100,
        }]] },
      },
    });
    expect(again.additions).toEqual([]);
  });

  it('skips a session whose base tokens are not in the ledger', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([{
      id: sessionId, paths: [], loadRecords: async () => priorityRollout,
    }]));
    const plan = await planCodexSpeedRepair({ reconciledRuns: {} });
    expect(plan.additions).toEqual([]);
    expect(readCodexAccountingSources).toHaveBeenCalled();
  });

  it('notes a partial archive without marking unread sessions done', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([], { indexing_pending: 1 }));
    const plan = await planCodexSpeedRepair({});
    expect(plan.additions).toEqual([]);
    expect(plan.notes[0]).toMatch(/part of the session archive/);
    expect(readCodexAccountingSources).toHaveBeenCalledTimes(20);
  });
});

describe('codexUsageProviderIdFromList', () => {
  it('prefers an enabled CLI over a TUI', () => {
    expect(codexUsageProviderIdFromList([
      { id: 'codex-tui', type: 'tui', command: 'codex', enabled: true },
      { id: 'codex-cli', type: 'cli', command: 'codex', enabled: true },
    ])).toBe('codex-cli');
    expect(codexUsageProviderIdFromList([])).toBe('codex');
  });
});
