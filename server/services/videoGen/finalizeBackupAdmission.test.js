/** Real copied assets/history against shared generated-video publication. */
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({
  bypass: false, admission: null, historyGate: null, unlinkGate: null, faststartGate: null,
  failHistory: false, failFaststart: false, thumbnailFailure: null, child: null, input: null, localChild: null,
}));
vi.mock('../../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-generated-video-cut-'),
    overrides: {
      atomicWrite: async (path, value) => {
        if (basename(path) === 'video-history.json') {
          state.historyGate?.entered.resolve();
          if (state.historyGate) await state.historyGate.finish.promise;
          if (state.failHistory) throw new Error('history commit failed');
        }
        return actual.atomicWrite(path, value);
      },
      unlinkGuarded: async path => {
        if (state.unlinkGate?.matches(path)) {
          state.unlinkGate.entered.resolve();
          await state.unlinkGate.finish.promise;
        }
        return actual.unlinkGuarded(path);
      },
    },
  });
});
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...(await importOriginal()), assertDatabaseAdmission: () => {},
}));
vi.mock('../../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => {
    state.admission?.resolve();
    return state.bypass ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('../../lib/ffmpeg.js', () => ({
  probeFrameCount: async () => 25,
  probeVideoDuration: async () => 1,
  optimizeForStreaming: vi.fn(async path => {
    await writeFile(`${path}.fs.mp4`, 'faststart staging');
    state.faststartGate?.entered.resolve();
    if (state.faststartGate) await state.faststartGate.finish.promise;
    if (state.failFaststart) throw new Error('faststart failed');
    await rm(`${path}.fs.mp4`);
  }),
  generateThumbnail: vi.fn(async (_path, id) => {
    const { PATHS } = await import('../../lib/fileUtils.js');
    await writeFile(join(PATHS.videoThumbnails, `${id}.jpg`), `poster:${id}`);
    if (state.thumbnailFailure === 'throw') throw new Error('poster failed');
    return state.thumbnailFailure === 'null' ? null : `${id}.jpg`;
  }),
  extractEvaluationFrames: vi.fn(async () => []),
}));
vi.mock('../../lib/childProcess.js', async importOriginal => ({
  ...(await importOriginal()), spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(),
      kill: vi.fn(() => queueMicrotask(() => child.emit('close', null, 'SIGTERM'))),
    });
    child.stdin.end = body => { state.input = JSON.parse(body); };
    state.child = child;
    return child;
  },
}));
vi.mock('./reactorRuntime.js', () => ({ ensureReactorRuntime: async () => 'synthetic-python' }));
vi.mock('../settings.js', () => ({ getSettings: async () => ({ videoGen: { reactor: { apiKey: 'example-key' } } }) }));
vi.mock('../../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: async () => ({ ok: true, release: async () => {}, handoffTo: async () => {} }) }));
vi.mock('../../lib/detachedSpawn.js', () => ({ spawnDetached: async () => state.localChild }));
vi.mock('../localMemory.js', () => ({ prepareLocalMemory: async () => ({ blockers: [], unloaded: [] }), gpuBlockersMessage: () => '' }));
vi.mock('../hfToken.js', () => ({ hfChildEnv: async () => ({}) }));
vi.mock('./runtimes.js', () => ({
  BYOV_RUNTIME_INFO: {}, runtimeIsCacheOnly: () => false, runtimeNeedsProcessGroupKill: () => false,
  runtimeUsesMlx: () => false, invalidateByovReadyCache: () => {}, pickDeathFingerprint: async () => null,
}));
vi.mock('./displayPower.js', () => ({ isDisplaySleepEnabled: () => false, sleepDisplayForVideo: () => {}, wakeDisplayForVideo: () => {} }));
vi.mock('fs', async importOriginal => ({ ...(await importOriginal()), watch: () => ({ close: () => {} }) }));

console.log('🧪 Finalizer fixture collection: filesystem');
const { PATHS } = await import('../../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
console.log('🧪 Finalizer fixture collection: history and finalizer');
const { loadHistory, saveHistory, mutateVideoHistory } = await import('./history.js');
const { finalizeGeneratedVideo } = await import('./generateVideoHelpers.js');
const { videoGenEvents } = await import('./events.js');
console.log('🧪 Finalizer fixture collection: Reactor');
const reactor = await import('./reactor.js');
console.log('🧪 Finalizer fixture collection: local caller');
const { spawnAndWatchVideo } = await import('./spawnWatch.js');
const { videoJobState } = await import('./jobState.js');
console.log('🧪 Finalizer fixture collection: ready');
const { it, drain } = ownTestBodies(vitestIt);
const operations = new Set();
function own(fn) {
  const run = Promise.resolve().then(fn);
  const settled = run.then(() => {}, () => {});
  operations.add(settled);
  settled.then(() => operations.delete(settled));
  return run;
}
const gates = [];
const gate = () => {
  const value = { entered: Promise.withResolvers(), finish: Promise.withResolvers() };
  gates.push(value);
  return value;
};
const settleTurn = () => new Promise(resolve => setImmediate(resolve));
const pathOf = id => join(PATHS.videos, `${id}.mp4`);
const ctx = (id, extras = {}) => ({
  job: { status: 'running', clients: [] }, jobId: id, outputPath: pathOf(id), filename: `${id}.mp4`,
  meta: { id, filename: `${id}.mp4`, prompt: 'Synthetic clip', modelId: 'fixture' },
  actualSeed: 1, mutateHistory: mutateVideoHistory, ...extras,
});
async function produce(id) { await writeFile(pathOf(id), `video:${id}`); }
async function copyAssets() {
  const root = join(PATHS.data, 'copied');
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  await cp(PATHS.videos, join(root, 'videos'), { recursive: true });
  await cp(PATHS.videoThumbnails, join(root, 'posters'), { recursive: true });
  return root;
}
async function copyHistory(root) {
  await cp(join(PATHS.data, 'video-history.json'), join(root, 'history.json'));
  return JSON.parse(await readFile(join(root, 'history.json'), 'utf8'));
}
function missing(root, history) {
  return history.flatMap(row => [
    row.filename && join(root, 'videos', row.filename),
    row.thumbnail && join(root, 'posters', row.thumbnail),
  ].filter(path => path && !existsSync(path)));
}
beforeEach(async () => {
  Object.assign(state, { bypass: false, admission: null, historyGate: null, unlinkGate: null,
    faststartGate: null, failHistory: false, failFaststart: false, thumbnailFailure: null, child: null, input: null, localChild: null });
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  await saveHistory([]);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ jwt: 'example-jwt' }) })));
  vi.stubEnv('REACTOR_API_KEY', '');
});
afterEach(async () => {
  for (const value of gates.splice(0)) value.finish.resolve();
  reactor.cancelAll();
  await vi.waitFor(() => expect(reactor.getActiveJob()).toBeNull());
  if (state.localChild && state.localChild.exitCode == null) {
    state.localChild.exitCode = 1;
    state.localChild.emit('close', 1, null);
  }
  while (operations.size) await Promise.all(operations);
  await drain();
  videoGenEvents.removeAllListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  videoJobState.jobs.clear();
  videoJobState.activeProcess = null;
  state.failHistory = false;
  await rm(PATHS.videos, { recursive: true, force: true });
  await rm(PATHS.videoThumbnails, { recursive: true, force: true });
});
afterAll(async () => { await drain(); await cleanupTempDataRoots(); });

