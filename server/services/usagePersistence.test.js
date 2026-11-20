import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, writeFile, rm } from 'fs/promises';
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
  USAGE_FILE, getUsage, loadUsage, resetUsage, recordSession, recordRunUsage, addDatedUsageBatch, flushPendingUsageWrites,
  recordTokens, applyHistoricalUsageCorrections, getReconciledUsageRunIds, getRecentCodexUsageClaims, buildUsageDigest
} = await import('./usage.js');
const { __resetUsageClaims, mergeUsageClaims, recordCompletedRunUsage, snapshotUsageClaims } = await import('./usageReconciler.js');
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

// The ledger write only: the same pass also stores a Codex projection through this primitive.
const { rename: actualRename } = await vi.importActual('fs/promises');
const failNextLedgerRename = (fail) => rename.mockImplementation((from, to) => {
  if (to !== USAGE_FILE) return actualRename(from, to);
  rename.mockImplementation(actualRename);
  return fail();
});
const failRename = () => failNextLedgerRename(() => Promise.reject(Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' })));

describe('durable usage batches', () => {
  it('coalesces 100 overlapping session and completion pairs and only acknowledges the durable save', async () => {
    const before = getUsage();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const writes = [];
    rename.mockImplementation(async (from, to) => {
      if (to === USAGE_FILE) {
        writes.push(from);
        entered.resolve();
        await release.promise;
      }
      return actualRename(from, to);
    });

    try {
      const sessions = [];
      const completions = [];
      for (let i = 0; i < 100; i++) {
        sessions.push(recordSession('codex-cli', 'Codex', run.model));
        completions.push(recordRunUsage({ providerId: 'codex-cli', model: run.model, tokensOut: 3 },
          { reconciledRunId: `batch-${i}`, siblings: true }));
      }
      let acknowledged = false;
      const saved = Promise.all([...sessions, ...completions]).then(() => { acknowledged = true; });
      const flushed = flushPendingUsageWrites();
      await entered.promise;
      try {
        expect(acknowledged).toBe(false);
        expect(getUsage()).toBe(before);
        expect(await disk()).toEqual(before);
      } finally {
        release.resolve();
        await Promise.all([saved, flushed]);
      }
      expect(writes).toHaveLength(1);
      expect(await Promise.all(sessions)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      const savedUsage = await disk();
      expect(savedUsage).toMatchObject({ totalSessions: 100, totalMessages: 100, totalTokens: { output: 300 } });
      expect(Object.keys(savedUsage.reconciledRuns)).toHaveLength(100);
      expect(Object.keys(savedUsage.siblingReconciledRuns)).toHaveLength(100);
      expect(await readFile(USAGE_FILE, 'utf8')).toBe(JSON.stringify(savedUsage));
    } finally {
      rename.mockImplementation(actualRename);
    }
  });

  it('keeps historical buckets shared and previously published state unchanged', async () => {
    const historic = { day: '2021-03-04', record: { providerId: 'grok-cli', tokensOut: 20 }, repairId: 'historical-id' };
    await addDatedUsageBatch([historic]);
    await recordSession('codex-cli', 'Codex', run.model);
    await recordRunUsage({ providerId: 'codex-cli', model: run.model, tokensOut: 3 });
    const before = getUsage();
    const beforeValue = structuredClone(before);
    await recordSession('codex-cli', 'Codex', run.model);
    await recordRunUsage({ providerId: 'codex-cli', model: run.model, tokensOut: 7, repairIds: ['live-id'] });
    expect(before).toEqual(beforeValue);
    expect(getUsage().dailyActivity[historic.day]).toBe(before.dailyActivity[historic.day]);
    expect(getUsage().totalTokens.output).toBe(30);

    await loadUsage();
    expect(await addDatedUsageBatch([historic])).toEqual([]);
    expect(getUsage().monthlyActivity['2021-03'].tokens).toBe(20);
  });
});

describe('exact Codex boundary compaction', () => {
  it('removes only covered boundaries and preserves billing for every cutoff after reload', async () => {
    const old = '2022-11-17T00:00:00.000Z';
    const middle = '2022-11-18T00:00:00.000Z';
    const recent = '2022-11-19T00:00:00.000Z';
    const key = 'codex-id:v1:example';
    const path = '/example/legacy-rollout.jsonl';
    const mark = (at, ...codexHighWater) => ({ at, codexHighWater });
    const covered = [key, { tokensIn: 99, tokensOut: 11, fastTokensIn: 19, fastTokensOut: 2 }];
    const latest = [key, { messages: 0, tokensIn: 100, tokensOut: 4, cacheReadTokens: 0, cacheWriteTokens: 0, fastTokensOut: 2 }];
    const middleClaim = [key, { tokensIn: 80, tokensOut: 12, fastTokensIn: 20 }];
    const legacyClaim = [path, { tokensIn: 3, tokensOut: 2 }];
    const markers = {
      'covered-run': mark(old, covered),
      'mixed-run': mark(old, covered, legacyClaim),
      'middle-run': mark(middle, middleClaim),
      'latest-run': mark(recent, latest),
      'same-time-run': mark(recent, latest),
      'undated-run': mark('unknown', covered),
      'legacy-run': old,
    };
    const original = { ...(await disk()), reconciledRuns: markers, siblingReconciledRuns: { 'covered-run': old },
      grokRepairIds: ['historical-repair'] };
    await writeFile(USAGE_FILE, JSON.stringify(original));

    const mergedClaims = (entries) => {
      __resetUsageClaims();
      mergeUsageClaims({ codexHighWater: entries });
      return Object.fromEntries(snapshotUsageClaims().codexHighWater);
    };
    const expectedBoundaries = (since) => Object.values(markers)
      .filter(marker => Date.parse(marker.at) >= since)
      .flatMap(marker => marker.codexHighWater);

    await loadUsage();
    const compacted = await disk();
    expect(compacted.reconciledRuns).toEqual({
      ...markers,
      'covered-run': old,
      'mixed-run': mark(old, legacyClaim),
      'same-time-run': recent,
    });
    expect(compacted.siblingReconciledRuns).toEqual(original.siblingReconciledRuns);
    expect(compacted.grokRepairIds).toEqual(original.grokRepairIds);
    expect(getReconciledUsageRunIds()).toEqual(Object.keys(markers));
    expect(buildUsageDigest()).toEqual(buildUsageDigest(original));

    for (const since of [0, Date.parse(old) + 1, Date.parse(middle) + 1, Date.parse(recent) + 1]) {
      expect(mergedClaims(await getRecentCodexUsageClaims(since))).toEqual(mergedClaims(expectedBoundaries(since)));
    }
    const allTimeClaims = (runs) => Object.values(runs).flatMap(marker => marker.codexHighWater || []);
    expect(mergedClaims(allTimeClaims(compacted.reconciledRuns))).toEqual(mergedClaims(allTimeClaims(markers)));

    rename.mockClear();
    await loadUsage();
    expect(await disk()).toEqual(compacted);
    expect(rename).not.toHaveBeenCalled();
  });
});

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

  it('imports bridge counts and a deferred session atomically after a failed write, preserving ephemeral measurements', async () => {
    const dir = join(PATHS.runs, 'bridge-pending');
    await mkdir(dir, { recursive: true });
    const metadataPath = join(dir, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify({ ...run, id: 'bridge-pending', success: true,
      usageSessionDeferred: true, selfContainedUsage: true, nativeUsageUnpersisted: true,
      reportedUsage: { tokensIn: 100, tokensOut: 30, cacheReadTokens: 20 } }));
    try {
      const before = await disk();
      failRename();
      await expect(loadUsage()).rejects.toThrow('synthetic disk write failure');
      expect(await disk()).toEqual(before);
      expect(JSON.parse(await readFile(metadataPath, 'utf8')).usageReconciled).toBeUndefined();
      await loadUsage();
      const committed = await disk();
      expect(committed).toMatchObject({ totalSessions: 1, totalMessages: 1, totalTokens: { input: 120, output: 30 } });
      const providerDay = Object.values(committed.dailyActivity).find(day => day.byProvider?.['codex-cli'])?.byProvider['codex-cli'];
      expect(providerDay).toMatchObject({ source: 'measured', unpersisted: { tokensIn: 100, tokensOut: 30, cacheReadTokens: 20 },
        byModel: { [run.model]: { unpersisted: { tokensIn: 100, tokensOut: 30, cacheReadTokens: 20 } } } });
      expect(JSON.parse(await readFile(metadataPath, 'utf8')).usageReconciled).toBe(true);
      await loadUsage();
      expect(await disk()).toEqual(committed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not publish a failed draft or discard a concurrent successful writer', async () => {
    const before = await disk();
    let rejectWrite;
    const entered = Promise.withResolvers();
    failNextLedgerRename(() => {
      entered.resolve();
      return new Promise((_, reject) => { rejectWrite = reject; });
    });
    const codexHighWater = [['/synthetic/rollout.jsonl', { tokensIn: 120, tokensOut: 30 }]];
    const failed = recordRunUsage({ providerId: 'codex-cli', tokensIn: 120, tokensOut: 30 }, { reconciledRunId: 'retry', codexHighWater });
    const failure = expect(failed).rejects.toThrow('synthetic disk write failure');
    await entered.promise;
    const successful = recordTokens(7, 9);
    expect(getUsage()).toEqual(before);
    expect(await getRecentCodexUsageClaims(0)).toEqual([]);
    rejectWrite(Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' }));
    await failure;
    await successful;
    expect(await disk()).toMatchObject({ totalTokens: { input: 7, output: 9 } });
    await recordRunUsage({ providerId: 'codex-cli', tokensIn: 120, tokensOut: 30 }, { reconciledRunId: 'retry', codexHighWater });
    expect(await getRecentCodexUsageClaims(0)).toEqual(codexHighWater);
    expect(await disk()).toMatchObject({ totalTokens: { input: 127, output: 39 } });
  });

  it('does not let an overlapping completion depend on a failed Codex claim', async () => {
    await writeRollout();
    let rejectWrite;
    const entered = Promise.withResolvers();
    failNextLedgerRename(() => {
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

  it('commits a repair batch once and leaves every item retryable after a failed write', async () => {
    const additions = [10, 20].map((tokensOut, index) => ({ day: timestamp.slice(0, 10),
      repairId: `synthetic-repair-${index}`, record: { providerId: 'grok-cli', tokensOut } }));
    const before = await disk();
    failRename();
    await expect(addDatedUsageBatch(additions)).rejects.toThrow('synthetic disk write failure');
    expect(getUsage()).toEqual(before);
    expect(await disk()).toEqual(before);
    expect(await addDatedUsageBatch(additions)).toEqual(additions);
    expect(await disk()).toMatchObject({ totalTokens: { output: 30 }, grokRepairIds: additions.map(item => item.repairId) });
    const committed = await disk();
    expect(await addDatedUsageBatch(additions)).toEqual([]);
    expect(await disk()).toEqual(committed);
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
