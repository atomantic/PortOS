import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration, { SIBLING_SCAN_SHIPPED_AT } from './434-stamp-sibling-reconciled-runs.js';
import { scanHistoricalUsage } from '../../server/services/usageBackfillWorker.js';

let rootDir;
let runsDir;
let usagePath;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-434-'));
  runsDir = join(rootDir, 'data', 'runs');
  usagePath = join(rootDir, 'data', 'usage.json');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const writeRunMetadata = async (runId, metadata) => {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
};

const readRunMetadata = async (runId) => {
  const raw = await readFile(join(runsDir, runId, 'metadata.json'), 'utf8');
  return JSON.parse(raw);
};

const writeUsageDoc = async (doc) => {
  await mkdir(join(rootDir, 'data'), { recursive: true });
  await writeFile(usagePath, JSON.stringify(doc, null, 2));
};

const readUsageDoc = async () => {
  const raw = await readFile(usagePath, 'utf8');
  return JSON.parse(raw);
};

describe('migration 434: stamp-sibling-reconciled-runs', () => {
  it('stamps runs reconciled live on or after #5831, updates usage.json, and leaves pre-#5831 runs sibling-pending', async () => {
    const postShipRunId = 'run-post-5831';
    const preShipRunId = 'run-pre-5831';
    const unreconciledRunId = 'run-unreconciled';
    const alreadyScannedRunId = 'run-already-scanned';
    const prunedRunId = 'run-pruned-from-disk';

    const postDate = '2026-09-10T12:00:00.000Z';
    const preDate = '2026-07-01T10:00:00.000Z';

    await writeRunMetadata(postShipRunId, {
      id: postShipRunId,
      providerId: 'claude-code-tui',
      workspacePath: '/work/test',
      startTime: '2026-09-10T11:50:00.000Z',
      endTime: '2026-09-10T12:00:00.000Z',
      usageReconciled: true,
      usageReconciledAt: postDate
    });

    await writeRunMetadata(preShipRunId, {
      id: preShipRunId,
      providerId: 'claude-code-tui',
      workspacePath: '/work/test',
      startTime: '2026-07-01T09:50:00.000Z',
      endTime: '2026-07-01T10:00:00.000Z',
      usageReconciled: true,
      usageReconciledAt: preDate
    });

    await writeRunMetadata(unreconciledRunId, {
      id: unreconciledRunId,
      providerId: 'claude-code-tui',
      workspacePath: '/work/test',
      startTime: '2026-09-15T10:00:00.000Z',
      endTime: '2026-09-15T10:10:00.000Z',
      usageReconciled: false
    });

    await writeRunMetadata(alreadyScannedRunId, {
      id: alreadyScannedRunId,
      providerId: 'claude-code-tui',
      workspacePath: '/work/test',
      startTime: '2026-09-12T10:00:00.000Z',
      endTime: '2026-09-12T10:10:00.000Z',
      usageReconciled: true,
      usageReconciledAt: '2026-09-12T10:10:00.000Z',
      usageSiblingsReconciled: true,
      usageSiblingsReconciledAt: '2026-09-12T10:10:00.000Z'
    });

    await writeUsageDoc({
      reconciledRuns: {
        [postShipRunId]: postDate,
        [preShipRunId]: preDate,
        [prunedRunId]: '2026-09-08T08:00:00.000Z'
      },
      siblingReconciledRuns: {
        [alreadyScannedRunId]: '2026-09-12T10:10:00.000Z'
      }
    });

    const result = await migration.up({ rootDir });
    expect(result.stampedRuns).toBe(1);
    expect(result.stampedUsageRuns).toBe(2); // postShipRunId + prunedRunId

    // Post-#5831 run is stamped
    const postMeta = await readRunMetadata(postShipRunId);
    expect(postMeta.usageSiblingsReconciled).toBe(true);
    expect(postMeta.usageSiblingsReconciledAt).toBe(postDate);

    // Pre-#5831 run is left sibling-pending
    const preMeta = await readRunMetadata(preShipRunId);
    expect(preMeta.usageSiblingsReconciled).toBeUndefined();
    expect(preMeta.usageSiblingsReconciledAt).toBeUndefined();

    // Unreconciled run is untouched
    const unreconciledMeta = await readRunMetadata(unreconciledRunId);
    expect(unreconciledMeta.usageSiblingsReconciled).toBeUndefined();

    // Already-scanned run is untouched
    const alreadyScannedMeta = await readRunMetadata(alreadyScannedRunId);
    expect(alreadyScannedMeta.usageSiblingsReconciled).toBe(true);

    // usage.json has both post-#5831 runs in siblingReconciledRuns, but NOT the pre-#5831 run
    const usage = await readUsageDoc();
    expect(usage.siblingReconciledRuns[postShipRunId]).toBe(postDate);
    expect(usage.siblingReconciledRuns[prunedRunId]).toBe('2026-09-08T08:00:00.000Z');
    expect(usage.siblingReconciledRuns[preShipRunId]).toBeUndefined();
    expect(usage.siblingReconciledRuns[alreadyScannedRunId]).toBe('2026-09-12T10:10:00.000Z');
  });

  it('is idempotent: running again performs no writes', async () => {
    const runId = 'run-idempotency-test';
    const stamp = '2026-09-20T10:00:00.000Z';

    await writeRunMetadata(runId, {
      id: runId,
      providerId: 'claude-code-tui',
      workspacePath: '/work/test',
      usageReconciled: true,
      usageReconciledAt: stamp
    });
    await writeUsageDoc({
      reconciledRuns: { [runId]: stamp },
      siblingReconciledRuns: {}
    });

    const first = await migration.up({ rootDir });
    expect(first.stampedRuns).toBe(1);
    expect(first.stampedUsageRuns).toBe(1);

    const usageContentAfterFirst = await readFile(usagePath, 'utf8');
    const metadataContentAfterFirst = await readFile(join(runsDir, runId, 'metadata.json'), 'utf8');

    // Second run
    const second = await migration.up({ rootDir });
    expect(second.stampedRuns).toBe(0);
    expect(second.stampedUsageRuns).toBe(0);

    expect(await readFile(usagePath, 'utf8')).toBe(usageContentAfterFirst);
    expect(await readFile(join(runsDir, runId, 'metadata.json'), 'utf8')).toBe(metadataContentAfterFirst);
  });

  it('gates on input records: no-ops when neither usage.json nor data/runs exists', async () => {
    const emptyResult = await migration.up({ rootDir });
    expect(emptyResult).toEqual({ stampedRuns: 0, stampedUsageRuns: 0 });
  });

  it('gates on input records: handles usage.json existing with no runs on disk', async () => {
    await writeUsageDoc({
      reconciledRuns: {
        'run-old': '2026-07-01T00:00:00.000Z',
        'run-new': '2026-09-05T00:00:00.000Z'
      }
    });

    const result = await migration.up({ rootDir });
    expect(result.stampedRuns).toBe(0);
    expect(result.stampedUsageRuns).toBe(1);

    const usage = await readUsageDoc();
    expect(usage.siblingReconciledRuns['run-new']).toBe('2026-09-05T00:00:00.000Z');
    expect(usage.siblingReconciledRuns['run-old']).toBeUndefined();
  });

  it('prevents historical backfill from re-billing a post-#5831 live run while preserving attribution for pre-#5831 runs', async () => {
    const home = join(rootDir, 'fake-home');
    const workspace = join(rootDir, 'work');
    const GROK_MODEL = 'example-grok-model';
    const GROK_PROVIDER = { id: 'grok-cli', type: 'cli', command: 'grok', enabled: true, defaultModel: GROK_MODEL };
    const CLAUDE_PROVIDER = { id: 'claude-code-tui', type: 'tui', command: 'claude', enabled: true, defaultModel: 'claude-opus-5' };

    // Helper to write a grok session in a run's window
    const writeGrokSessionAt = async (timeIso) => {
      const dir = join(home, '.grok', 'sessions', encodeURIComponent(workspace), 'session-test');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'updates.jsonl'), JSON.stringify({
        timestamp: Math.round(Date.parse(timeIso) / 1000),
        method: '_x.ai/session/update',
        params: {
          sessionId: 'session-test',
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-1',
            usage: {
              inputTokens: 2000,
              outputTokens: 400,
              totalTokens: 2400,
              cachedReadTokens: 1000,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
              modelUsage: { [GROK_MODEL]: { inputTokens: 2000, outputTokens: 400 } }
            }
          },
          _meta: { agentTimestampMs: Date.parse(timeIso) }
        }
      }));
    };

    // 1. Post-#5831 run: reconciled live on 2026-09-10 (after #5831 release)
    const postRunId = 'run-reconciled-post-5831';
    await writeRunMetadata(postRunId, {
      id: postRunId,
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      promptLength: 40,
      startTime: '2026-09-10T10:00:00.000Z',
      endTime: '2026-09-10T10:10:00.000Z',
      usageReconciled: true,
      usageReconciledAt: '2026-09-10T10:10:05.000Z'
      // Notice: NO usageSiblingsReconciled before migration!
    });
    await writeFile(join(runsDir, postRunId, 'output.txt'), 'test output');

    // 2. Pre-#5831 run: reconciled live on 2026-07-01 (before #5831 release)
    const preRunId = 'run-reconciled-pre-5831';
    await writeRunMetadata(preRunId, {
      id: preRunId,
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      promptLength: 40,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true,
      usageReconciledAt: '2026-07-01T10:10:05.000Z'
    });
    await writeFile(join(runsDir, preRunId, 'output.txt'), 'test output');

    await writeUsageDoc({
      reconciledRuns: {
        [postRunId]: '2026-09-10T10:10:05.000Z',
        [preRunId]: '2026-07-01T10:10:05.000Z'
      },
      siblingReconciledRuns: {}
    });

    // Write a grok session for each run's window
    await writeGrokSessionAt('2026-09-10T10:05:00.000Z');

    // Run the migration!
    await migration.up({ rootDir });

    const usageAfter = await readUsageDoc();
    const siblingReconciledRunIds = Object.keys(usageAfter.siblingReconciledRuns || {});

    // Now run historical backfill worker:
    const scanResult = await scanHistoricalUsage({
      runsDir,
      home,
      providers: [CLAUDE_PROVIDER, GROK_PROVIDER],
      reconciledRunIds: Object.keys(usageAfter.reconciledRuns || {}),
      siblingReconciledRunIds
    });

    // Acceptance criterion 1: The post-#5831 run is NOT given a sibling correction
    const postCorrection = scanResult.corrections.find((c) => c.runId === postRunId);
    expect(postCorrection).toBeUndefined();

    // Acceptance criterion 2: The pre-#5831 run STILL gets its nested session attributed
    // Write grok session in preRun's window
    await writeGrokSessionAt('2026-07-01T10:05:00.000Z');
    const scanResultPre = await scanHistoricalUsage({
      runsDir,
      home,
      providers: [CLAUDE_PROVIDER, GROK_PROVIDER],
      reconciledRunIds: Object.keys(usageAfter.reconciledRuns || {}),
      siblingReconciledRunIds
    });

    const preCorrection = scanResultPre.corrections.find((c) => c.runId === preRunId);
    expect(preCorrection).toBeDefined();
    expect(preCorrection.siblings).toHaveLength(1);
    expect(preCorrection.siblings[0]).toMatchObject({
      providerId: 'grok-cli',
      role: 'sibling',
      tokensOut: 400
    });
  });
});