describe('generated-video backup publication', () => {
  it('holds a finalizer out of a cut; bypass publishes between asset and history copies', async () => {
    const cut = await acquireBackupSnapshotCut();
    let run;
    try {
      const copied = await copyAssets();
      await produce('held');
      const context = ctx('held');
      state.admission = Promise.withResolvers();
      run = own(() => finalizeGeneratedVideo(context));
      await state.admission.promise;
      await settleTurn();
      expect(context.job.status).toBe('running');
      expect(await copyHistory(copied)).toEqual([]);
    } finally { cut(); await run; }
    await saveHistory([]);
    await rm(PATHS.videos, { recursive: true, force: true });
    await mkdir(PATHS.videos);
    state.bypass = true;
    const copied = await copyAssets();
    await produce('bypassed');
    await finalizeGeneratedVideo(ctx('bypassed'));
    expect(missing(copied, await copyHistory(copied))).toHaveLength(2);
  });

  for (const phase of ['faststart', 'history']) it(`drains an active ${phase} through the copied history pair`, async () => {
    await produce('drain');
    const blocked = gate();
    if (phase === 'faststart') state.faststartGate = blocked;
    else state.historyGate = blocked;
    const publication = {};
    const context = ctx('drain', { publication });
    const run = own(() => finalizeGeneratedVideo(context));
    await blocked.entered.promise;
    let acquired = false;
    const cutting = acquireBackupSnapshotCut().then(cut => { acquired = true; return cut; });
    let cut;
    try {
      await settleTurn();
      expect(acquired).toBe(false);
      expect(context.job.status).toBe('running');
      blocked.finish.resolve();
      await run;
      cut = await cutting;
      const root = await copyAssets();
      const history = await copyHistory(root);
      expect(history).toHaveLength(1);
      expect(missing(root, history)).toEqual([]);
      expect(publication.committed).toBe(true);
    } finally {
      blocked.finish.resolve();
      await run.catch(() => {});
      (cut || await cutting)();
    }
  });

  it('drains failed-history rollback before a cut can copy partial outputs', async () => {
    await produce('rollback');
    state.failHistory = true;
    const blocked = gate();
    blocked.matches = path => path === pathOf('rollback');
    state.unlinkGate = blocked;
    const context = ctx('rollback');
    const run = own(() => finalizeGeneratedVideo(context)).then(() => null, error => error);
    await blocked.entered.promise;
    let acquired = false;
    const cutting = acquireBackupSnapshotCut().then(cut => { acquired = true; return cut; });
    let cut;
    try {
      await settleTurn();
      expect(acquired).toBe(false);
      blocked.finish.resolve();
      expect((await run).message).toBe('history commit failed');
      cut = await cutting;
      const root = await copyAssets();
      expect(await copyHistory(root)).toEqual([]);
      expect(await readdir(PATHS.videos)).toEqual([]);
      expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
      expect(context.job.status).toBe('running');
    } finally {
      blocked.finish.resolve();
      await run;
      (cut || await cutting)();
    }
  });

  for (const phase of ['faststart', 'poster']) it(`removes a failed ${phase}'s pre-tracked partial bytes`, async () => {
    await produce('partial');
    if (phase === 'faststart') state.failFaststart = true;
    else state.thumbnailFailure = 'throw';
    await expect(finalizeGeneratedVideo(ctx('partial'))).rejects.toThrow(/failed/);
    expect(await loadHistory()).toEqual([]);
    expect(await readdir(PATHS.videos)).toEqual([]);
    expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
  });

  it('keeps thumbnail-less compatibility and removes the partial poster', async () => {
    await produce('no-poster');
    state.thumbnailFailure = 'null';
    expect(await finalizeGeneratedVideo(ctx('no-poster'))).toBeNull();
    expect(await loadHistory()).toEqual([expect.objectContaining({ thumbnail: null })]);
    expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
    expect(existsSync(pathOf('no-poster'))).toBe(true);
  });

  it('preserves the committed pair when completion dispatch throws', async () => {
    await produce('dispatch');
    const publication = {};
    vi.spyOn(videoGenEvents, 'emit').mockImplementation(() => { throw new Error('dispatch failed'); });
    await expect(finalizeGeneratedVideo(ctx('dispatch', { publication }))).rejects.toThrow('dispatch failed');
    expect(publication.committed).toBe(true);
    const root = await copyAssets();
    expect(missing(root, await copyHistory(root))).toEqual([]);
    expect(await loadHistory()).toHaveLength(1);
  });

  it('preserves an already committed nonterminal member when the next member fails', async () => {
    const job = { status: 'running', clients: [] };
    await produce('member-one');
    await finalizeGeneratedVideo(ctx('member-one', { job, terminal: false }));
    expect(job.status).toBe('running');
    await produce('member-two');
    state.failHistory = true;
    await expect(finalizeGeneratedVideo(ctx('member-two', { job, terminal: false }))).rejects.toThrow('history commit failed');
    expect((await loadHistory()).map(row => row.id)).toEqual(['member-one']);
    expect(await readdir(PATHS.videos)).toEqual(['member-one.mp4']);
    const root = await copyAssets();
    expect(missing(root, await copyHistory(root))).toEqual([]);
  });

  it('local batch failure cleans only unpublished members through the real caller', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 101, stdout: new EventEmitter(), stderr: new EventEmitter(),
      exitCode: null, signalCode: null, killed: false,
      kill: vi.fn(() => { child.killed = true; }),
    });
    state.localChild = child;
    const job = { status: 'running', clients: [] };
    const batch = [0, 1].map(index => ({ id: `batch-${index}`, filename: `batch-${index}.mp4`, index, seed: index + 1 }));
    const failed = Promise.withResolvers();
    videoGenEvents.on('failed', failed.resolve);
    await spawnAndWatchVideo({
      ...ctx('batch-job', { job }), batch, cleanupTempFiles: async () => {},
      stepwiseDir: join(PATHS.data, 'preview'), bin: 'synthetic-python', args: ['synthetic-render'],
      model: { runtime: 'fixture' }, modelId: 'fixture', width: 512, height: 512,
      numFrames: 25, steps: 8, videoGenSettings: {},
    });
    await produce(batch[0].id);
    child.stdout.emit('data', `${JSON.stringify({ video_path: pathOf(batch[0].id), batch_index: 0, seed: 1 })}\n`);
    await vi.waitFor(async () => expect((await loadHistory()).map(row => row.id)).toEqual([batch[0].id]));
    state.failHistory = true;
    await produce(batch[1].id);
    child.stdout.emit('data', `${JSON.stringify({ video_path: pathOf(batch[1].id), batch_index: 1, seed: 2 })}\n`);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    child.exitCode = 1;
    child.emit('close', 1, null);
    await failed.promise;
    const root = await copyAssets();
    const history = await copyHistory(root);
    expect(history.map(row => row.id)).toEqual([batch[0].id]);
    expect(await readdir(PATHS.videos)).toEqual([batch[0].filename]);
    expect(missing(root, history)).toEqual([]);
  });

  for (const failure of ['cleanup rejection', 'child error']) it(`local close drains an accepted member before ${failure} can discard it`, async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 101, stdout: new EventEmitter(), stderr: new EventEmitter(),
      exitCode: null, signalCode: null, killed: false, kill: vi.fn(),
    });
    state.localChild = child;
    const batch = [0, 1].map(index => ({ id: `close-${index}`, filename: `close-${index}.mp4`, index, seed: index + 1 }));
    const failed = Promise.withResolvers();
    videoGenEvents.on('failed', failed.resolve);
    await spawnAndWatchVideo({
      ...ctx('close-job'), batch,
      cleanupTempFiles: async () => { if (failure === 'cleanup rejection') throw new Error('cleanup failed'); },
      stepwiseDir: join(PATHS.data, 'preview'), bin: 'synthetic-python', args: ['synthetic-render'],
      model: { runtime: 'fixture' }, modelId: 'fixture', width: 512, height: 512,
      numFrames: 25, steps: 8, videoGenSettings: {},
    });
    await produce(batch[0].id);
    state.historyGate = gate();
    child.stdout.emit('data', `${JSON.stringify({ video_path: pathOf(batch[0].id), batch_index: 0, seed: 1 })}\n`);
    await state.historyGate.entered.promise;
    if (failure === 'child error') child.emit('error', new Error('child failed'));
    child.exitCode = 0;
    child.emit('close', 0, null);
    try {
      await settleTurn();
      expect(existsSync(pathOf(batch[0].id))).toBe(true);
      expect(existsSync(join(PATHS.videoThumbnails, `${batch[0].id}.jpg`))).toBe(true);
      expect(await loadHistory()).toEqual([]);
    } finally { state.historyGate.finish.resolve(); }
    await failed.promise;
    const root = await copyAssets();
    const history = await copyHistory(root);
    expect(history.map(row => row.id)).toEqual([batch[0].id]);
    expect(missing(root, history)).toEqual([]);
  });

  it('Reactor refuses cancellation during publication and preserves output after a dispatch error', async () => {
    const original = videoGenEvents.emit.bind(videoGenEvents);
    const failed = Promise.withResolvers();
    videoGenEvents.on('failed', failed.resolve);
    vi.spyOn(videoGenEvents, 'emit').mockImplementation((type, ...args) => {
      if (type === 'completed') throw new Error('dispatch failed');
      return original(type, ...args);
    });
    const job = await reactor.generateVideo({ prompt: 'Synthetic clip', seconds: 6 });
    await vi.waitFor(() => expect(state.input).not.toBeNull());
    await writeFile(state.input.outputPath, 'captured video');
    state.historyGate = gate();
    state.child.stdout.emit('data', `${JSON.stringify({ type: 'complete', frames: 144, seconds: 6, clipId: 'example-clip' })}\n`);
    state.child.emit('close', 0);
    await state.historyGate.entered.promise;
    expect(reactor.cancel(job.jobId)).toBe(false);
    state.historyGate.finish.resolve();
    await failed.promise;
    await vi.waitFor(() => expect(reactor.getActiveJob()).toBeNull());
    const root = await copyAssets();
    const history = await copyHistory(root);
    expect(history).toHaveLength(1);
    expect(missing(root, history)).toEqual([]);
  });
});
