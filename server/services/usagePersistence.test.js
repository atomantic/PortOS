import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

vi.mock('fs/promises', async (original) => {
  const actual = await original();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-usage-commit-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const { PATHS } = await import('../lib/fileUtils.js');
const {
  USAGE_FILE, getUsage, loadUsage, resetUsage, recordRunUsage,
  recordTokens, applyHistoricalUsageCorrections, getReconciledUsageRunIds
} = await import('./usage.js');
const { __resetUsageClaims, recordCompletedRunUsage, snapshotUsageClaims } = await import('./usageReconciler.js');
const home = join(PATHS.data, 'synthetic-home');
const workspacePath = '/synthetic/usage-workspace';
const now = Date.now();
const timestamp = new Date(now).toISOString();
const run = { id: 'failed-run', providerId: 'codex-cli', command: 'codex', model: 'gpt-5.3-codex',
  workspacePath, startTime: new Date(now - 1000).toISOString(), endTime: new Date(now + 1000).toISOString(), promptLength: 0 };
const disk = async () => JSON.parse(await readFile(USAGE_FILE, 'utf8'));
let errorLog;

beforeEach(async () => {
  rename.mockClear();
  __resetUsageClaims();
  await resetUsage();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());
afterAll(cleanup);

const writeRollout = async () => {
  const dir = join(home, '.codex', 'sessions', ...timestamp.slice(0, 10).split('-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rollout-synthetic.jsonl'), [
    { timestamp, type: 'session_meta', payload: { id: 'synthetic-session', cwd: workspacePath, model: run.model } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 }
    } } }
  ].map(line => JSON.stringify(line)).join('\n'));
};

const failRename = () => rename.mockRejectedValueOnce(Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' }));

describe('usage commit failure recovery', () => {
  it('releases a failed completion claim and persists its explicit same-process retry exactly once', async () => {
    await writeRollout();
    const before = await disk();
    failRename();
    await recordCompletedRunUsage(run, '', { home, providers: [] });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('synthetic disk write failure'));
    expect(await disk()).toEqual(before);
    expect(getUsage()).toEqual(before);
    expect(getReconciledUsageRunIds()).not.toContain(run.id);
    expect(snapshotUsageClaims().codexHighWater).toEqual([]);

    await recordCompletedRunUsage(run, '', { home, providers: [] });
    expect(await disk()).toMatchObject({ totalTokens: { input: 120, output: 30 } });
    expect(getReconciledUsageRunIds()).toContain(run.id);
    const committed = await disk();
    __resetUsageClaims();
    await loadUsage();
    expect(getUsage()).toEqual(committed);
  });

  it('does not publish a failed draft or discard a concurrent successful writer', async () => {
    const before = await disk();
    let rejectWrite;
    const entered = Promise.withResolvers();
    rename.mockImplementationOnce(() => {
      entered.resolve();
      return new Promise((_, reject) => { rejectWrite = reject; });
    });
    const failed = recordRunUsage({ providerId: 'codex-cli', tokensIn: 120, tokensOut: 30 }, { reconciledRunId: 'retry' });
    const failure = expect(failed).rejects.toThrow('synthetic disk write failure');
    await entered.promise;
    const successful = recordTokens(7, 9);
    expect(getUsage()).toEqual(before);
    rejectWrite(Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' }));
    await failure;
    await successful;
    expect(await disk()).toMatchObject({ totalTokens: { input: 7, output: 9 } });
    await recordRunUsage({ providerId: 'codex-cli', tokensIn: 120, tokensOut: 30 }, { reconciledRunId: 'retry' });
    expect(await disk()).toMatchObject({ totalTokens: { input: 127, output: 39 } });
  });

  it('does not let an overlapping completion depend on a failed Codex claim', async () => {
    await writeRollout();
    let rejectWrite;
    const entered = Promise.withResolvers();
    rename.mockImplementationOnce(() => {
      entered.resolve();
      return new Promise((_, reject) => { rejectWrite = reject; });
    });
    const first = recordCompletedRunUsage(run, 'estimated output', { home, providers: [] });
    await entered.promise;
    const second = recordCompletedRunUsage({ ...run, id: 'later-run', workspacePath: '/synthetic' }, 'estimated output', { home, providers: [] });
    rejectWrite(Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' }));
    await Promise.all([first, second]);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('synthetic disk write failure'));
    expect(await disk()).toMatchObject({ totalTokens: { input: 120, output: 30 } });
    expect(getReconciledUsageRunIds()).toEqual(['later-run']);
  });

  it('rolls back backfill counts and watermarks and rejects a stale preview without writing', async () => {
    const before = await disk();
    const correction = { runId: 'historical', day: timestamp.slice(0, 10), providerId: 'codex-cli',
      siblingScanned: true, siblings: [{ providerId: 'codex-cli', model: run.model, tokensIn: 120, tokensOut: 30 }] };
    const interactiveScan = { watermarks: { codex: timestamp } };
    failRename();
    await expect(applyHistoricalUsageCorrections([correction], { interactiveScan })).rejects.toThrow('synthetic disk write failure');
    expect(getUsage()).toEqual(before);
    expect(await disk()).toEqual(before);
    await applyHistoricalUsageCorrections([correction], { interactiveScan, expectedRevision: before.lastUpdated });
    expect(await disk()).toMatchObject({ totalTokens: { input: 120, output: 30 }, interactiveScan });
    const committed = await disk();
    await expect(applyHistoricalUsageCorrections([correction], { expectedRevision: before.lastUpdated })).rejects.toThrow('Usage changed since preview');
    expect(await disk()).toEqual(committed);
  });
});
