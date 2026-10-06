import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: await mkdtemp(join(tmpdir(), 'cos-storage-')), state: {}, config: {}, trusted: true, failWrite: false, corruptVerification: false, onWrite: null };
});
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: fixture.root,
  readAgentsStateForSafetyCheck: async () => ({ trusted: fixture.trusted, agents: fixture.state }),
  loadConfig: async () => fixture.config,
  saveConfig: async value => { fixture.config = value; },
  withConfigLock: createFileWriteQueue(), withStateLock: createFileWriteQueue(),
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const { Readable } = await import('node:stream');
  return { ...actual, createReadStream: (path, ...args) => fixture.corruptVerification && String(path).endsWith('.tmp')
    ? Readable.from('invalid gzip') : actual.createReadStream(path, ...args) };
});
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: async (path, data) => {
    await actual.atomicWrite(path, data);
    if (path.endsWith('raw-storage.json')) await fixture.afterManifest?.();
  }, createWriteStreamGuarded: async (...args) => {
    if (fixture.failWrite) throw new Error('disk full');
    await fixture.onWrite?.();
    return actual.createWriteStreamGuarded(...args);
  } };
});
vi.mock('../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => {
    fixture.onAdmission?.();
    return fixture.bypassAdmission ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('./codexSummaryRepair.js', () => ({ repairCodexTaskSummary: async () => null }));
const storage = await import('./cosAgentStorage.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { pruneOldAgentArchives } = await import('./cosAgentIndex.js');
const { default: routes } = await import('../routes/dataManager.js');
const app = express();
app.use(express.json()); app.use('/api/data', routes); app.use(errorMiddleware);
const date = '2001-01-01';
const source = 'Example terminal redraw\n'.repeat(4000);
const runDir = id => join(fixture.root, date, id);
async function seed(id = 'agent-example', metadata = {}) {
  const dir = runDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, status: 'completed', completedAt: `${date}T12:00:00Z`, result: { success: true, cost: 0.01 }, metadata: { model: 'example-model', taskSummary: 'Fixed an example defect', ...metadata } }));
  for (const [name, text] of [['raw.txt', source], ['output.txt', 'Retained useful output'], ['prompt.txt', 'Example instructions'], ['evidence.json', '{"keep":true}']]) {
    await writeFile(join(dir, name), text);
    await utimes(join(dir, name), new Date(date), new Date(date));
  }
  return dir;
}
async function settled() {
  await vi.waitFor(async () => expect((await storage.getAgentStorageStatus()).job?.finishedAt).toBeTruthy());
  // Completion's config audit is part of the job boundary.
  await vi.waitFor(() => expect(fixture.config.lastAgentStorageJob).toBeTruthy());
  return (await storage.getAgentStorageStatus()).job;
}
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root);
  fixture.state = {}; fixture.config = {}; fixture.trusted = true;
  fixture.failWrite = false; fixture.corruptVerification = false; fixture.onWrite = null;
  fixture.afterManifest = null; fixture.onAdmission = null; fixture.bypassAdmission = false;
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

it('compresses through HTTP, verifies bytes, serves the gzip, and preserves old history and unknown evidence', async () => {
  const dir = await seed();
  const before = await readFile(join(dir, 'metadata.json'), 'utf8');
  await pruneOldAgentArchives(1);
  const preview = await request(app).post('/api/data/cos/storage/preview').send({ action: 'compress' });
  expect(preview.status).toBe(200);
  expect(preview.body.totals.eligibleRuns).toBe(1);
  const started = await request(app).post('/api/data/cos/storage/run').send({ token: preview.body.token });
  expect(started.status).toBe(200);
  const result = await settled();
  expect(result.state).toBe('completed');
  expect(result.reclaimedBytes).toBeGreaterThan(0);
  expect(gunzipSync(await readFile(join(dir, 'raw.txt.gz'))).toString()).toBe(source);
  expect(await readFile(join(dir, 'metadata.json'), 'utf8')).toBe(before);
  expect(await readFile(join(dir, 'output.txt'), 'utf8')).toBe('Retained useful output');
  expect(await readFile(join(dir, 'evidence.json'), 'utf8')).toBe('{"keep":true}');
  const download = await storage.getAgentRecordingDownload(date, 'agent-example');
  expect(download.name).toBe('raw.txt.gz');
  expect((await storage.previewAgentStorage({ action: 'compress' })).totals.eligibleRuns).toBe(0);
});

it('requires purge confirmation and retained evidence, keeps metadata and exposes the purged state', async () => {
  const dir = await seed(); await seed('agent-no-summary', { taskSummary: '' });
  const preview = await storage.previewAgentStorage({ action: 'purge' });
  expect(preview.totals.eligibleRuns).toBe(1);
  expect((await request(app).post('/api/data/cos/storage/run').send({ token: preview.token })).status).toBe(400);
  await storage.startAgentStorage({ token: preview.token, confirmation: 'PURGE RAW RECORDINGS' });
  expect((await settled()).reclaimedBytes).toBe(Buffer.byteLength(source));
  expect(await readFile(join(dir, 'metadata.json'), 'utf8')).toContain('Fixed an example defect');
  expect(await readFile(join(dir, 'prompt.txt'), 'utf8')).toBe('Example instructions');
  expect((await storage.previewAgentStorage({ action: 'purge' })).rows.find(row => row.id === 'agent-example').state).toBe('purged');
  await expect(storage.getAgentRecordingDownload(date, 'agent-example')).rejects.toMatchObject({ status: 404 });
});

