import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-interactive-usage-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const applied = [];
// Stand-in for usage.json's `interactiveScan`: a commit lands only when the mocked save succeeds.
const ledger = vi.hoisted(() => ({ scan: null, failStateSave: false }));
vi.mock('./usage.js', () => ({
  applyHistoricalUsageCorrections: vi.fn(async (corrections, { interactiveScan = null } = {}) => {
    applied.push(...corrections);
    if (interactiveScan) ledger.scan = structuredClone(interactiveScan);
    return { corrected: corrections.length, correctedRunIds: [] };
  }),
  forgetSiblingReconciledUsageRuns: vi.fn(async () => {}),
  getInteractiveScanState: vi.fn(async () => (ledger.scan ? structuredClone(ledger.scan) : null)),
  setInteractiveScanState: vi.fn(async (state) => {
    if (ledger.failStateSave) throw new Error('simulated usage.json write failure');
    ledger.scan = structuredClone(state);
  })
}));
afterAll(cleanup);

const { refreshInteractiveUsage, INTERACTIVE_SCAN_FILE } = await import('./usageInteractiveScan.js');

const GROK = { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: 'example-grok-model' };
const AGY = { id: 'antigravity-cli', type: 'cli', command: 'agy', enabled: true, defaultModel: 'example-agy-model' };
const CODEX = { id: 'codex-cli', type: 'cli', command: 'codex', enabled: true, defaultModel: 'example-codex-model' };
const CLAUDE = { id: 'claude-code', type: 'cli', command: 'claude', enabled: true, defaultModel: 'example-claude-model' };
// Real time: a file's birth time can't be faked, and the scan prunes on it.
const NOW = Date.now();
const HOUR = 3_600_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// Within the day before the file was created: the scan prunes on birth time (minus a day).
const P1 = NOW - 20 * HOUR;
const P2 = NOW - HOUR;
const P3 = NOW - HOUR + 5 * 60_000;
const CWD = '/example/workspace';

// Input varies per turn so the stream is not (accidentally) monotonic, which the parser reads as cumulative.
const grokTurn = (promptId, ms, output, input = 1000) => JSON.stringify({
  timestamp: Math.round(ms / 1000),
  params: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: promptId,
      usage: { inputTokens: input, outputTokens: output, cachedReadTokens: 400, modelUsage: { 'example-grok-model': {} } }
    },
    _meta: { agentTimestampMs: ms }
  }
});

