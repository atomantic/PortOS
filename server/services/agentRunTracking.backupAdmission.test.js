import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
let beforeWrite = async () => {};
let bypass = false;
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('agent-recording-backup-'), overrides: {
    atomicWrite: async (path, data) => { await beforeWrite(path); return actual.atomicWrite(path, data); },
  } });
});
vi.mock('../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => bypass ? work() : actual.withBackupAssetPublication(work) };
});
vi.mock('./usage.js', () => ({ recordSession: async () => {} }));
vi.mock('./usageReconciler.js', () => ({ recordCompletedRunUsage: () => {} }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: async () => {} }));
vi.mock('../lib/gitCommitProbe.js', () => ({ committedDuringRun: async () => false }));
const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { createAgentRun, completeAgentRun } = await import('./agentRunTracking.js');
const create = () => createAgentRun({ agentId: 'example-agent', task: { id: 'example-task', description: 'Example prompt' }, provider: { id: 'example-provider', name: 'Example', defaultModel: 'example-model' } });
const capture = async dir => ({ output: await readFile(join(dir, 'output.txt'), 'utf8'), metadata: JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
beforeEach(async () => { beforeWrite = async () => {}; bypass = false; await rm(PATHS.data, { recursive: true, force: true }); await mkdir(PATHS.runs, { recursive: true }); });
afterAll(cleanupTempDataRoots);
it('does not publish creation files during a cut', async () => {
  const release = await acquireBackupSnapshotCut(); let writes = 0;
  beforeWrite = async () => { writes++; };
  const work = create();
  try { await settle(); await settle(); expect(writes).toBe(0); } finally { release(); }
  const { runDir } = await work;
  expect((await readdir(runDir)).sort()).toEqual(['metadata.json', 'output.txt', 'prompt.txt']);
});
it('blocks completion output and metadata during a cut', async () => {
  const { runId, runDir } = await create(); const before = await capture(runDir);
  const release = await acquireBackupSnapshotCut(); const work = completeAgentRun(runId, 'Example output', 0, 10);
  try { await settle(); await settle(); expect(await capture(runDir)).toEqual(before); } finally { release(); }
  await work; const after = await capture(runDir); expect(after.metadata.outputSize).toBe(Buffer.byteLength(after.output));
});
it('drains the actual output write through terminal metadata', async () => {
  const { runId, runDir } = await create(); const reached = deferred(); const commit = deferred();
  beforeWrite = async path => { if (path.endsWith('metadata.json')) { reached.resolve(); await commit.promise; } };
  const work = completeAgentRun(runId, 'Example output', 0, 10); await reached.promise;
  let ready = false; const cut = acquireBackupSnapshotCut().then(release => { ready = true; return release; });
  try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
  await work; const release = await cut;
  try { const after = await capture(runDir); expect(after.metadata.outputSize).toBe(Buffer.byteLength(after.output)); } finally { release(); }
});
it('negative control exposes terminal metadata for output absent from the earlier copy', async () => {
  const { runId, runDir } = await create(); bypass = true;
  const release = await acquireBackupSnapshotCut();
  try { const copied = (await capture(runDir)).output; await completeAgentRun(runId, 'Example output', 0, 10); expect((await capture(runDir)).metadata.outputSize).not.toBe(Buffer.byteLength(copied)); }
  finally { release(); }
});
it('does not stamp terminal metadata when output persistence fails', async () => {
  const { runId, runDir } = await create(); const before = await capture(runDir);
  beforeWrite = async path => { if (path.endsWith('output.txt')) throw new Error('synthetic write failure'); };
  await expect(completeAgentRun(runId, 'Example output', 0, 10)).rejects.toThrow('synthetic write failure');
  expect(await capture(runDir)).toEqual(before);
});
