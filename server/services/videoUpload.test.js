/**
 * Gallery video upload (#4188) — pins the container sniff, the load-bearing
 * history-entry shape (the fields normalizeVideo / mediaAssetIndex videoToRow /
 * deleteHistoryItem depend on), and the pre-write validation errors. The happy
 * path's fs/ffmpeg tail mirrors downloadVideoIntoLibrary and is exercised by
 * the route surface, not re-run here against real dirs.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  detectVideoContainer,
  buildUploadHistoryEntry,
  saveUploadedGalleryVideo,
  saveUploadedGalleryVideoBuffer,
  saveUploadedGalleryVideoFile,
} from './videoUpload.js';

const uploadState = vi.hoisted(() => ({ root: '', history: [], fail: false }));
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, get videos() { return uploadState.root; } } };
});
vi.mock('../lib/ffmpeg.js', () => ({ generateThumbnail: vi.fn(async () => null), probeVideoDuration: vi.fn(async () => 2) }));
vi.mock('./videoGen/history.js', () => ({ mutateVideoHistory: vi.fn(async (mutate) => {
  if (uploadState.fail) throw new Error('history write failed');
  uploadState.history = mutate(uploadState.history);
}) }));
uploadState.root = mkdtempSync(join(tmpdir(), 'gallery-video-test-'));
afterAll(() => rmSync(uploadState.root, { recursive: true, force: true }));

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


it('imports a large staged video without the JSON ceiling and removes failed imports', async () => {
  const tempPath = join(uploadState.root, 'source.mp4');
  const bytes = Buffer.concat([ftyp('isom'), Buffer.alloc(56 * 1024 * 1024)]);
  writeFileSync(tempPath, bytes);
  const entry = await saveUploadedGalleryVideoFile(tempPath, 'large.mp4');
  expect(entry).toMatchObject({ title: 'large.mp4', source: 'upload', durationSec: 2 });
  expect(uploadState.history[0]).toEqual(entry);
  expect(readFileSync(join(uploadState.root, entry.filename)).equals(bytes)).toBe(true);
  uploadState.fail = true;
  const { readdirSync } = await import('fs');
  const before = readdirSync(uploadState.root).sort();
  await expect(saveUploadedGalleryVideoFile(tempPath, 'failed.mp4')).rejects.toThrow('history write failed');
  expect(readdirSync(uploadState.root).sort()).toEqual(before);
  expect(existsSync(tempPath)).toBe(true);
});
