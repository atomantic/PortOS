import { beforeEach, describe, expect, it, vi } from 'vitest';
import { posixPath as toPosix } from '../../lib/testHelper.js';

const state = vi.hoisted(() => ({
  game: null,
  manifestExists: false,
  manifestSha256: null,
}));

vi.mock('./store.js', () => ({
  gameRecordDir: (id) => `/tmp/games/${id}`,
  isValidGameId: (id) => id === 'game-1',
  queueGameWrite: vi.fn(async (_id, fn) => fn()),
  readRaw: vi.fn(async () => state.game),
  writeRaw: vi.fn(async (_id, record) => {
    state.game = record;
    return record;
  }),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { images: '/tmp/images', music: '/tmp/music' },
  atomicWrite: vi.fn(async () => { state.manifestExists = true; }),
  pathExists: vi.fn(async (rawPath) =>
    toPosix(rawPath).includes('/manifests/') ? state.manifestExists : true),
  readJSONFile: vi.fn(async () => null),
  sha256Text: vi.fn((value) => `text-sha:${String(value).length}`),
  sha256File: vi.fn(async (rawPath) => {
    // compile.js builds these with path.join, so on Windows the separators are
    // backslashes and every '/segment/' matcher below silently takes the wrong
    // branch — routing the manifest through the sprite/audio cases.
    const path = toPosix(rawPath);
    if (path.includes('/manifests/')) return state.manifestSha256;
    const spriteId = path.match(/\/sprites\/([^/]+)\//)?.[1];
    if (path.endsWith('title.png')) return 'title-art-sha';
    if (path.endsWith('.png')) return `atlas-${spriteId}`;
    if (path.endsWith('.json')) return `manifest-${spriteId}`;
    return 'audio-sha';
  }),
}));

vi.mock('../apps.js', () => ({
  getAppById: vi.fn(async () => ({ id: 'app-1', name: 'Example App' })),
}));

vi.mock('../sprites/records.js', () => ({
  getRecord: vi.fn(async (id) => ({ id, name: `Sprite ${id}`, kind: 'character' })),
}));

vi.mock('../sprites/atlas.js', () => ({
  getAtlasState: vi.fn(async (id) => ({
    current: {
      version: 3,
      atlasPath: `runtime/v3/${id}.png`,
      atlasSha256: `atlas-${id}`,
      manifestPath: `runtime/v3/${id}.json`,
      manifestSha256: `manifest-${id}`,
      geometry: { frameWidth: 32, frameHeight: 32 },
    },
    publications: [],
  })),
}));

vi.mock('../sprites/paths.js', () => ({
  listRuntimeAtlasAssets: vi.fn(async () => []),
  safeResolveSpriteAssetPath: vi.fn((id, path) => `/tmp/sprites/${id}/${path}`),
}));

vi.mock('../sprites/recordsLogic.js', () => ({
  isValidSpriteId: vi.fn(() => true),
}));

vi.mock('../tracks/index.js', () => ({
  getTrack: vi.fn(async (id) => ({ id, title: `Track ${id}`, audioFilename: `${id}.ogg` })),
}));

vi.mock('../pipeline/musicLibrary.js', () => ({
  statMusicTrack: vi.fn(async (filename) => ({ filename, sizeBytes: 100 })),
  isSafeMusicFilename: vi.fn((name) => /\.(?:mp3|wav|m4a|ogg|flac)$/i.test(String(name || ''))),
}));

import { atomicWrite } from '../../lib/fileUtils.js';
import { compileGameAssets } from './compile.js';

describe('compileGameAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.manifestExists = false;
    state.manifestSha256 = null;
    state.game = {
      id: 'game-1',
      schemaVersion: 1,
      appId: 'app-1',
      name: 'Example Game',
      spriteBindings: [{ spriteId: 'zeta' }, { spriteId: 'alpha' }],
      musicBindings: [
        { id: 'music-2', trackId: 'track-z' },
        { id: 'music-1', trackId: 'track-a' },
      ],
      artworkBindings: [{
        id: 'artwork-1',
        imageFilename: 'title.png',
        label: 'Title Key Art',
        role: 'title-key-art',
        destinationPath: 'game/assets/art/title.png',
        publication: null,
      }],
      compiledManifest: null,
      compileHistory: [],
      feedbackHistory: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  });

  it('writes a stable, sorted manifest and reuses it for identical inputs', async () => {
    const first = await compileGameAssets('game-1');
    expect(first.created).toBe(true);
    expect(first.version).toBe(1);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    const [, serialized] = atomicWrite.mock.calls[0];
    const manifest = JSON.parse(serialized);
    state.manifestSha256 = first.manifestSha256;
    expect(manifest.sprites.map((sprite) => sprite.spriteId)).toEqual(['alpha', 'zeta']);
    expect(manifest.music.map((track) => track.trackId)).toEqual(['track-a', 'track-z']);
    expect(manifest.artwork).toEqual([
      expect.objectContaining({ bindingId: 'artwork-1', role: 'title-key-art' }),
    ]);
    expect(first.artworkCount).toBe(1);

    const second = await compileGameAssets('game-1');
    expect(second).toEqual({ ...state.game.compiledManifest, created: false });
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });
});
