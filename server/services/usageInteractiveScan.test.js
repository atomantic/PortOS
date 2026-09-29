import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-interactive-usage-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const applied = [];
vi.mock('./usage.js', () => ({
  applyHistoricalUsageCorrections: vi.fn(async (corrections) => { applied.push(...corrections); return { corrected: corrections.length, correctedRunIds: [] }; }),
  forgetSiblingReconciledUsageRuns: vi.fn(async () => {})
}));
afterAll(cleanup);

const { refreshInteractiveUsage, INTERACTIVE_SCAN_FILE } = await import('./usageInteractiveScan.js');

const GROK = { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: 'example-grok-model' };
const AGY = { id: 'antigravity-cli', type: 'cli', command: 'agy', enabled: true, defaultModel: 'example-agy-model' };
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
});
