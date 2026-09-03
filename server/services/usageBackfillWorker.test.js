import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __resetUsageClaims } from './usageReconciler.js';
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

const writeTranscript = async () => {
  const dir = join(home, '.claude', 'projects', '-work-example-repo');
  await mkdir(dir, { recursive: true });
  const line = {
    type: 'assistant',
    uuid: 'uuid-message-1',
    sessionId: 'session-example',
    cwd: workspace,
    timestamp: '2026-07-01T10:05:00.000Z',
    message: {
      id: 'message-1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 1000,
        output_tokens: 200
      }
    }
  };
  await writeFile(join(dir, 'session-example.jsonl'), JSON.stringify(line));
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
});

// A nested `--review-with grok` pass leaves a grok session but never a PortOS
// run, so historical repair has to find it under the PARENT run's window and
// attribute it to grok — including on a run whose own transcript was
// reconciled long ago (#5831).
describe('historical sibling-family attribution', () => {
  const GROK_MODEL = 'example-grok-model';
  const GROK_PROVIDER = { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: GROK_MODEL };
  const CLAUDE_PROVIDER = { id: 'claude-code-tui', type: 'tui', command: 'claude', enabled: true, defaultModel: 'claude-opus-5' };

  const writeGrokSession = async () => {
    const dir = join(home, '.grok', 'sessions', encodeURIComponent(workspace), 'session-aaaa');
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

  it('does no sibling work at all when the install has no provider list', async () => {
    await writeRun('run-already-measured', reconciledRun);
    await writeGrokSession();

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections).toEqual([]);
  });
});
