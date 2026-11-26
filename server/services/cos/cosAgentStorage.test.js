import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { cosEvents } from './cosEvents.js';
import { computeEffectiveExcludes } from '../backup/excludes.js';
import { runRsync } from '../backup/rsync.js';
const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: await mkdtemp(join(tmpdir(), 'cos-storage-')), state: {}, config: {}, trusted: true, failWrite: false, corruptVerification: false, onWrite: null };
});
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: join(fixture.root, 'cos', 'agents'),
  readAgentsStateForSafetyCheck: async () => ({ trusted: fixture.trusted, agents: fixture.state }),
  loadConfig: async () => fixture.config,
  saveConfig: async value => { fixture.config = value; },
  withConfigLock: createFileWriteQueue(), withStateLock: createFileWriteQueue(),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, lstat: (path, ...args) => {
    fixture.onStat?.(path);
    return actual.lstat(path, ...args);
  }, readdir: (path, ...args) => {
    fixture.onReadDir?.(path);
    return actual.readdir(path, ...args);
  } };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const { Readable } = await import('node:stream');
  return { ...actual, createReadStream: (path, ...args) => fixture.corruptVerification && String(path).endsWith('.tmp')
    ? Readable.from('invalid gzip') : actual.createReadStream(path, ...args) };
});
vi.mock('../../lib/fileUtils.js', async importOriginal => {
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
vi.mock('../../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => {
    fixture.onAdmission?.();
    return fixture.bypassAdmission ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('../codexSummaryRepair.js', () => ({ repairCodexTaskSummary: async () => null }));
const storage = await import('./cosAgentStorage.js');
const { acquireBackupSnapshotCut, withBackupAssetPublication } = await import('../../lib/backupSnapshotBoundary.js');
const { withStateLock } = await import('./cosState.js');
const { default: routes } = await import('../../routes/dataManager.js');
const app = express();
app.use(express.json()); app.use('/api/data', routes); app.use(errorMiddleware);
const date = '2001-01-01';
const source = 'Example terminal redraw\n'.repeat(4000);
const recordingPath = id => join('cos', 'agents', date, id);
async function seed(id = 'agent-example', metadata = {}, bucket = date, completedAt = `${bucket}T12:00:00Z`) {
  const dir = join(fixture.root, 'cos', 'agents', bucket, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, status: 'completed', completedAt, result: { success: true, cost: 0.01 }, metadata: { model: 'example-model', taskSummary: 'Fixed an example defect', ...metadata } }));
  for (const [name, text] of [['raw.txt', source], ['output.txt', 'Retained useful output'], ['prompt.txt', 'Example instructions'], ['evidence.json', '{"keep":true}']]) {
    await writeFile(join(dir, name), text);
    await utimes(join(dir, name), new Date(date), new Date(date));
  }
  return dir;
}
async function settled() {
  const completion = Promise.withResolvers();
  const inspect = () => {
    void storage.getAgentStorageStatus().then(({ job }) => {
      // Real compression and backup admission may outlast a polling deadline.
      // Completion includes the persisted audit for this job, not a prior run.
      if (job?.finishedAt && fixture.config.lastAgentStorageJob?.id === job.id) completion.resolve(job);
    }, completion.reject);
  };
  cosEvents.on('storage:changed', inspect);
  inspect(); // Covers a job that finished before this caller subscribed.
  try {
    const job = await completion.promise;
    expect(job.finishedAt).toBeTruthy();
    expect(fixture.config.lastAgentStorageJob).toMatchObject({ id: job.id, finishedAt: job.finishedAt });
    return job;
  } finally { cosEvents.off('storage:changed', inspect); }
}
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root);
  fixture.state = {}; fixture.config = {}; fixture.trusted = true;
  fixture.failWrite = false; fixture.corruptVerification = false; fixture.onWrite = null;
  fixture.afterManifest = null; fixture.onAdmission = null; fixture.bypassAdmission = false;
  fixture.onStat = null; fixture.onReadDir = null;
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

