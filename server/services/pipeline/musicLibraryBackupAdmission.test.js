/** Music library import and deletion over real files. A backup cut must never
 * copy the library while an upload is half written, and must never let an
 * unlink remove a file the captured rows still name (#9982). */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// Every upload copy awaits `beforeCopy`, so a test can hold it mid-publication.
let beforeCopy = async () => {};
vi.mock('../../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  const paths = makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-music-library-') });
  return new Proxy(paths, {
    get: (target, prop) => (prop === 'copyFileGuarded'
      ? async (...args) => { await beforeCopy(); return actual.copyFileGuarded(...args); }
      : target[prop]),
  });
});

const { PATHS } = await import('../../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { deleteMusicTrack, importUploadedTrack } = await import('./musicLibrary.js');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleSeveral = async () => { for (let i = 0; i < 5; i += 1) await settle(); };
const libraryFiles = () => readdir(PATHS.music).catch(() => []);
let scratch;
const makeUpload = async () => {
  const path = join(scratch, `upload-${Math.random().toString(36).slice(2)}.mp3`);
  await writeFile(path, 'synthetic audio');
  return path;
};

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  cleanupTempDataRoots();
});
beforeEach(async () => {
  beforeCopy = async () => {};
  scratch ||= await mkdtemp(join(tmpdir(), 'portos-music-upload-'));
  await rm(PATHS.music, { recursive: true, force: true });
  await mkdir(PATHS.music, { recursive: true });
});

describe('music library backup admission', () => {
  it('drains an upload already copying so the cut never reads a half-written library', async () => {
    const reached = deferred();
    const proceed = deferred();
    beforeCopy = async () => { reached.resolve(); await proceed.promise; };
    const upload = importUploadedTrack(await makeUpload(), 'song.mp3');
    await reached.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settleSeveral();
    expect(cutReady).toBe(false);
    proceed.resolve();
    const { filename } = await upload;
    const release = await cut;
    expect(await libraryFiles()).toEqual([filename]);
    release();
  });

  it('holds an upload arriving during a cut until the snapshot is done', async () => {
    const release = await acquireBackupSnapshotCut();
    const upload = importUploadedTrack(await makeUpload(), 'song.mp3');
    await settleSeveral();
    expect(await libraryFiles()).toEqual([]);
    release();
    const { filename } = await upload;
    expect(await libraryFiles()).toEqual([filename]);
  });

  it('keeps a deleted track on disk until the cut that captured its rows finishes', async () => {
    await writeFile(join(PATHS.music, 'named-by-a-row.mp3'), 'synthetic audio');
    const release = await acquireBackupSnapshotCut();
    const deletion = deleteMusicTrack('named-by-a-row.mp3');
    await settleSeveral();
    expect(await libraryFiles()).toEqual(['named-by-a-row.mp3']);
    release();
    expect(await deletion).toBe(true);
    expect(await libraryFiles()).toEqual([]);
  });

  it('rejects an unsafe filename without taking admission', async () => {
    await expect(deleteMusicTrack('../outside.mp3')).rejects.toThrow();
    const release = await acquireBackupSnapshotCut({ timeoutMs: 50 });
    release();
  });
});
