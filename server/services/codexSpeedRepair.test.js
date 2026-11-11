import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = '/tmp/portos-codex-speed-repair-test';
const { usage, addDatedUsageBatch } = vi.hoisted(() => {
  const usage = { grokRepairIds: [], reconciledRuns: {} };
  return {
    usage,
    addDatedUsageBatch: vi.fn(async (rows) => rows),
  };
});

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-codex-speed-repair-test' },
}));
vi.mock('./usage.js', () => ({
  loadUsage: vi.fn(async () => {}),
  getUsage: vi.fn(() => usage),
  addDatedUsageBatch,
}));
vi.mock('./codexUsageSources.js', async () => {
  const actual = await vi.importActual('./codexUsageSources.js');
  return { ...actual, readCodexAccountingSources: vi.fn() };
});

const { readCodexAccountingSources, codexSessionClaimKey } = await import('./codexUsageSources.js');
const { applyCodexSpeedRepair } = await import('./codexSpeedRepair.js');

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

beforeEach(async () => {
  usage.grokRepairIds = [];
  usage.reconciledRuns = {};
  addDatedUsageBatch.mockClear();
  readCodexAccountingSources.mockReset();
  await rm(dataDir, { recursive: true, force: true });
});

describe('applyCodexSpeedRepair', () => {
  it('adds the covered fast subset a legacy high-water never stored, and not the base tokens', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([{
      id: sessionId,
      paths: [],
      loadRecords: async () => priorityRollout,
    }]));
    usage.reconciledRuns = {
      run: { codexHighWater: [[codexSessionClaimKey(sessionId), {
        messages: 1, tokensIn: 1000, tokensOut: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      }]] },
    };
    const result = await applyCodexSpeedRepair();
    expect(result).toMatchObject({ added: 1, sessions: 1, backedUp: true, note: null });
    expect(addDatedUsageBatch).toHaveBeenCalledTimes(1);
    const [addition] = addDatedUsageBatch.mock.calls[0][0];
    expect(addition.repairId).toBe(`codex-speed:v1:${sessionId}`);
    expect(addition.day).toBe('2026-07-01');
    expect(addition.record).toMatchObject({
      providerId: 'codex', messages: 0, fastTokensIn: 1000, fastTokensOut: 100, source: 'measured', model: 'gpt-5.3-codex',
    });
    expect(addition.record.tokensIn).toBeUndefined();

    usage.grokRepairIds = [addition.repairId];
    usage.reconciledRuns = {
      run: { codexHighWater: [[codexSessionClaimKey(sessionId), {
        messages: 1, tokensIn: 1000, tokensOut: 100, fastTokensIn: 1000, fastTokensOut: 100,
      }]] },
    };
    addDatedUsageBatch.mockClear();
    const again = await applyCodexSpeedRepair();
    expect(again).toMatchObject({ added: 0, sessions: 0, backedUp: false });
    expect(addDatedUsageBatch).not.toHaveBeenCalled();
  });

  it('skips a session whose base tokens are not in the ledger', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([{
      id: sessionId, paths: [], loadRecords: async () => priorityRollout,
    }]));
    const result = await applyCodexSpeedRepair();
    expect(result).toMatchObject({ added: 0, sessions: 0, backedUp: false, backupDir: null });
    expect(addDatedUsageBatch).not.toHaveBeenCalled();
  });

  it('notes a partial archive without marking unread sessions done', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([], { indexing_pending: 1 }));
    const result = await applyCodexSpeedRepair();
    expect(result).toMatchObject({ added: 0, backedUp: false });
    expect(result.note).toMatch(/part of the session archive/);
    expect(readCodexAccountingSources).toHaveBeenCalledTimes(20);
    expect(addDatedUsageBatch).not.toHaveBeenCalled();
  });

  it('prefers an enabled CLI provider over a TUI', async () => {
    readCodexAccountingSources.mockResolvedValue(inventory([{
      id: sessionId, paths: [], loadRecords: async () => priorityRollout,
    }]));
    usage.reconciledRuns = {
      run: { codexHighWater: [[codexSessionClaimKey(sessionId), {
        messages: 1, tokensIn: 1000, tokensOut: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      }]] },
    };
    await applyCodexSpeedRepair({
      providers: [
        { id: 'codex-tui', type: 'tui', command: 'codex', enabled: true },
        { id: 'codex-cli', type: 'cli', command: 'codex', enabled: true },
      ],
    });
    expect(addDatedUsageBatch.mock.calls[0][0][0].record.providerId).toBe('codex-cli');
  });
});