it('compresses through HTTP, verifies bytes, serves the gzip, and preserves old history and unknown evidence', async () => {
  const dir = await seed();
  const before = await readFile(join(dir, 'metadata.json'), 'utf8');
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

it('keeps interactive preview totals and ordered pages exact across batches while serializing live references once', async () => {
  await Promise.all(Array.from({ length: 18 }, (_, index) => seed(`agent-${String(index).padStart(2, '0')}`)));
  await seed('agent-other', { model: 'other-model' });
  const unreadable = await seed('agent-unreadable');
  await writeFile(join(unreadable, 'metadata.json'), '{');
  const liveMetadata = vi.fn(() => ({ nested: { ref: 'prefix/agent-01/suffix' } }));
  fixture.state = { 'agent-live': { metadata: { toJSON: liveMetadata } } };
  const statPaths = [];
  fixture.onStat = path => statPaths.push(path);

  const preview = await storage.previewAgentStorage({ model: 'example-model' }, { offset: 15, limit: 1 });
  expect(preview.totals).toMatchObject({ scanned: 20, unreadable: 1, recordingBytes: 18 * Buffer.byteLength(source), eligibleRuns: 1 });
  expect(preview.models).toEqual(['example-model', 'other-model']);
  expect(preview.matching).toBe(18);
  expect(preview.reasons).toEqual({ 'Referenced by a live run': 1, 'Next batch': 16 });
  expect(preview.rows.map(row => row.id)).toEqual(['agent-15', 'agent-16', 'agent-17']);
  expect(liveMetadata).toHaveBeenCalledTimes(1);
  const metadataPaths = statPaths.filter(path => basename(path) === 'metadata.json');
  expect(metadataPaths).toHaveLength(20);
  expect(new Set(metadataPaths).size).toBe(20);
  expect(statPaths.filter(path => basename(path) === date)).toHaveLength(1);

  const started = await storage.startAgentStorage({ token: preview.token });
  expect(started.job.total).toBe(1);
  expect(await settled()).toMatchObject({ processed: 1, skipped: 0 });
  expect((await storage.getAgentRecordingDownload(date, 'agent-00')).name).toBe('raw.txt.gz');
});

it('stops automatic discovery at 25 eligible candidates and leaves later runs for the next tick', async () => {
  await Promise.all(Array.from({ length: 27 }, (_, index) => seed(`agent-${String(index).padStart(2, '0')}`)));
  const scannedIds = new Set();
  fixture.onStat = path => {
    if (basename(path) === 'metadata.json') scannedIds.add(basename(dirname(path)));
  };
  fixture.onWrite = () => {
    fixture.config.agentStorage = { autoCompress: false };
  };
  await storage.runAutomaticAgentStorage();
  expect(await settled()).toMatchObject({ total: 25, skipped: 25 });
  expect([...scannedIds].sort()).toEqual(Array.from({ length: 25 }, (_, index) => `agent-${String(index).padStart(2, '0')}`));
});

it('shares automatic fallback discovery, retains the one-day buffer, and skips newer date buckets', async () => {
  const old = await seed('agent-absent');
  await rm(join(old, 'raw.txt'));
  const now = Date.now();
  const day = 86400000;
  const retentionDay = new Date(now - 7 * day).toISOString().slice(0, 10);
  const bufferDay = new Date(now - 6 * day).toISOString().slice(0, 10);
  const recentDay = new Date(now).toISOString().slice(0, 10);
  await seed('agent-buffer', {}, bufferDay, `${retentionDay}T00:00:00Z`);
  await seed('agent-recent', {}, recentDay);
  fixture.config.agentStorage = { autoPurge: true, autoCompress: true };
  const inspectedOld = vi.fn();
  const openedBuckets = [];
  fixture.onStat = path => {
    if (path === join(old, 'metadata.json')) inspectedOld();
  };
  fixture.onReadDir = path => openedBuckets.push(basename(path));

  await storage.runAutomaticAgentStorage();
  expect(await settled()).toMatchObject({ action: 'compress', total: 1, skipped: 0 });
  expect(inspectedOld).toHaveBeenCalledTimes(1);
  expect(openedBuckets).toContain(bufferDay);
  expect(openedBuckets).not.toContain(recentDay);
  expect((await storage.getAgentRecordingDownload(bufferDay, 'agent-buffer')).name).toBe('raw.txt.gz');
});

it('gives eligible automatic purges priority and rechecks live references inside the publication boundary', async () => {
  const dir = await seed();
  fixture.config.agentStorage = { autoPurge: true, autoCompress: true };
  fixture.onAdmission = () => {
    fixture.state = { 'agent-live': { metadata: { resumedFrom: 'agent-example' } } };
  };
  await storage.runAutomaticAgentStorage();
  expect(await settled()).toMatchObject({ action: 'purge', total: 1, skipped: 1 });
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
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

it('copies published recordings and nearby files during a cut while verified compression waits to publish', async context => {
  if (process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT') {
    context.skip('Windows runner has no rsync executable; real rsync remains required on Linux/macOS.');
    return;
  }
  const id = 'agent-example';
  const dir = await seed(id);
  const nearby = 'raw.txt.gz.00000000-0000-4000-7000-000000000001.tmp';
  await writeFile(join(dir, nearby), 'unrelated file');
  await writeFile(join(dir, 'raw.txt.gz'), gzipSync('prior published recording'));
  await utimes(join(dir, 'raw.txt.gz'), new Date(date), new Date(date));
  const snapshot = await mkdtemp(join(dirname(fixture.root), 'cos-storage-cut-'));
  const reached = deferred();
  fixture.onAdmission = reached.resolve;
  const release = await acquireBackupSnapshotCut();
  let started = false;
  try {
    await startStorageAction('compress');
    started = true;
    await reached.promise;
    const stage = (await readdir(dir)).find(name => name.endsWith('.tmp') && name !== nearby);
    expect(stage).toBeDefined();
    expect(gunzipSync(await readFile(join(dir, stage))).toString()).toBe(source);
    await writeFile(join(fixture.root, stage), 'same basename outside the CoS archive');

    const defaults = computeEffectiveExcludes();
    const flags = computeEffectiveExcludes({ disabledDefaultExcludes: defaults }).flatMap(path => ['--exclude', path]);
    await runRsync(fixture.root, snapshot, flags);
    const copied = join(snapshot, recordingPath(id));
    await expect(readFile(join(copied, stage))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(copied, nearby), 'utf8')).toBe('unrelated file');
    expect(await readFile(join(snapshot, stage), 'utf8')).toBe('same basename outside the CoS archive');
    expect(await readFile(join(copied, 'raw.txt'), 'utf8')).toBe(source);
    expect(gunzipSync(await readFile(join(copied, 'raw.txt.gz'))).toString()).toBe('prior published recording');
  } finally {
    release();
    await rm(snapshot, { recursive: true, force: true });
    if (started) expect(await settled()).toMatchObject({ state: 'completed', skipped: 0 });
  }
  await expect(readFile(join(dir, 'raw.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(gunzipSync(await readFile(join(dir, 'raw.txt.gz'))).toString()).toBe(source);
  expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([nearby]);
});

it('waits for active staging before scrubbing and retires a pending candidate even when the plain file is unchanged', async () => {
  const dir = await seed();
  const writing = deferred();
  const resume = deferred();
  fixture.onWrite = async () => { writing.resolve(); await resume.promise; };
  await startStorageAction('compress');
  await writing.promise;
  const scrubAdmitted = deferred();
  let scrubFinished = false;
  const scrub = withBackupAssetPublication(() => withStateLock(async () => {
    scrubAdmitted.resolve();
    // The revoked fact may exist only in residue, so the source fingerprint
    // can stay identical even though this candidate has been invalidated.
    await storage.scrubAgentRecordings(dir, ['absent synthetic fact']);
    scrubFinished = true;
  }));
  try {
    await scrubAdmitted.promise;
    await settleTurn();
    expect(scrubFinished).toBe(false);
  } finally {
    resume.resolve();
    await scrub;
    expect(await settled()).toMatchObject({ state: 'completed', skipped: 1, failed: 0 });
  }
  expect(await readFile(join(dir, 'raw.txt'), 'utf8')).toBe(source);
  expect((await readdir(dir)).filter(name => name.startsWith('raw.txt'))).toEqual(['raw.txt']);
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
