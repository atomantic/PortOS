import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __resetUsageClaims, readMeasuredUsage, snapshotUsageClaims } from './usageReconciler.js';
import { scanHistoricalUsage } from './usageBackfillWorker.js';

let root;
let home;
const workspace = '/work/example-repo';

const writeRun = async (id, metadata, output = 'estimated output') => {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, ...metadata }));
  await writeFile(join(dir, 'output.txt'), output);
};

const writeTranscript = async ({ id = 'message-1', timestamp = '2026-07-01T10:05:00.000Z', file = 'session-example.jsonl' } = {}) => {
  const dir = join(home, '.claude', 'projects', '-work-example-repo');
  await mkdir(dir, { recursive: true });
  const line = {
    type: 'assistant',
    uuid: `uuid-${id}`,
    sessionId: 'session-example',
    cwd: workspace,
    timestamp,
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 1000,
        output_tokens: 200
      }
    }
  };
  await writeFile(join(dir, file), JSON.stringify(line));
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-runs-example-'));
  home = await mkdtemp(join(tmpdir(), 'portos-home-example-'));
  __resetUsageClaims();
  await writeTranscript();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('historical usage worker', () => {
  it('correlates by run metadata and keeps the configured provider id', async () => {
    await writeRun('run-example-1', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      promptLength: 80,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    });
    await writeRun('run-outside-window', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-02T10:00:00.000Z',
      endTime: '2026-07-02T10:10:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({
      runId: 'run-example-1',
      providerId: 'claude-code-tui',
      day: '2026-07-01'
    });
    expect(result.corrections[0].measured[0]).toMatchObject({
      providerId: 'claude-code-tui',
      tokensOut: 200,
      cacheReadTokens: 1000
    });
  });

  it('skips a run already recorded by the live completion path', async () => {
    await writeRun('run-live-recorded', {
      providerId: 'claude-code-tui',
      workspacePath: workspace,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.total).toBe(0);
    expect(result.corrections).toEqual([]);
  });
  it('does not re-bill a message the live path claimed', async () => {
    const window = { startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:10:00.000Z' };
    const live = await readMeasuredUsage({ workspacePath: workspace, ...window, family: 'claude', home });
    expect(live?.tokensOut).toBe(200);
    const claimsSeed = snapshotUsageClaims();
    // The worker thread starts from its own empty copy of the ledger.
    __resetUsageClaims();
    await writeRun('run-overlapping-history', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:02:00.000Z',
      endTime: '2026-07-01T10:12:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home, claimsSeed });
    expect(result.corrections).toEqual([]);
    expect(result.claimsSnapshot.claimedMessages).toEqual(claimsSeed.claimedMessages);
  });

  // The live ledger is empty after a restart and prunes old claims, so a
  // settled run on disk is the durable record of what was already billed.
  it('does not re-bill what a settled run billed once the live claim is gone', async () => {
    await writeRun('run-settled-live', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true
    });
    await writeRun('run-overlapping-history', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:02:00.000Z',
      endTime: '2026-07-01T10:12:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home, claimsSeed: snapshotUsageClaims() });
    expect(result.total).toBe(1);
    expect(result.corrections).toEqual([]);
  });

  it('leaves a message written after the settled run reconciled to the run that owns it', async () => {
    // Inside the settled run's trailing slack, but written after it was read.
    await writeTranscript({ id: 'message-2', timestamp: '2026-07-01T10:10:30.000Z', file: 'session-later.jsonl' });
    await writeRun('run-settled-live', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true,
      usageReconciledAt: '2026-07-01T10:10:05.000Z'
    });
    await writeRun('run-next-history', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:10:10.000Z',
      endTime: '2026-07-01T10:20:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ runId: 'run-next-history' });
    expect(result.corrections[0].measured[0]).toMatchObject({ tokensOut: 200 });
  });

  it('skips a run whose workspace path is not a string instead of failing the scan', async () => {
    await writeRun('run-malformed', {
      providerId: 'claude-code-tui',
      workspacePath: 42,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true
    });
    await writeRun('run-example-1', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections.map((correction) => correction.runId)).toEqual(['run-example-1']);
  });
});

// A nested `--review-with grok` pass leaves a grok session but never a PortOS
// run, so historical repair has to find it under the PARENT run's window and
// attribute it to grok — including on a run whose own transcript was
// reconciled long ago (#5831).
describe('historical sibling-family attribution', () => {
  const GROK_MODEL = 'example-grok-model';
  const GROK_PROVIDER = { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: GROK_MODEL };
  const CLAUDE_PROVIDER = { id: 'claude-code-tui', type: 'tui', command: 'claude', enabled: true, defaultModel: 'claude-opus-5' };

  const writeGrokSession = async (cwd = workspace) => {
    const dir = join(home, '.grok', 'sessions', encodeURIComponent(cwd), 'session-aaaa');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'updates.jsonl'), JSON.stringify({
      timestamp: Math.round(Date.parse('2026-07-01T10:05:00.000Z') / 1000),
      method: '_x.ai/session/update',
      params: {
        sessionId: 'session-aaaa',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          usage: {
            inputTokens: 9_000,
            outputTokens: 700,
            totalTokens: 9_700,
            cachedReadTokens: 6_000,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
            modelUsage: { [GROK_MODEL]: { inputTokens: 9_000, outputTokens: 700 } }
          }
        },
        _meta: { agentTimestampMs: Date.parse('2026-07-01T10:05:00.000Z') }
      }
    }));
  };

  const reconciledRun = {
    providerId: 'claude-code-tui',
    model: 'claude-opus-5',
    workspacePath: workspace,
    promptLength: 80,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z',
    usageReconciled: true
  };

  it('attributes a nested grok session on a run whose parent pass already ran', async () => {
    await writeRun('run-already-measured', reconciledRun);
    await writeGrokSession();

    const result = await scanHistoricalUsage({ runsDir: root, home, providers: [CLAUDE_PROVIDER, GROK_PROVIDER] });
    expect(result.corrections).toHaveLength(1);
    const [correction] = result.corrections;
    // No parent half: the run's own estimate was replaced long ago, so there is
    // nothing left to subtract and re-applying the swap would corrupt the day.
    expect(correction.measured).toBeNull();
    expect(correction.estimate).toBeNull();
    expect(correction.siblings).toHaveLength(1);
    expect(correction.siblings[0]).toMatchObject({
      providerId: 'grok-cli',
      role: 'sibling',
      source: 'measured',
      tokensIn: 3_000,
      cacheReadTokens: 6_000,
      tokensOut: 700
    });
  });

  it('leaves an already-sibling-scanned run alone', async () => {
    await writeRun('run-already-scanned', { ...reconciledRun, usageSiblingsReconciled: true });
    await writeGrokSession();

    const result = await scanHistoricalUsage({ runsDir: root, home, providers: [CLAUDE_PROVIDER, GROK_PROVIDER] });
    expect(result.corrections).toEqual([]);
  });

  // Readers match a cwd or any subdirectory of it, so the settled run and the
  // pending one can sit at, above, or below each other and share one session.
  it.each([
    ['the same workspace', workspace, workspace],
    ['a parent workspace', '/work', workspace],
    ['a subdirectory workspace', `${workspace}/server`, `${workspace}/server`]
  ])('does not re-bill a nested session a settled run already covered, from %s', async (_label, pendingWorkspace, sessionCwd) => {
    await writeRun('run-already-scanned', { ...reconciledRun, usageSiblingsReconciled: true });
    await writeRun('run-overlapping-history', {
      ...reconciledRun,
      workspacePath: pendingWorkspace,
      startTime: '2026-07-01T10:04:00.000Z',
      endTime: '2026-07-01T10:14:00.000Z',
      usageReconciled: false
    });
    await writeGrokSession(sessionCwd);

    const result = await scanHistoricalUsage({ runsDir: root, home, providers: [CLAUDE_PROVIDER, GROK_PROVIDER] });
    expect(result.total).toBe(1);
    expect(result.corrections).toEqual([]);
  });

  it('does no sibling work at all when the install has no provider list', async () => {
    await writeRun('run-already-measured', reconciledRun);
    await writeGrokSession();

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections).toEqual([]);
  });
});
