/**
 * Gallery video upload (#4188) — pins the container sniff, the load-bearing
 * history-entry shape (the fields normalizeVideo / mediaAssetIndex videoToRow /
 * deleteHistoryItem depend on), and the pre-write validation errors. The happy
 * path's fs/ffmpeg tail mirrors downloadVideoIntoLibrary and is exercised by
 * the route surface, not re-run here against real dirs.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from 'vitest';
import {
  detectVideoContainer,
  buildUploadHistoryEntry,
  saveUploadedGalleryVideo,
  saveUploadedGalleryVideoBuffer,
  saveUploadedGalleryVideoFile,
} from './videoUpload.js';

// Diagnostics retain only fixed stage names, state and elapsed time, never paths,
// payloads or raw errors. The most recent 64 boundaries cover both large imports.
const uploadState = vi.hoisted(() => ({ root: '', history: [], fail: false, stages: [] }));
const traceStage = vi.hoisted(() => async (stage, work) => {
  const record = { stage, state: 'pending', started: performance.now() };
  uploadState.stages.push(record);
  if (uploadState.stages.length > 64) uploadState.stages.shift();
  try {
    const result = await work();
    record.state = 'fulfilled';
    return result;
  } catch (error) {
    record.state = 'rejected';
    throw error;
  } finally {
    record.elapsed = Math.round(performance.now() - record.started);
  }
});
vi.mock('fs/promises', async (original) => {
  const actual = await original();
  return {
    ...actual,
    open: (...args) => traceStage('file-open', async () => {
      const file = await actual.open(...args);
      const read = file.read.bind(file);
      const close = file.close.bind(file);
      file.read = (...readArgs) => traceStage('file-read', () => read(...readArgs));
      file.close = () => traceStage('file-close', close);
      return file;
    }),
    stat: (...args) => traceStage('file-stat', () => actual.stat(...args)),
    rename: (...args) => traceStage('file-rename', () => actual.rename(...args)),
  };
});
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    PATHS: { ...actual.PATHS,
      get videos() { return uploadState.root; },
      get videoThumbnails() { return join(uploadState.root, 'thumbnails'); },
    },
    ...Object.fromEntries(['ensureDir', 'atomicWrite', 'copyFileGuarded', 'unlinkGuarded'].map(name =>
      [name, (...args) => traceStage(name, () => actual[name](...args))])),
  };
});
vi.mock('../lib/backupSnapshotBoundary.js', async (original) => {
  const actual = await original();
  return { ...actual, withBackupAssetPublication: (work, options) =>
    traceStage('publication-admission-and-release', () => actual.withBackupAssetPublication(
      () => traceStage('admitted-work', work), options)) };
});
vi.mock('../lib/ffmpeg.js', () => ({
  generateThumbnail: vi.fn(() => traceStage('thumbnail', async () => null)),
  probeVideoDuration: vi.fn(() => traceStage('duration', async () => 2)),
  probeMediaTags: vi.fn(() => traceStage('tags', async () => ({}))),
}));
vi.mock('./videoGen/history.js', () => ({ mutateVideoHistory: vi.fn((mutate) => traceStage('history', async () => {
  if (uploadState.fail) throw new Error('history write failed');
  uploadState.history = mutate(uploadState.history);
})) }));

// Vitest's deadline stops awaiting a test; it does not cancel its async body.
// Own the whole body, including later imports/rollback, until terminal settlement.
function ownFixtureOperations() {
  const pending = new Set();
  let closing = false;
  return {
    run(work) {
      if (closing) throw new Error('Fixture is closing');
      const operation = Promise.resolve().then(work);
      pending.add(operation);
      // Own rejection on the observer too; callers still receive the original error.
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    settle() { return Promise.allSettled([...pending]); },
    async cleanup(remove) {
      closing = true;
      await Promise.allSettled([...pending]);
      remove();
    },
  };
}
const fixture = ownFixtureOperations();
uploadState.root = mkdtempSync(join(tmpdir(), 'gallery-video-test-'));
function reportStages() {
  const summary = uploadState.stages.map(({ stage, state, started, elapsed }) =>
    `${stage}:${state}:${elapsed ?? Math.round(performance.now() - started)}ms`).join(', ');
  console.error(`❌ Video upload fixture stages: ${summary}`);
}
beforeEach(({ onTestFailed }) => {
  onTestFailed(reportStages);
});
// A timed-out body must also settle before the next test changes shared mocks.
afterEach(() => fixture.settle());
afterAll(async () => {
  await fixture.cleanup(() => rmSync(uploadState.root, { recursive: true, force: true }));
});

const ftyp = (brand) => Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftyp', 'latin1'),
  Buffer.from(brand, 'latin1'),
  Buffer.alloc(8),
]);

describe('detectVideoContainer', () => {
  it('detects ISO-BMFF (ftyp) as mp4', () => {
    expect(detectVideoContainer(ftyp('isom'))).toBe('mp4');
    expect(detectVideoContainer(ftyp('mp42'))).toBe('mp4');
  });
  it('detects the QuickTime brand as mov', () => {
    expect(detectVideoContainer(ftyp('qt  '))).toBe('mov');
  });
  it('detects EBML magic as webm', () => {
    expect(detectVideoContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('webm');
  });
  it('rejects non-video bytes', () => {
    expect(detectVideoContainer(Buffer.from('hello world, definitely not a video'))).toBeNull();
    expect(detectVideoContainer(Buffer.alloc(2))).toBeNull();
  });
});

describe('buildUploadHistoryEntry', () => {
  it('pins the shape the gallery/index/delete paths depend on', () => {
    const entry = buildUploadHistoryEntry({
      id: 'upload-ab12cd34', filename: 'upload-ab12cd34.mp4', thumbnail: 'upload-ab12cd34.jpg', durationSec: 3.2, title: 'clip.mp4',
    });
    expect(entry.id).toBe('upload-ab12cd34');
    expect(entry.filename).toBe('upload-ab12cd34.mp4');
    expect(entry.thumbnail).toBe('upload-ab12cd34.jpg');
    expect(entry.source).toBe('upload');
    expect(entry.title).toBe('clip.mp4');
    expect(entry.durationSec).toBe(3.2);
    expect(typeof entry.createdAt).toBe('string');
  });
  it('omits durationSec when unknown and defaults the title', () => {
    const entry = buildUploadHistoryEntry({ id: 'u', filename: 'u.mp4', thumbnail: null, durationSec: null, title: '' });
    expect('durationSec' in entry).toBe(false);
    expect(entry.title).toBe('Uploaded video');
  });
});

describe('saveUploadedGalleryVideo validation', () => {
  it('requires a byte buffer for internal browser downloads', async () => {
    await expect(saveUploadedGalleryVideoBuffer('not-a-buffer')).rejects.toThrow(/invalid/i);
  });
  it('rejects an empty upload before touching disk', async () => {
    await expect(saveUploadedGalleryVideo('')).rejects.toThrow(/empty/i);
  });
  it('rejects a non-video payload', async () => {
    const notVideo = Buffer.from('hello world, definitely not a video').toString('base64');
    await expect(saveUploadedGalleryVideo(notVideo)).rejects.toThrow(/unsupported video format/i);
  });
});


it('imports a large staged video without the JSON ceiling and removes failed imports', () => fixture.run(async () => {
  const tempPath = join(uploadState.root, 'source.mp4');
  const bytes = Buffer.concat([ftyp('isom'), Buffer.alloc(56 * 1024 * 1024)]);
  writeFileSync(tempPath, bytes);
  const entry = await saveUploadedGalleryVideoFile(tempPath, 'large.mp4');
  expect(entry).toMatchObject({ title: 'large.mp4', source: 'upload', durationSec: 2 });
  expect(uploadState.history[0]).toEqual(entry);
  expect(readFileSync(join(uploadState.root, entry.filename)).equals(bytes)).toBe(true);
  uploadState.fail = true;
  const before = readdirSync(uploadState.root).sort();
  await expect(saveUploadedGalleryVideoFile(tempPath, 'failed.mp4')).rejects.toThrow('history write failed');
  expect(readdirSync(uploadState.root).sort()).toEqual(before);
  expect(existsSync(tempPath)).toBe(true);
}));

it('projects embedded video tags with the PNG import parser and preserves original bytes', () => fixture.run(async () => {
  uploadState.fail = false;
  const { probeMediaTags } = await import('../lib/ffmpeg.js');
  const parameters = 'Paper boat\nNegative prompt: text\nSteps: 20, Seed: 42, Size: 512x512, CFG scale: 7, Model: example-model';
  probeMediaTags.mockResolvedValueOnce({ comment: parameters, title: 'must not become a prompt' });
  const bytes = ftyp('isom');
  const entry = await saveUploadedGalleryVideoBuffer(bytes, '../../universe-character.mp4');
  expect(entry).toMatchObject({ prompt: 'Paper boat', negativePrompt: 'text', seed: 42, source: 'upload', modelId: 'example-model', guidanceScale: 7 });
  expect(entry.universeId).toBeUndefined();
  expect(uploadState.history[0]).toEqual(entry);
  expect(readFileSync(join(uploadState.root, entry.filename))).toEqual(bytes);
  probeMediaTags.mockResolvedValueOnce({ metadata: '{invalid JSON', title: 'Do not infer this' });
  expect(await saveUploadedGalleryVideoBuffer(bytes)).not.toHaveProperty('prompt');
  probeMediaTags.mockResolvedValueOnce(null);
  expect(await saveUploadedGalleryVideoBuffer(bytes)).toMatchObject({ importWarnings: [expect.stringContaining('could not be inspected')] });
}));

// A caller has already failed, but history is still pending: teardown must keep
// the source alive through the import's rejection AND its real file rollback.
it('settles an abandoned import before removing its fixture', () => fixture.run(async () => {
  const { mutateVideoHistory } = await import('./videoGen/history.js');
  const owner = ownFixtureOperations();
  const source = join(uploadState.root, 'delayed.mp4');
  writeFileSync(source, ftyp('isom'));
  const before = readdirSync(uploadState.root).sort();
  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  mutateVideoHistory.mockImplementationOnce(() => traceStage('held-history', () => {
    entered.resolve();
    return held.promise;
  }));
  const operation = owner.run(() => saveUploadedGalleryVideoFile(source, 'delayed.mp4'));
  const rejection = expect(operation).rejects.toThrow('held history failed');
  await entered.promise;
  const callerFailure = new Error('caller deadline');
  await expect(Promise.race([operation, Promise.reject(callerFailure)])).rejects.toBe(callerFailure);
  const remove = vi.fn(() => rmSync(source));
  const cleanup = owner.cleanup(remove);
  try {
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(uploadState.root).length).toBe(before.length + 1);
    expect(() => owner.run(() => {})).toThrow('Fixture is closing');
  } finally {
    held.reject(new Error('held history failed'));
    try { await rejection; } finally { await cleanup; }
  }
  expect(remove).toHaveBeenCalledOnce();
  expect(readdirSync(uploadState.root).sort()).toEqual(before.filter(name => name !== 'delayed.mp4'));
}));
