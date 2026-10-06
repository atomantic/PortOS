/** Host injection over real toolkit files; no provider/network/child execution. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { acquireBackupSnapshotCut, withBackupAssetPublication, holdsBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
const seam = vi.hoisted(() => ({ beforeWrite: null, child: null }));
vi.mock('../lib/aiToolkit/internal/atomicWrite.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: async (path, data) => { await seam.beforeWrite?.(path, data); return actual.atomicWrite(path, data); } };
});
vi.mock('child_process', async importOriginal => ({ ...await importOriginal(), spawn: () => seam.child }));
const { createRunnerService } = await import('../lib/aiToolkit/runner.js');
const { createRunFinalizer } = await import('../lib/aiToolkit/internal/runFinalizer.js');
const root = await mkdtemp(join(tmpdir(), 'toolkit-backup-'));
const dir = join(root, 'runs', 'example');
const outputPath = join(dir, 'output.txt');
const metadataPath = join(dir, 'metadata.json');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const provider = { id: 'example', name: 'Example', enabled: true, command: 'synthetic' };
const runner = (injected = withBackupAssetPublication, hooks = {}) => createRunnerService({ dataDir: root, withAssetPublication: injected, hooks,
  providerService: { getProviderById: async () => provider } });
const capture = async () => ({ output: await readFile(outputPath, 'utf8'), metadata: JSON.parse(await readFile(metadataPath, 'utf8')) });
const assertPair = async () => { const pair = await capture(); expect(pair.metadata.outputSize).toBe(Buffer.byteLength(pair.output)); };
beforeEach(async () => {
  seam.beforeWrite = null;
  await rm(root, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  await writeFile(outputPath, ''); await writeFile(metadataPath, JSON.stringify({ id: 'example', outputSize: 0 }));
});
afterAll(() => rm(root, { recursive: true, force: true }));
function apiFinalizer(injected = withBackupAssetPublication, hooks = {}) {
  let settled = false;
  return createRunFinalizer({ runId: 'example', provider, startTime: Date.now(), activeRuns: new Map(),
    lifecycle: { markSettled: () => { if (settled) return false; settled = true; return true; } },
    stallTimeout: 5, absoluteTimeout: 10, outputPath, metadataPath, getOutput: () => 'Example output', getReasoning: () => '',
    hooks, safeJsonParse: JSON.parse, consumeActiveStop: () => false, handleProviderError: async () => {},
    withAssetPublication: injected });
}
const causes = [{ type: 'success' }, { type: 'timeout', bound: 'stall' }, { type: 'canceled' }, { type: 'stream-error', error: new Error('Example stream failure') }];
describe.each(causes)('API $type recording', cause => {
  it('does not replace output or metadata during a cut', async () => {
    const before = await capture(); const release = await acquireBackupSnapshotCut();
    const work = apiFinalizer().finalize(cause);
    try { await settle(); await settle(); expect(await capture()).toEqual(before); } finally { release(); }
    await work; await assertPair();
  });
  it('drains output through metadata and invokes hooks outside admission', async () => {
    const reached = deferred(); const commit = deferred();
    seam.beforeWrite = async path => { if (path === metadataPath) { reached.resolve(); await commit.promise; } };
    const leaseStates = [];
    const check = () => leaseStates.push(holdsBackupAssetPublication());
    const work = apiFinalizer(withBackupAssetPublication, { onRunCompleted: check, onRunFailed: check, onRunCanceled: check }).finalize(cause);
    await reached.promise;
    let ready = false; const cut = acquireBackupSnapshotCut().then(release => { ready = true; return release; });
    try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
    await work; const release = await cut;
    try { await assertPair(); expect(leaseStates).toEqual([false]); } finally { release(); }
  });
});
it('negative control exposes copied output differing from later completion metadata', async () => {
  const release = await acquireBackupSnapshotCut();
  try {
    const copied = (await capture()).output;
    await apiFinalizer(work => work()).finalize({ type: 'success' });
    expect((await capture()).metadata.outputSize).not.toBe(Buffer.byteLength(copied));
  } finally { release(); }
});
it.each(causes)('keeps persisted outputSize truthful on $type output-write failure', async cause => {
  seam.beforeWrite = async path => { if (path === outputPath) throw new Error('synthetic output write failure'); };
  await apiFinalizer().finalize(cause); await assertPair();
});
it('creation drains prompt and output before publishing metadata', async () => {
  const reached = deferred(); const commit = deferred(); let newDir;
  seam.beforeWrite = async path => { if (path.endsWith('metadata.json')) { newDir = join(path, '..'); reached.resolve(); await commit.promise; } };
  const work = runner().createRun({ providerId: provider.id, prompt: 'Example prompt' });
  await reached.promise;
  expect(await readFile(join(newDir, 'prompt.txt'), 'utf8')).toBe('Example prompt');
  let ready = false; const cut = acquireBackupSnapshotCut().then(release => { ready = true; return release; });
  try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
  const created = await work; const release = await cut;
  try { expect((await readdir(created.runDir)).sort()).toEqual(['metadata.json', 'output.txt', 'prompt.txt']); } finally { release(); }
});
it('creation cannot publish metadata when prompt persistence fails', async () => {
  seam.beforeWrite = async path => { if (path.endsWith('prompt.txt')) throw new Error('synthetic prompt failure'); };
  await expect(runner().createRun({ providerId: provider.id, prompt: 'Example' })).rejects.toThrow('synthetic prompt failure');
  for (const id of (await readdir(join(root, 'runs'))).filter(id => id !== 'example')) {
    expect(await readdir(join(root, 'runs', id))).not.toContain('metadata.json');
  }
});
it.each(['close', 'error'])('CLI %s drains the actual output/metadata tail', async event => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); seam.child = child;
  const reached = deferred(); const commit = deferred(); const complete = deferred();
  seam.beforeWrite = async path => { if (path === metadataPath) { reached.resolve(); await commit.promise; } };
  const leaseStates = [];
  await runner().executeCliRun({ runId: 'example', provider, prompt: 'Example', timeout: 10000,
    onComplete: () => { leaseStates.push(holdsBackupAssetPublication()); complete.resolve(); } });
  child.stdout.emit('data', 'Example CLI output'); child.emit(event, event === 'error' ? new Error('Example spawn error') : 0);
  await reached.promise;
  let ready = false; const cut = acquireBackupSnapshotCut().then(release => { ready = true; return release; });
  try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
  await complete.promise; const release = await cut;
  try { await assertPair(); expect(leaseStates).toEqual([false]); } finally { release(); }
});
it('deletion waits for the cut before removing a recording tree', async () => {
  const release = await acquireBackupSnapshotCut(); const work = runner().deleteRun('example');
  try { await settle(); await assertPair(); } finally { release(); }
  expect(await work).toBe(true); expect(await readdir(join(root, 'runs'))).toEqual([]);
});

it('creation waits out an open cut before publishing any file in its new run', async () => {
  const release = await acquireBackupSnapshotCut();
  let writes = 0; seam.beforeWrite = async () => { writes++; };
  const work = runner().createRun({ providerId: provider.id, prompt: 'Example' });
  try { await settle(); await settle(); expect(writes).toBe(0); }
  finally { release(); }
  await work; expect(writes).toBe(3);
});
