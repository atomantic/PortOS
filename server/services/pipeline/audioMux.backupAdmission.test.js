/** Real mux installation against synthetic files and the real snapshot cut. */
import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, ownTestBodies } from '../../lib/mockPathsDataRoot.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let encoded;
let installed;
let releaseInstall;
let missingOutput;
let bypassAdmission;
let encodedInsideLease;

vi.mock('../../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => bypassAdmission ? work() : actual.withBackupAssetPublication(work) };
});
vi.mock('../../lib/ffmpeg.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    findFfmpeg: async () => 'synthetic-ffmpeg',
    hasAudioStream: async () => false,
    runFfmpegProcess: async ({ args }) => {
      const { holdsBackupAssetPublication } = await import('../../lib/backupSnapshotBoundary.js');
      encodedInsideLease = holdsBackupAssetPublication();
      if (!missingOutput) await writeFile(args.at(-1), 'muxed');
      encoded.resolve();
      return { ok: true };
    },
    installEncodedVideo: async (...args) => {
      const result = await actual.installEncodedVideo(...args);
      installed.resolve();
      await releaseInstall.promise;
      return result;
    },
  };
});
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { muxMusicBed, muxVoLines, muxCueBed, muxStripAudio } = await import('./audioMux.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const root = () => lazyTempDataRoot('portos-audio-mux-backup-');
const video = () => join(root(), 'videos', 'episode.mp4');
const audio = () => join(root(), 'audio.wav');
const capture = async () => ({ row: { filename: 'episode.mp4' }, bytes: await readFile(video(), 'utf8') });
const before = { row: { filename: 'episode.mp4' }, bytes: 'original' };
const after = { row: { filename: 'episode.mp4' }, bytes: 'muxed' };
const writers = [
  { name: 'music bed', run: () => muxMusicBed(video(), { musicPath: audio() }) },
  { name: 'voice overlay', run: () => muxVoLines(video(), { voLines: [{ path: audio(), offsetSec: 0 }] }) },
  { name: 'generated cues', run: () => muxCueBed(video(), { cues: [{ path: audio(), startSec: 0, endSec: 2 }] }) },
  { name: 'silent strip', run: () => muxStripAudio(video()) },
];
beforeEach(async () => {
  await owned.drain();
  encoded = deferred(); installed = deferred(); releaseInstall = deferred();
  missingOutput = false; bypassAdmission = false; encodedInsideLease = null;
  await rm(root(), { recursive: true, force: true });
  await mkdir(join(root(), 'videos'), { recursive: true });
  await writeFile(video(), 'original');
  await writeFile(audio(), 'synthetic audio');
});
// Fail-fast cancellation leaves the async mux body running after Vitest's
// wrapper settles. Keep its original, temporary output and backup until it exits.
afterAll(async () => {
  try { await owned.drain(); } finally { cleanupTempDataRoots(); }
});

describe.each(writers)('$name backup publication', ({ run }) => {
  it('encodes outside admission but preserves the named video throughout an open cut', async () => {
    const release = await acquireBackupSnapshotCut();
    const work = run();
    try {
      await encoded.promise;
      await settle();
      expect(encodedInsideLease).toBe(false);
      expect(await capture()).toEqual(before);
    } finally { release(); releaseInstall.resolve(); }
    expect((await work).ok).toBe(true);
    expect(await capture()).toEqual(after);
    expect(await readdir(join(root(), 'videos'))).toEqual(['episode.mp4']);
  });

  it('drains the installation before granting a cut, including failed-install cleanup', async () => {
    missingOutput = true;
    const work = run();
    await installed.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try {
      await settle();
      expect(cutReady).toBe(false);
    } finally { releaseInstall.resolve(); }
    expect((await work).ok).toBe(false);
    const release = await cut;
    try {
      expect(await capture()).toEqual(before);
      expect(await readdir(join(root(), 'videos'))).toEqual(['episode.mp4']);
    } finally { release(); }
  });
});

it('the unadmitted negative control replaces the named file during the same cut', async () => {
  bypassAdmission = true;
  const release = await acquireBackupSnapshotCut();
  const work = muxStripAudio(video());
  try {
    await installed.promise;
    expect(await capture()).toEqual(after);
  } finally { release(); releaseInstall.resolve(); }
  await work;
});
