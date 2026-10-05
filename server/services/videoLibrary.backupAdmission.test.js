/**
 * Library publications against a file-copy cut (#9982). Producers are
 * synthetic, but bytes, the serialized history store and the boundary are real.
 * Each held-cut case also bypasses admission as a negative control: its
 * copied history then names an output missing from the already-copied assets.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies,
} from '../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({
  admission: null, bypass: false, historyGate: null, unlinkGate: null,
  failHistory: false, thumbnailFailure: null, copyFailure: false,
  producerExit: null, producerGate: null,
}));

vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-video-library-admission-'),
    overrides: {
      atomicWrite: async (path, value) => {
        if (basename(path) === 'video-history.json') {
          const gate = state.historyGate;
          gate?.entered.resolve();
          if (gate) await gate.finish.promise;
          if (state.failHistory) throw new Error('history commit failed');
        }
        return actual.atomicWrite(path, value);
      },
      copyFileGuarded: async (source, dest) => {
        await actual.copyFileGuarded(source, dest);
        if (state.copyFailure) throw new Error('copy failed after staging');
      },
      unlinkGuarded: async path => {
        const gate = state.unlinkGate;
        if (gate?.matches(path)) {
          gate.entered.resolve();
          await gate.finish.promise;
        }
        return actual.unlinkGuarded(path);
      },
    },
  });
});
vi.mock('../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...(await importOriginal()), assertDatabaseAdmission: () => {},
}));
vi.mock('../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => {
    state.admission?.resolve();
    return state.bypass ? work() : actual.withBackupAssetPublication(work);
  } };
});
vi.mock('../lib/ffmpeg.js', async importOriginal => ({
  ...(await importOriginal()),
  generateThumbnail: vi.fn(async (_path, id) => {
    const { PATHS } = await import('../lib/fileUtils.js');
    await mkdir(PATHS.videoThumbnails, { recursive: true });
    await writeFile(join(PATHS.videoThumbnails, `${id}.jpg`), `poster:${id}`);
    if (state.thumbnailFailure === 'throw') throw new Error('poster render failed');
    return state.thumbnailFailure === 'null' ? null : `${id}.jpg`;
  }),
  probeVideoDuration: vi.fn(async () => 2),
  probeVideoStreamInfo: vi.fn(async () => ({ fps: 10 })),
}));
vi.mock('./videoGen/local.js', () => ({ deleteHistoryItem: vi.fn() }));
// Exercise the real download core's discovery and fragment cleanup without a
// subprocess, network, provider or credentials.
vi.mock('./ytdlpRun.js', () => ({
  ytdlpMarkerArgs: () => [], describeYtDlpFailure: () => 'download failed',
  runYtDlp: vi.fn(async ({ args }) => {
    const path = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
    await writeFile(path, 'download bytes');
    const exit = state.producerExit || { code: 0, title: 'Fixture clip' };
    if (exit.canceled || exit.code !== 0) await writeFile(`${path}.part`, 'partial bytes');
    state.producerGate?.entered.resolve();
    if (state.producerGate) await state.producerGate.finish.promise;
    return exit;
  }),
}));

const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { saveUploadedGalleryVideoBuffer, saveUploadedGalleryVideoFile } = await import('./videoUpload.js');
const { downloadVideoIntoLibrary } = await import('./videoDownload.js');
const { updateVideoPoster } = await import('./videoGen/poster.js');
const { loadHistory, mutateVideoHistory, saveHistory } = await import('./videoGen/history.js');
const { videoGenEvents } = await import('./videoGen/events.js');
const { generateThumbnail } = await import('../lib/ffmpeg.js');
const owned = ownTestBodies(vitestIt);
const it = owned.it;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const pause = () => ({ entered: deferred(), finish: deferred() });
const checkpoint = () => new Promise(resolve => setImmediate(resolve));
const uploadBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture')]);
const download = () => downloadVideoIntoLibrary({ url: 'https://example.com/fixture', ytDlp: 'unused', ffmpeg: 'unused', id: 'fixture-download' });

beforeEach(async () => {
  await owned.drain();
  Object.assign(state, {
    admission: null, bypass: false, historyGate: null, unlinkGate: null,
    failHistory: false, thumbnailFailure: null, copyFailure: false,
    producerExit: null, producerGate: null,
  });
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  await saveHistory([]);
  vi.mocked(generateThumbnail).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  state.historyGate?.finish.resolve();
  state.unlinkGate?.finish.resolve();
  state.producerGate?.finish.resolve();
  await owned.drain();
  videoGenEvents.removeAllListeners('completed');
});
afterAll(async () => {
  try { await owned.drain(); } finally { cleanupTempDataRoots(); }
});

async function prepare(kind) {
  if (kind === 'file upload') {
    const path = join(PATHS.data, 'input.mp4');
    await writeFile(path, uploadBytes);
    return () => saveUploadedGalleryVideoFile(path, 'fixture.mp4');
  }
  if (kind === 'poster') {
    await writeFile(join(PATHS.videos, 'existing.mp4'), 'existing video');
    await writeFile(join(PATHS.videoThumbnails, 'old.jpg'), 'old poster');
    await saveHistory([{ id: 'existing', filename: 'existing.mp4', thumbnail: 'old.jpg', posterSec: 0.5 }]);
    return () => updateVideoPoster('existing', 1);
  }
  return kind === 'download' ? download : () => saveUploadedGalleryVideoBuffer(uploadBytes, 'fixture.mp4');
}

async function copyAssets() {
  const root = join(PATHS.data, 'copied');
  await cp(PATHS.videos, join(root, 'videos'), { recursive: true });
  await cp(PATHS.videoThumbnails, join(root, 'posters'), { recursive: true });
  return root;
}
// History is itself file-backed snapshot data, not a simulated Postgres dump.
// Separate these copy points so publication can land between assets and history.
async function copyHistory(root) {
  await cp(join(PATHS.data, 'video-history.json'), join(root, 'history.json'));
  return JSON.parse(await readFile(join(root, 'history.json'), 'utf8'));
}
async function copyFiles() {
  const root = await copyAssets();
  await copyHistory(root);
  return root;
}
function missingReferences(rows, root) {
  return rows.flatMap(row => [
    !existsSync(join(root, 'videos', row.filename)) ? row.filename : null,
    row.thumbnail && !existsSync(join(root, 'posters', row.thumbnail)) ? row.thumbnail : null,
  ].filter(Boolean));
}

describe('video library backup publication', () => {
  for (const kind of ['buffer upload', 'file upload', 'download', 'poster']) {
    it(`${kind} waits out an asset/history copy; bypassing its lease leaves copied history naming a missing asset`, async () => {
      const run = await prepare(kind);
      const release = await acquireBackupSnapshotCut();
      const copied = await copyAssets();
      state.admission = deferred();
      let pending;
      try {
        pending = run();
        await state.admission.promise;
        await checkpoint();
        const snapshotHistory = await copyHistory(copied);
        expect(snapshotHistory).toEqual(await loadHistory());
        expect(missingReferences(snapshotHistory, copied)).toEqual([]);
        expect(generateThumbnail).not.toHaveBeenCalled();
      } finally { release(); }
      await pending;
      expect(await loadHistory()).toHaveLength(1);
      // The negative control publishes between the asset and history copies.
      await rm(join(PATHS.data, 'copied'), { recursive: true, force: true });
      for (const dir of [PATHS.videos, PATHS.videoThumbnails]) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
      }
      await saveHistory([]);
      const controlRun = await prepare(kind);
      const releaseControl = await acquireBackupSnapshotCut();
      const controlCopy = await copyAssets();
      state.bypass = true;
      try {
        await controlRun();
        const controlHistory = await copyHistory(controlCopy);
        expect(missingReferences(controlHistory, controlCopy).length).toBeGreaterThan(0);
      } finally {
        state.bypass = false;
        releaseControl();
      }
    });

    it(`${kind} drains through the real serialized history commit before files and rows are captured`, async () => {
      const run = await prepare(kind);
      const gate = state.historyGate = pause();
      const pending = run();
      await gate.entered.promise;
      let cutReady = false;
      const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
      let release;
      try {
        await checkpoint();
        expect(cutReady).toBe(false);
        gate.finish.resolve();
        await pending;
        release = await cut;
        const copied = await copyFiles();
        const snapshotHistory = JSON.parse(await readFile(join(copied, 'history.json'), 'utf8'));
        expect(missingReferences(snapshotHistory, copied)).toEqual([]);
        expect(snapshotHistory).toEqual(await loadHistory());
        for (const row of snapshotHistory) {
          expect(await readFile(join(copied, 'videos', row.filename))).toEqual(await readFile(join(PATHS.videos, row.filename)));
          expect(await readFile(join(copied, 'posters', row.thumbnail))).toEqual(await readFile(join(PATHS.videoThumbnails, row.thumbnail)));
        }
        if (kind === 'poster') expect(existsSync(join(copied, 'posters', 'old.jpg'))).toBe(false);
      } finally {
        gate.finish.resolve();
        await pending.catch(() => {});
        (release || await cut)();
      }
    });

    it(`${kind} keeps failed-commit rollback inside admission and preserves prior history`, async () => {
      const run = await prepare(kind);
      const before = await loadHistory();
      state.failHistory = true;
      const gate = state.unlinkGate = { ...pause(), matches: path => kind === 'poster'
        ? basename(path).startsWith('existing-poster-') : path.startsWith(PATHS.videos) && !path.endsWith('.tmp') };
      // Download rollback uses the real core's direct unlink, so gate its poster
      // cleanup, which runs after the produced fragments have been removed.
      if (kind === 'download') gate.matches = path => path === join(PATHS.videoThumbnails, 'fixture-download.jpg');
      const pending = run().then(() => null, error => error);
      await gate.entered.promise;
      let cutReady = false;
      const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
      let release;
      try {
        await checkpoint();
        expect(cutReady).toBe(false);
        gate.finish.resolve();
        expect(await pending).toMatchObject({ message: 'history commit failed' });
        release = await cut;
        expect(await loadHistory()).toEqual(before);
        expect(await readdir(PATHS.videos)).toEqual(kind === 'poster' ? ['existing.mp4'] : []);
        expect(await readdir(PATHS.videoThumbnails)).toEqual(kind === 'poster' ? ['old.jpg'] : []);
        expect(missingReferences(await loadHistory(), await copyFiles())).toEqual([]);
      } finally {
        gate.finish.resolve();
        await pending;
        (release || await cut)();
      }
    });
  }

  it('takes poster admission before waiting for the shared history tail', async () => {
    const run = await prepare('poster');
    const gate = pause();
    const blocker = mutateVideoHistory(async history => { gate.entered.resolve(); await gate.finish.promise; return history; });
    await gate.entered.promise;
    state.admission = deferred();
    const pending = run();
    await state.admission.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try { await checkpoint(); expect(cutReady).toBe(false); }
    finally {
      gate.finish.resolve();
      await blocker;
      await pending;
      (await cut)();
    }
  });

  for (const kind of ['buffer upload', 'download']) {
    it(`${kind} retains the committed pair if completion notification dispatch throws`, async () => {
      const run = await prepare(kind);
      // Ordinary listener errors are fault-isolated by the real emitter. Inject
      // a dispatch failure itself to prove the publication catch cannot undo
      // a pair after the authoritative history commit has already succeeded.
      vi.spyOn(videoGenEvents, 'emit').mockImplementationOnce(() => { throw new Error('notification failed'); });
      await expect(run()).rejects.toThrow('notification failed');
      const release = await acquireBackupSnapshotCut();
      try {
        expect(await loadHistory()).toHaveLength(1);
        expect(missingReferences(await loadHistory(), await copyFiles())).toEqual([]);
      } finally { release(); }
    });
  }

  for (const exit of [{ canceled: true, code: null }, { code: 1, reason: 'fixture failure' }]) {
    it(`cleans ${exit.canceled ? 'canceled' : 'failed'} download fragments outside admission without publishing history`, async () => {
      state.producerExit = exit;
      state.producerGate = pause();
      const release = await acquireBackupSnapshotCut();
      try {
        const pending = download();
        await state.producerGate.entered.promise;
        expect(await readdir(PATHS.videos)).toHaveLength(2);
        state.producerGate.finish.resolve();
        expect(await pending).toMatchObject({ outcome: exit.canceled ? 'canceled' : 'failed' });
        expect(await readdir(PATHS.videos)).toEqual([]);
        expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
        expect(await loadHistory()).toEqual([]);
      } finally { state.producerGate.finish.resolve(); release(); }
    });
  }

  it('removes a failed streamed upload staging file and leaves its source intact', async () => {
    const run = await prepare('file upload');
    state.copyFailure = true;
    await expect(run()).rejects.toThrow('copy failed after staging');
    expect(await readdir(PATHS.videos)).toEqual([]);
    expect(await readFile(join(PATHS.data, 'input.mp4'))).toEqual(uploadBytes);
    expect(await loadHistory()).toEqual([]);
  });

  for (const failure of ['throw', 'null']) {
    it(`keeps thumbnail-less upload compatibility (${failure}) and removes a partial poster`, async () => {
      state.thumbnailFailure = failure;
      const entry = await saveUploadedGalleryVideoBuffer(uploadBytes);
      expect(entry.thumbnail).toBeNull();
      expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
      expect(await readFile(join(PATHS.videos, entry.filename))).toEqual(uploadBytes);
    });

    it(`removes a partially rendered poster (${failure}) and preserves the selected old poster`, async () => {
      const run = await prepare('poster');
      state.thumbnailFailure = failure;
      await expect(run()).rejects.toThrow(/poster render failed|Could not generate poster/);
      expect(await readdir(PATHS.videoThumbnails)).toEqual(['old.jpg']);
      expect((await loadHistory())[0]).toMatchObject({ thumbnail: 'old.jpg', posterSec: 0.5 });
    });
  }

  it('removes the downloaded video and partial poster when poster rendering throws', async () => {
    state.thumbnailFailure = 'throw';
    await expect(download()).rejects.toThrow('poster render failed');
    expect(await readdir(PATHS.videos)).toEqual([]);
    expect(await readdir(PATHS.videoThumbnails)).toEqual([]);
    expect(await loadHistory()).toEqual([]);
  });

  it('resets a poster using a fresh name and removes its old timestamp and bytes', async () => {
    await prepare('poster');
    const result = await updateVideoPoster('existing', null);
    expect(result.posterSec).toBeNull();
    expect(result.thumbnail).not.toBe('old.jpg');
    expect((await loadHistory())[0]).not.toHaveProperty('posterSec');
    expect(await readdir(PATHS.videoThumbnails)).toEqual([result.thumbnail]);
  });
});
