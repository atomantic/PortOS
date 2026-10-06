/** Real file/history cuts through derived video service entrypoints. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({ bypass: false, admission: null, historyGate: null, failHistory: false, rollback: null }));
vi.mock('../../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-derived-video-cut-'), overrides: {
    atomicWrite: async (path, data) => {
      if (basename(path) === 'video-history.json') {
        state.historyGate?.entered.resolve();
        if (state.historyGate) await state.historyGate.finish.promise;
        if (state.failHistory) throw new Error('history refused');
      }
      return actual.atomicWrite(path, data);
    },
    unlinkGuarded: async path => {
      if (state.rollback && path.startsWith(lazyTempDataRoot('portos-derived-video-cut-'))) {
        state.rollback.entered.resolve();
        await state.rollback.finish.promise;
      }
      return actual.unlinkGuarded(path);
    },
  } });
});
vi.mock('../../lib/databaseMaintenanceJournal.js', async original => ({ ...(await original()), assertDatabaseAdmission: () => {} }));
vi.mock('../../lib/backupSnapshotBoundary.js', async original => {
  const actual = await original();
  return { ...actual, withBackupAssetPublication: work => {
    state.admission?.resolve();
    return state.bypass ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('../../lib/ffmpeg.js', async original => ({
  ...(await original()),
  findFfmpeg: async () => 'synthetic-ffmpeg', findFfprobe: async () => null,
  optimizeForStreaming: async () => {}, upscaleVideo2x: async () => ({ ok: true }),
  hasAudioStream: async () => false, bt709TagFilter: async () => null,
  probeVideoDuration: async () => 1,
  probeVideoStreamInfo: async () => ({ width: 2560, height: 1440, fps: 24, frameCount: 24 }),
  generateThumbnail: async (_path, id) => {
    const { PATHS } = await import('../../lib/fileUtils.js');
    await writeFile(join(PATHS.videoThumbnails, `${id}.jpg`), 'poster');
    return `${id}.jpg`;
  },
}));
vi.mock('../../lib/childProcess.js', async original => ({ ...(await original()), spawn: (_bin, args) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  setImmediate(() => {
    child.emit('spawn');
    writeFileSync(args.at(-1), 'derived-video');
    child.emit('close', 0, null);
  });
  return child;
} }));
vi.mock('../../lib/sseUtils.js', async original => ({ ...(await original()), closeJobAfterDelay: () => {} }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../hfToken.js', () => ({ hfChildEnv: async () => ({}) }));
vi.mock('./renderArgs.js', () => ({ buildArgs: ({ outputPath }) => ({ bin: 'fixture', args: [outputPath] }) }));
vi.mock('../../lib/detachedSpawn.js', () => ({ spawnDetached: async (_bin, args) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 101 });
  setImmediate(() => { writeFileSync(args[0], 'upscaled'); child.emit('close', 0, null); });
  return child;
} }));
vi.mock('./upscaleFfmpeg.js', () => ({
  padSourceForUpscale: vi.fn(),
  finalizeUpscaleOutput: async (_source, path) => { await writeFile(path, 'finalized upscale'); return { ok: true }; },
}));
vi.mock('./local.js', async () => await import('./history.js'));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: async () => ({
  evaluate: async () => ({ durationSec: 1, fps: 12, width: 1280, height: 720, motionBlur: 1, layout: false }),
  check: () => {}, close: async () => {},
}) }));
vi.mock('../htmlComposition/encode.js', () => ({
  encodeComposition: async (_page, _contract, path) => { await writeFile(path, 'composition'); return {}; },
  encodeContactSheet: vi.fn(), proofTimes: vi.fn(), synthesizeCompositionMusic: vi.fn(),
}));
const { PATHS } = await import('../../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { loadHistory, saveHistory } = await import('./history.js');
const { runVideoUpscale } = await import('./upscaleJob.js');
const { stitchVideos } = await import('./stitchVideos.js');
const { upscaleHistoryItem } = await import('./upscaleVideo.js');
const { renderComposition } = await import('../htmlComposition/index.js');
const { renderProject, getRenderJobStatus, attachSseClient } = await import('../videoTimeline/local.js');
const sourceIds = [randomUUID(), randomUUID()];
const settle = () => new Promise(resolve => setImmediate(resolve));
const gates = [];
function gate() { const value = { entered: Promise.withResolvers(), finish: Promise.withResolvers() }; gates.push(value); return value; }
async function copyAssets() {
  const root = join(PATHS.data, `copy-${randomUUID()}`);
  await mkdir(root);
  await cp(PATHS.videos, join(root, 'videos'), { recursive: true });
  await cp(PATHS.videoThumbnails, join(root, 'posters'), { recursive: true });
  return root;
}
async function copyHistory(root) {
  await cp(join(PATHS.data, 'video-history.json'), join(root, 'history.json'));
  return JSON.parse(await readFile(join(root, 'history.json'), 'utf8'));
}
const missing = (root, rows) => rows.flatMap(row => [row.filename && join(root, 'videos', row.filename), row.thumbnail && join(root, 'posters', row.thumbnail)]).filter(path => path && !existsSync(path));
const lanes = {
  stitch: () => stitchVideos(sourceIds),
  upscale: () => upscaleHistoryItem(sourceIds[0]),
  queuedUpscale: async () => {
    const result = await runVideoUpscale({ jobId: randomUUID(), historyId: sourceIds[0], sourceFilename: `${sourceIds[0]}.mp4`, runtime: 'fixture',
      source: { width: 1280, height: 720, fps: 24, frameCount: 24 }, target: { width: 2560, height: 1440, frameCount: 24 },
      alignment: { padWidth: 0, padHeight: 0, padFrames: 0, trimFrames: 0 } });
    if (!result) throw new Error('Queued upscale failed');
    return result;
  },
  composition: () => renderComposition({ directory: 'compositions/fixture', jobId: randomUUID() }),
  timeline: async () => {
    const { jobId } = await renderProject('fixture');
    // These contracts deliberately hold publication/rollback open. Await the
    // public terminal event rather than racing those gates against waitFor's
    // polling deadline (especially while Windows is copying backup assets).
    const terminal = Promise.withResolvers();
    const req = new EventEmitter();
    expect(attachSseClient(jobId, {
      req,
      writeHead: () => {},
      write: frame => {
        const payload = JSON.parse(frame.slice('data: '.length).trim());
        if (['complete', 'error', 'canceled'].includes(payload.type)) terminal.resolve(payload);
      },
    })).toBe(true);
    try {
      const payload = await terminal.promise;
      if (payload.type !== 'complete') throw new Error(payload.error);
      expect(getRenderJobStatus(jobId).status).toBe('complete');
    } finally { req.emit('close'); }
  },
};
beforeEach(async () => {
  Object.assign(state, { bypass: false, admission: null, historyGate: null, failHistory: false, rollback: null });
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  await mkdir(join(PATHS.data, 'compositions/fixture'), { recursive: true });
  await writeFile(join(PATHS.data, 'compositions/fixture/index.html'), '<html></html>');
  for (const id of sourceIds) await writeFile(join(PATHS.videos, `${id}.mp4`), 'source');
  await saveHistory(sourceIds.map(id => ({ id, filename: `${id}.mp4`, prompt: 'Synthetic source', width: 1280, height: 720, fps: 24, numFrames: 24 })));
  await writeFile(join(PATHS.data, 'video-projects.json'), JSON.stringify([{ id: 'fixture', name: 'Synthetic timeline', clips: [{ clipId: sourceIds[0], inSec: 0, outSec: 1 }] }]));
});
afterEach(async () => {
  for (const value of gates.splice(0)) value.finish.resolve();
  await rm(PATHS.videos, { recursive: true, force: true });
  await rm(PATHS.videoThumbnails, { recursive: true, force: true });
});
afterAll(cleanupTempDataRoots);

for (const [name, run] of Object.entries(lanes)) describe(`${name} backup publication`, () => {
  it('holds a completed producer out of a cut; bypass demonstrates dangling copied records', async () => {
    let cut = await acquireBackupSnapshotCut();
    let operation;
    try {
      const copied = await copyAssets();
      state.admission = Promise.withResolvers();
      operation = run();
      await state.admission.promise;
      await settle();
      expect(await copyHistory(copied)).toHaveLength(2);
    } finally { cut(); await operation; }
    // Run a second fresh output with admission bypassed after copying assets.
    state.bypass = true;
    const copied = await copyAssets();
    await run();
    expect(missing(copied, await copyHistory(copied)).length).toBeGreaterThan(0);
  });

  it('drains history commit before copying a complete file/record pair', async () => {
    const blocked = gate(); state.historyGate = blocked;
    const operation = run();
    await blocked.entered.promise;
    let acquired = false;
    const cutting = acquireBackupSnapshotCut().then(cut => { acquired = true; return cut; });
    try {
      await settle(); expect(acquired).toBe(false);
      blocked.finish.resolve(); await operation;
      const cut = await cutting;
      try {
        const copied = await copyAssets();
        const rows = await copyHistory(copied);
        expect(rows).toHaveLength(3);
        expect(missing(copied, rows)).toEqual([]);
      } finally { cut(); }
    } finally { blocked.finish.resolve(); await operation.catch(() => {}); (await cutting)(); }
  });

  it('drains failed-history rollback before a cut sees the discarded output', async () => {
    state.failHistory = true;
    const blocked = gate(); state.rollback = blocked;
    const operation = run().then(() => null, error => error);
    await blocked.entered.promise;
    let acquired = false;
    const cutting = acquireBackupSnapshotCut().then(cut => { acquired = true; return cut; });
    try {
      await settle(); expect(acquired).toBe(false);
      blocked.finish.resolve(); expect(await operation).toBeInstanceOf(Error);
      const cut = await cutting;
      try {
        expect(await loadHistory()).toHaveLength(2);
        expect((await readdir(PATHS.videos)).sort()).toEqual(sourceIds.map(id => `${id}.mp4`).sort());
        expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
      } finally { cut(); }
    } finally { blocked.finish.resolve(); await operation.catch(() => {}); (await cutting)(); }
  });
});