it('revalidates stale previews, pins during compression, and fails closed on unreadable live state', async () => {
  const dir = await seed();
  const stale = await storage.previewAgentStorage({});
  fixture.state = { 'agent-example': { status: 'paused' } };
  await storage.startAgentStorage({ token: stale.token });
  expect((await settled()).skipped).toBe(1);
  fixture.state = {}; fixture.config.lastAgentStorageJob = null;
  const preview = await storage.previewAgentStorage({});
  fixture.onWrite = () => storage.pinAgentRecording({ date, id: 'agent-example', pinned: true });
  await storage.startAgentStorage({ token: preview.token });
  expect((await settled()).skipped).toBe(1);
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
  fixture.trusted = false;
  expect((await storage.previewAgentStorage({})).totals.eligibleRuns).toBe(0);
});

it.each(['failWrite', 'corruptVerification'])('keeps original recordings and removes temporary output on %s', async failure => {
  const dir = await seed(); fixture[failure] = true;
  const preview = await storage.previewAgentStorage({});
  await storage.startAgentStorage({ token: preview.token });
  expect((await settled()).failed).toBe(1);
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
  expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('recovers a published gzip with its plain source still present and keeps compression defaults non-destructive', async () => {
  const dir = await seed();
  await writeFile(join(dir, 'raw.txt.gz'), gzipSync(source));
  await utimes(join(dir, 'raw.txt.gz'), new Date(date), new Date(date));
  const preview = await storage.previewAgentStorage({});
  await storage.startAgentStorage({ token: preview.token });
  expect((await settled()).state).toBe('completed');
  expect(gunzipSync(await readFile(join(dir, 'raw.txt.gz'))).toString()).toBe(source);
  expect((await storage.getAgentStorageStatus()).policy).toMatchObject({ autoCompress: true, autoPurge: false });
});

it('cancels safely before publication and protects preserved worktrees', async () => {
  const dir = await seed();
  await seed('agent-resumable', { isWorktree: true, workspacePath: fixture.root });
  const preview = await storage.previewAgentStorage({});
  expect(preview.totals.eligibleRuns).toBe(1);
  fixture.onWrite = () => storage.cancelAgentStorage();
  await storage.startAgentStorage({ token: preview.token });
  expect((await settled()).state).toBe('cancelled');
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
});

it('rechecks opt-in policy before automatic publication and does no deletion by default', async () => {
  const dir = await seed();
  fixture.config.agentStorage = { autoCompress: true, compressAfterDays: 7, autoPurge: false, purgeAfterDays: 90 };
  fixture.onWrite = () => { fixture.config.agentStorage.autoCompress = false; };
  await storage.runAutomaticAgentStorage();
  expect((await settled()).skipped).toBe(1);
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
  expect(await readFile(join(dir, 'metadata.json'), 'utf8')).toContain('example-model');
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settleTurn = () => new Promise(resolve => setImmediate(resolve));
const startStorageAction = async action => {
  const preview = await storage.previewAgentStorage({ action });
  await storage.startAgentStorage({ token: preview.token, ...(action === 'purge' ? { confirmation: 'PURGE RAW RECORDINGS' } : {}) });
};
const expectSettledRecording = async (dir, action) => {
  const manifest = JSON.parse(await readFile(join(dir, 'raw-storage.json'), 'utf8'));
  expect(manifest.disposition).toBe(action === 'compress' ? 'compressed' : 'purged');
  const names = await readdir(dir);
  expect(names).not.toContain('raw.txt');
  if (action === 'compress') expect(gunzipSync(await readFile(join(dir, 'raw.txt.gz'))).toString()).toBe(source);
  else expect(names).not.toContain('raw.txt.gz');
  expect(names.some(name => name.endsWith('.tmp'))).toBe(false);
};

it.each(['compress', 'purge'])('%s waits out an open backup cut before changing bytes or manifest', async action => {
  const dir = await seed();
  const reached = deferred(); fixture.onAdmission = reached.resolve;
  const release = await acquireBackupSnapshotCut();
  try {
    await startStorageAction(action);
    await reached.promise;
    await settleTurn();
    expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
    expect(await readdir(dir)).not.toContain('raw-storage.json');
    expect(await readdir(dir)).not.toContain('raw.txt.gz');
  } finally { release(); }
  expect((await settled()).state).toBe('completed');
  await expectSettledRecording(dir, action);
});

it.each(['compress', 'purge'])('%s drains the file-primary manifest and byte deletion together', async action => {
  const dir = await seed();
  const reached = deferred(); const commit = deferred();
  fixture.afterManifest = async () => { reached.resolve(); await commit.promise; };
  await startStorageAction(action);
  await reached.promise;
  let cutReady = false;
  const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
  try { await settleTurn(); expect(cutReady).toBe(false); }
  finally { commit.resolve(); }
  const release = await cut;
  try { await expectSettledRecording(dir, action); }
  finally { release(); }
  expect((await settled()).state).toBe('completed');
});

it('negative control publishes compressed bytes and manifest during an open cut', async () => {
  const dir = await seed(); fixture.bypassAdmission = true;
  const copiedNames = await readdir(dir);
  const release = await acquireBackupSnapshotCut();
  try {
    await startStorageAction('compress');
    await settled();
    await expectSettledRecording(dir, 'compress');
    expect(copiedNames).not.toContain('raw.txt.gz');
  } finally { release(); }
});
