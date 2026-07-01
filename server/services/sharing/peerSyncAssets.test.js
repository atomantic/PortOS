import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// Seed a root before the dynamic import below: peerSyncAssets transitively
// pulls in modules that read PATHS.data at module-evaluation time, so the
// proxy's dataRoot getter must already resolve to a string.
let tempRoot = mkdtempSync(join(tmpdir(), 'portos-mv-assets-boot-'));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => tempRoot,
    extraOverrides: (root) => ({ music: join(root, 'music'), images: join(root, 'images') }),
  });
});

// Tracks are db-primary; stub the dispatcher so the manifest builder never
// touches Postgres. trackAudioFilename mirrors the real basename sanitizer.
vi.mock('../tracks/index.js', async () => ({
  getTrack: vi.fn(),
  trackAudioFilename: vi.fn((name) =>
    (typeof name === 'string' && name.trim() && !/[\\/]|\.\./.test(name) ? name.trim() : null)),
}));

const { getTrack } = await import('../tracks/index.js');
const { buildMusicVideoAssetManifest, buildProjectAssetManifest } = await import('./peerSyncAssets.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function writeMusic(filename, bytes) {
  const dir = join(tempRoot, 'music');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

function writeImage(filename, bytes) {
  const dir = join(tempRoot, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

describe('buildMusicVideoAssetManifest — master audio', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-mv-assets-'));
    vi.mocked(getTrack).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('bundles the uploaded audio basename (no track)', async () => {
    const bytes = Buffer.from('uploaded-audio');
    writeMusic('upload.mp3', bytes);
    const manifest = await buildMusicVideoAssetManifest({
      trackId: null, uploadedAudioFilename: 'upload.mp3', scenes: [],
    });
    expect(manifest).toContainEqual({ filename: 'upload.mp3', kind: 'music', sha256: sha(bytes) });
    expect(getTrack).not.toHaveBeenCalled();
  });

  it('resolves and bundles the linked track audio when uploadedAudioFilename is null (#1858)', async () => {
    const bytes = Buffer.from('track-audio');
    writeMusic('track-1.wav', bytes);
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-1', audioFilename: 'track-1.wav' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-1', uploadedAudioFilename: null, scenes: [],
    });
    expect(getTrack).toHaveBeenCalledWith('trk-1');
    expect(manifest).toContainEqual({ filename: 'track-1.wav', kind: 'music', sha256: sha(bytes) });
  });

  it('skips a missing/deleted track without throwing', async () => {
    vi.mocked(getTrack).mockResolvedValue(null);
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'gone', uploadedAudioFilename: null, scenes: [],
    });
    expect(manifest).toEqual([]);
  });

  it('skips a track whose audio file is absent on disk (never ships a null hash)', async () => {
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-2', audioFilename: 'nope.wav' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-2', uploadedAudioFilename: null, scenes: [],
    });
    expect(manifest).toEqual([]);
  });

  it('dedups when the upload basename and the linked track point at the same file', async () => {
    const bytes = Buffer.from('shared');
    writeMusic('shared.mp3', bytes);
    vi.mocked(getTrack).mockResolvedValue({ id: 'trk-3', audioFilename: 'shared.mp3' });
    const manifest = await buildMusicVideoAssetManifest({
      trackId: 'trk-3', uploadedAudioFilename: 'shared.mp3', scenes: [],
    });
    const audio = manifest.filter((m) => m.kind === 'music');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toEqual({ filename: 'shared.mp3', kind: 'music', sha256: sha(bytes) });
  });
});

describe('buildProjectAssetManifest — first-pass music bed (#1928)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-cd-assets-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns an empty manifest for a bare project (no image, no music bed)', async () => {
    const manifest = await buildProjectAssetManifest({ startingImageFile: null, musicBed: null });
    expect(manifest).toEqual([]);
  });

  it('bundles the music bed so a subscribed peer does not get a dangling reference', async () => {
    const bytes = Buffer.from('music-bed-bytes');
    writeMusic('music-gen-abc.wav', bytes);
    const manifest = await buildProjectAssetManifest({
      startingImageFile: null,
      musicBed: { filename: 'music-gen-abc.wav', durationSec: 12, engine: 'musicgen' },
    });
    expect(manifest).toEqual([{ filename: 'music-gen-abc.wav', kind: 'music', sha256: sha(bytes) }]);
  });

  it('skips a music bed whose file is absent on disk (never ships a null hash)', async () => {
    const manifest = await buildProjectAssetManifest({
      startingImageFile: null,
      musicBed: { filename: 'never-written.wav' },
    });
    expect(manifest).toEqual([]);
  });

  it('bundles both the starting image and the music bed together', async () => {
    const imageBytes = Buffer.from('starting-image-bytes');
    const musicBytes = Buffer.from('music-bed-bytes-2');
    writeImage('start.png', imageBytes);
    writeMusic('music-gen-def.wav', musicBytes);
    const manifest = await buildProjectAssetManifest({
      startingImageFile: 'start.png',
      musicBed: { filename: 'music-gen-def.wav' },
    });
    expect(manifest).toContainEqual({ filename: 'start.png', kind: 'image', sha256: sha(imageBytes) });
    expect(manifest).toContainEqual(expect.objectContaining({ filename: 'music-gen-def.wav', kind: 'music', sha256: sha(musicBytes) }));
    expect(manifest).toHaveLength(2);
  });
});