describe('refreshInteractiveUsage', () => {
  let home;
  let runsDir;
  beforeEach(async () => {
    applied.length = 0;
    ledger.scan = null;
    ledger.failStateSave = false;
    home = await mkdtemp(join(tmpdir(), 'interactive-home-'));
    runsDir = await mkdtemp(join(tmpdir(), 'interactive-runs-'));
    await rm(INTERACTIVE_SCAN_FILE, { force: true });
    const dir = join(home, '.grok', 'sessions', encodeURIComponent(CWD), 'session-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'updates.jsonl'), [
      grokTurn('p1', P1, 100),
      grokTurn('p2', P2, 200, 800),
      grokTurn('p3', P3, 400, 900)
    ].join('\n'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(runsDir, { recursive: true, force: true });
  });

  it('bills terminal sessions per UTC day, outside PortOS run windows, exactly once', async () => {
    // A PortOS run covers p3 in this cwd: the run path owns it, so the scan must not.
    const runDir = join(runsDir, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'metadata.json'), JSON.stringify({
      workspacePath: CWD, startTime: new Date(P3 - 60_000).toISOString(), endTime: new Date(P3 + 60_000).toISOString()
    }));

    const first = await refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW });
    // Per turn: 600 fresh in (1000 - 400 cached) + 400 cache read + output.
    expect(first.families.grok.tokens).toBe((600 + 400 + 100) + (400 + 400 + 200));
    const byDay = Object.fromEntries(applied.map((c) => [c.day, c.siblings[0]]));
    expect(applied.every((c) => [dayOf(P1), dayOf(P2)].includes(c.day))).toBe(true);
    // p1 and p2 share a UTC day when the suite runs after 20:00 UTC, so read the
    // total across days instead of assuming the first day holds p1 alone.
    expect(Object.values(byDay).every((r) => r.providerId === 'grok-cli' && r.source === 'measured')).toBe(true);
    expect(Object.values(byDay).reduce((sum, r) => sum + r.cacheReadTokens, 0)).toBe(800);
    // p3 fell inside the run window, so the scan bills only p2 (and p1) — never p3's 400.
    expect(Object.values(byDay).reduce((sum, r) => sum + r.tokensOut, 0)).toBe(300);

    applied.length = 0;
    await refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW + 60_000 });
    expect(applied).toEqual([]);
  });

  it('leaves a family with no provider unbilled and its watermark unmoved', async () => {
    const summary = await refreshInteractiveUsage({ home, runsDir, providers: [], now: NOW });
    expect(summary.families).toEqual({});
    await refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW });
    expect(applied.length).toBeGreaterThan(0);
  });

  it('estimates Antigravity from the transcript, replayed context as cache reads', async () => {
    const root = join(home, '.gemini', 'antigravity-cli');
    const logs = join(root, 'brain', 'conv-1', '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(root, 'history.jsonl'), JSON.stringify({ timestamp: NOW, workspace: CWD, conversationId: 'conv-1' }));
    const step = (i, type, at, content) => JSON.stringify({ step_index: i, type, created_at: at, content });
    await writeFile(join(logs, 'transcript.jsonl'), [
      step(0, 'USER_INPUT', new Date(NOW - 2 * HOUR).toISOString(), 'u'.repeat(400)),
      step(1, 'PLANNER_RESPONSE', new Date(NOW - 2 * HOUR + 60_000).toISOString(), 'p'.repeat(200))
    ].join('\n'));

    await refreshInteractiveUsage({ home, runsDir, providers: [AGY], now: NOW });
    const record = applied.find((c) => c.providerId === 'antigravity-cli').siblings[0];
    expect(record).toMatchObject({ source: 'estimate', tokensIn: 100, tokensOut: 50, cacheReadTokens: 100, model: 'example-agy-model' });
  });

  it('bills an Antigravity conversation that history.jsonl never logged', async () => {
    const root = join(home, '.gemini', 'antigravity-cli');
    const logs = join(root, 'brain', 'orphan-1', '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(root, 'history.jsonl'), JSON.stringify({ display: '/usage', timestamp: NOW, workspace: CWD, type: 'slash_command' }));
    const step = (i, type, at, content) => JSON.stringify({ step_index: i, type, created_at: at, content });
    await writeFile(join(logs, 'transcript.jsonl'), [
      step(0, 'USER_INPUT', new Date(NOW - 2 * HOUR).toISOString(), 'u'.repeat(400)),
      step(1, 'PLANNER_RESPONSE', new Date(NOW - 2 * HOUR + 60_000).toISOString(), 'p'.repeat(200))
    ].join('\n'));

    await refreshInteractiveUsage({ home, runsDir, providers: [AGY], now: NOW });
    const record = applied.find((c) => c.providerId === 'antigravity-cli').siblings[0];
    expect(record).toMatchObject({ source: 'estimate', tokensIn: 100, tokensOut: 50 });
  });

  // A rollout's token totals are cumulative, so the run-owned tail must not
  // leak into the terminal slice and the terminal head must not be lost.
  it('bills a terminal Codex rollout up to a PortOS run window, not past it', async () => {
    const runDir = join(runsDir, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'metadata.json'), JSON.stringify({
      workspacePath: CWD, startTime: new Date(P3 - 60_000).toISOString(), endTime: new Date(P3 + 60_000).toISOString()
    }));
    const dir = join(home, '.codex', 'sessions', '2026', '10', '22');
    await mkdir(dir, { recursive: true });
    const snapshot = (ms, input, cached, output) => JSON.stringify({
      timestamp: new Date(ms).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } }
    });
    await writeFile(join(dir, 'rollout-1.jsonl'), [
      JSON.stringify({ timestamp: new Date(P2 - 60_000).toISOString(), type: 'session_meta', payload: { id: 'r1', cwd: CWD, model: 'example-codex-model' } }),
      snapshot(P2, 1000, 400, 100),
      snapshot(P3, 3000, 1000, 500)
    ].join('\n'));

    const summary = await refreshInteractiveUsage({ home, runsDir, providers: [CODEX], now: NOW });
    expect(summary.families.codex.tokens).toBe(600 + 400 + 100);
    const records = applied.filter((c) => c.providerId === 'codex-cli').map((c) => c.siblings[0]);
    expect(records.every((r) => r.source === 'measured')).toBe(true);
    expect(records.reduce((sum, r) => sum + r.tokensOut, 0)).toBe(100);
  });

  // A resumed Claude Code session replays earlier messages into a new file
  // under their original ids; they are billed once.
  it('bills terminal Claude Code sessions once across resumed transcripts', async () => {
    const dir = join(home, '.claude', 'projects', '-example-workspace');
    await mkdir(join(dir, 'subagents'), { recursive: true });
    const line = (id, ms, output) => JSON.stringify({
      type: 'assistant', timestamp: new Date(ms).toISOString(), cwd: CWD, requestId: `req-${id}`,
      message: { id, model: 'example-claude-model', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    });
    await writeFile(join(dir, 'a.jsonl'), line('m1', P2, 100));
    await writeFile(join(dir, 'subagents', 'b.jsonl'), [line('m1', P2, 100), line('m2', P2 + 60_000, 50)].join('\n'));

    await refreshInteractiveUsage({ home, runsDir, providers: [CLAUDE], now: NOW });
    const records = applied.filter((c) => c.providerId === 'claude-code').map((c) => c.siblings[0]);
    expect(records.reduce((sum, r) => sum + r.tokensOut, 0)).toBe(150);
    expect(records.reduce((sum, r) => sum + r.tokensIn, 0)).toBe(20);
  });

  it('bills subagent turns inside a run reconciled before the sidechain fix, once, and leaves later runs alone', async () => {
    const dir = join(home, '.claude', 'projects', '-example-workspace', 'sess-1', 'subagents');
    await mkdir(dir, { recursive: true });
    const line = (id, ms, output) => JSON.stringify({
      type: 'assistant', timestamp: new Date(ms).toISOString(), cwd: CWD, requestId: `req-${id}`,
      message: { id, model: 'example-claude-model', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    });
    const SETTLED = NOW - 10 * HOUR;
    const LATER = NOW - 2 * HOUR;
    await writeFile(join(dir, 'agent-1.jsonl'), [line('old', SETTLED, 300), line('new', LATER, 700)].join('\n'));
    const writeRun = async (name, at, reconciledAt) => {
      await mkdir(join(runsDir, name), { recursive: true });
      await writeFile(join(runsDir, name, 'metadata.json'), JSON.stringify({
        workspacePath: CWD, startTime: new Date(at - 60_000).toISOString(), endTime: new Date(at + 60_000).toISOString(),
        usageReconciled: true, usageReconciledAt: new Date(reconciledAt).toISOString()
      }));
    };
    await writeRun('settled', SETTLED, NOW - 9 * HOUR);
    // Reconciled after this process started, so the fixed run path already billed its sidechains.
    await writeRun('fixed', LATER, NOW + HOUR);

    const first = await refreshInteractiveUsage({ home, runsDir, providers: [CLAUDE], now: NOW });
    expect(first.sidechainRepair.tokensOut).toBe(300);
    const second = await refreshInteractiveUsage({ home, runsDir, providers: [CLAUDE], now: NOW + 10 * 60_000 });
    expect(second.sidechainRepair).toBeUndefined();
  });

  const billedOut = () => applied.reduce((sum, c) => sum + c.siblings.reduce((n, r) => n + r.tokensOut, 0), 0);

  it('does not re-bill a committed family when a later family fails mid-scan', async () => {
    ledger.failStateSave = true;
    await expect(refreshInteractiveUsage({ home, runsDir, providers: [GROK, AGY], now: NOW })).rejects.toThrow(/simulated/);
    expect(billedOut()).toBe(700);

    // Restart: the same fixtures, the grok watermark already committed with its counts.
    ledger.failStateSave = false;
    applied.length = 0;
    await refreshInteractiveUsage({ home, runsDir, providers: [GROK, AGY], now: NOW + 60_000 });
    expect(applied.filter((c) => c.providerId === 'grok-cli')).toEqual([]);
  });

  it('keeps the watermark in the ledger and never writes the legacy scan file', async () => {
    await refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW });
    expect(ledger.scan.watermarks.grok).toBe(NOW - 5 * 60_000);
    await expect(access(INTERACTIVE_SCAN_FILE)).rejects.toThrow();
  });

  it('does not repeat the sidechain repair after its commit, even with a later process start', async () => {
    const dir = join(home, '.claude', 'projects', '-example-workspace', 'sess-1', 'subagents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'agent-1.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: new Date(NOW - 10 * HOUR).toISOString(), cwd: CWD, requestId: 'req-old',
      message: { id: 'old', model: 'example-claude-model', usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    }));
    await mkdir(join(runsDir, 'settled'), { recursive: true });
    await writeFile(join(runsDir, 'settled', 'metadata.json'), JSON.stringify({
      workspacePath: CWD, startTime: new Date(NOW - 10 * HOUR - 60_000).toISOString(), endTime: new Date(NOW - 10 * HOUR + 60_000).toISOString(),
      usageReconciled: true, usageReconciledAt: new Date(NOW - 9 * HOUR).toISOString()
    }));
    const first = await refreshInteractiveUsage({ home, runsDir, providers: [CLAUDE], now: NOW });
    expect(first.sidechainRepair.tokensOut).toBe(300);

    // Restarted process: the cutoff moves to the new boot, which would re-settle the run.
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(1);
    try {
      const second = await refreshInteractiveUsage({ home, runsDir, providers: [CLAUDE], now: NOW + 10 * 60_000 });
      expect(second.sidechainRepair).toBeUndefined();
    } finally {
      uptime.mockRestore();
    }
  });

  it('adopts the legacy scan file once, and fails the scan when it is damaged', async () => {
    await writeFile(INTERACTIVE_SCAN_FILE, JSON.stringify({ watermarks: { grok: NOW - 5 * 60_000 }, sidechainRepairedAt: 'x' }));
    await refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW });
    expect(applied).toEqual([]);

    ledger.scan = null;
    await writeFile(INTERACTIVE_SCAN_FILE, '{not-json');
    await expect(refreshInteractiveUsage({ home, runsDir, providers: [GROK], now: NOW })).rejects.toThrow();
  });
});
