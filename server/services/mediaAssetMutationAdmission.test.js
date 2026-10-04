/** Real gallery/history workflows and files, with the derived PG index held at
 * its commit seam. A cut must never enter after bytes change but before rows do. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-asset-mutation-'),
}));

const rows = new Map();
let beforeIndexWrite = async () => {};
vi.mock('./mediaAssetIndex/index.js', () => ({
  indexImage: async ({ filename }) => {
    await beforeIndexWrite();
    const metadata = await readFile(join(PATHS.images, filename.replace('.png', '.metadata.json')), 'utf8')
      .then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
    rows.set(filename, { filename, ...metadata });
  },
  unindexImage: async filename => { await beforeIndexWrite(); rows.delete(filename); },
  unindexVideo: async id => { await beforeIndexWrite(); rows.delete(id); },
}));

const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { deleteImage, saveUploadedGalleryImage, setImageHidden, updateImagePrompt } = await import('./imageGen/local.js');
const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
const { loadHistory, saveHistory } = await import('./videoGen/history.js');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
const imagePath = join(PATHS.images, 'fixture.png');
const metadataPath = join(PATHS.images, 'fixture.metadata.json');
const videoPath = join(PATHS.videos, 'fixture.mp4');
const readMetadata = () => readFile(metadataPath, 'utf8').then(JSON.parse);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

afterAll(cleanupTempDataRoots);
beforeEach(async () => {
  rows.clear();
  beforeIndexWrite = async () => {};
  await rm(PATHS.data, { recursive: true, force: true });
  await Promise.all([PATHS.images, PATHS.videos, PATHS.imageThumbnails, PATHS.videoThumbnails]
    .map(directory => mkdir(directory, { recursive: true })));
  await writeFile(imagePath, png);
  await writeFile(metadataPath, JSON.stringify({ prompt: 'before', hidden: false }));
  await writeFile(videoPath, 'synthetic video');
  await saveHistory([{ id: 'fixture-video', filename: 'fixture.mp4' }]);
  rows.set('fixture.png', { filename: 'fixture.png', prompt: 'before', hidden: false });
  rows.set('fixture-video', { filename: 'fixture.mp4' });
});

// Each case changes a different durable workflow. Holding its actual row write
// catches a missing lease OR a lease released after only its filesystem half.
it.each([
  {
    name: 'image prompt replacement',
    mutate: () => updateImagePrompt('fixture.png', 'after'),
    changedFiles: async () => expect(await readMetadata()).toMatchObject({ prompt: 'after' }),
    captured: async () => expect(rows.get('fixture.png').prompt).toBe((await readMetadata()).prompt),
  },
  {
    name: 'image visibility replacement',
    mutate: () => setImageHidden('fixture.png', true),
    changedFiles: async () => expect(await readMetadata()).toMatchObject({ hidden: true }),
    captured: async () => expect(rows.get('fixture.png').hidden).toBe((await readMetadata()).hidden),
  },
  {
    name: 'image deletion',
    mutate: () => deleteImage('fixture.png'),
    changedFiles: async () => expect(readFile(imagePath)).rejects.toMatchObject({ code: 'ENOENT' }),
    captured: async () => expect(rows.has('fixture.png')).toBe(false),
  },
  {
    name: 'video deletion',
    mutate: () => deleteHistoryItem('fixture-video'),
    changedFiles: async () => {
      await expect(readFile(videoPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await loadHistory()).toEqual([]);
    },
    captured: async () => expect(rows.has('fixture-video')).toBe(false),
  },
  {
    name: 'gallery upload',
    mutate: () => saveUploadedGalleryImage(png.toString('base64')),
    changedFiles: async () => expect((await readdir(PATHS.images)).filter(name => /^upload-.*\.png$/.test(name))).toHaveLength(1),
    captured: async () => {
      const uploaded = [...rows.keys()].find(name => name.startsWith('upload-'));
      expect(uploaded).toBeTruthy();
      expect(await readFile(join(PATHS.images, uploaded))).toEqual(png);
    },
  },
])('drains the complete $name before admitting a snapshot', async ({ mutate, changedFiles, captured }) => {
  const rowReached = deferred();
  const commitRow = deferred();
  beforeIndexWrite = async () => { rowReached.resolve(); await commitRow.promise; };
  const mutation = mutate();
  await rowReached.promise;
  let acquired = false;
  const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
  try {
    await changedFiles();
    // The cut would already resolve if only the filesystem write held a lease.
    expect(acquired).toBe(false);
  } finally {
    commitRow.resolve();
    await mutation;
    (await cut)();
  }
  await captured();
});

it('keeps prompt replacement and deletion behind an active cut, preserving the captured image', async () => {
  const release = await acquireBackupSnapshotCut();
  const replacement = updateImagePrompt('fixture.png', 'after');
  const deletion = deleteHistoryItem('fixture-video');
  try {
    // This is the file-copy / dump order used by backup. Both reads are real;
    // the mutation may run only after the pair has been captured.
    expect(await readMetadata()).toMatchObject({ prompt: 'before' });
    expect(await readFile(videoPath, 'utf8')).toBe('synthetic video');
    expect(rows.get('fixture.png').prompt).toBe('before');
    expect(rows.get('fixture-video')).toEqual({ filename: 'fixture.mp4' });
  } finally {
    release();
    await Promise.all([replacement, deletion]);
  }
  expect(await readMetadata()).toMatchObject({ prompt: 'after' });
  expect(rows.has('fixture-video')).toBe(false);
});

it('does not keep snapshot admission closed after a history mutation rejects', async () => {
  await expect(deleteHistoryItem('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const release = await acquireBackupSnapshotCut();
  release();
  expect(await readFile(videoPath, 'utf8')).toBe('synthetic video');
  expect(await loadHistory()).toEqual([{ id: 'fixture-video', filename: 'fixture.mp4' }]);
});

it('drains a queued sidecar edit through its index commit before taking the cut', async () => {
  const firstReached = deferred();
  const commitFirst = deferred();
  const secondReached = deferred();
  const commitSecond = deferred();
  let writes = 0;
  beforeIndexWrite = async () => {
    writes += 1;
    const reached = writes === 1 ? firstReached : secondReached;
    const commit = writes === 1 ? commitFirst : commitSecond;
    reached.resolve();
    await commit.promise;
  };

  const prompt = updateImagePrompt('fixture.png', 'after');
  await firstReached.promise;
  const visibility = setImageHidden('fixture.png', true);
  const cut = acquireBackupSnapshotCut();
  try {
    expect(await readMetadata()).toEqual({ prompt: 'after', hidden: false });
    commitFirst.resolve();
    // If admission is acquired only INSIDE the queue's turn, the cut can
    // overtake the second edit and leave it waiting behind the snapshot.
    const next = await Promise.race([
      secondReached.promise.then(() => 'queued edit'),
      cut.then(() => 'snapshot'),
    ]);
    expect(next).toBe('queued edit');
    expect(await readMetadata()).toEqual({ prompt: 'after', hidden: true });
    // The first commit finished, but the second row is still deliberately held.
    expect(rows.get('fixture.png')).toMatchObject({ prompt: 'after', hidden: false });
  } finally {
    // Always release both commits and any acquired cut, including when a
    // negative-control implementation let the snapshot overtake the queue.
    commitFirst.resolve();
    commitSecond.resolve();
    (await cut)();
    await Promise.all([prompt, visibility]);
  }
  expect(rows.get('fixture.png')).toMatchObject({ prompt: 'after', hidden: true });
  expect(await readMetadata()).toEqual({ prompt: 'after', hidden: true });
});
