import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
  records: {},
  atlases: {},
  assets: {},
  manifest: null,
  tracks: {},
}));

vi.mock('./records.js', () => ({
  getGame: vi.fn(async () => state.game),
}));

vi.mock('./store.js', () => ({
  gameRecordDir: (id) => `/tmp/games/${id}`,
}));

vi.mock('../apps.js', () => ({
  getAppById: vi.fn(async () => ({ id: 'app-1', name: 'Example App' })),
}));

vi.mock('../sprites/records.js', () => ({
  getRecord: vi.fn(async (id) => state.records[id] || null),
}));

vi.mock('../sprites/atlas.js', () => ({
  getAtlasState: vi.fn(async (id) => ({
    current: state.atlases[id] || null,
    publications: [],
  })),
}));

vi.mock('../sprites/paths.js', () => ({
  listRuntimeAtlasAssets: vi.fn(async (id) => state.assets[id] || []),
  safeResolveSpriteAssetPath: vi.fn((id, path) => `/tmp/sprites/${id}/${path}`),
}));

vi.mock('../sprites/recordsLogic.js', () => ({
  isValidSpriteId: vi.fn((id) => !String(id).includes('/')),
}));

vi.mock('../tracks/index.js', () => ({
  getTrack: vi.fn(async (id) => state.tracks[id] || null),
}));

vi.mock('../pipeline/musicLibrary.js', () => ({
  statMusicTrack: vi.fn(async (filename) => {
    if (filename.startsWith('../')) throw new Error('unsafe filename');
    return { sizeBytes: 128 };
  }),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { music: '/tmp/music' },
  readJSONFile: vi.fn(async () => state.manifest),
  sha256Text: vi.fn((value) => `text-sha:${String(value).length}`),
  sha256File: vi.fn(async (path) => {
    if (path.includes('/games/')) return 'bundle-sha';
    if (path.endsWith('native.png')) return 'native-atlas-sha';
    if (path.endsWith('native.json')) return 'native-manifest-sha';
    if (path.endsWith('props.png')) return 'props-sha';
    if (path.endsWith('.ogg')) return 'music-sha';
    return null;
  }),
}));

import { getGameIntegrity, resolveGameAssets } from './integrity.js';

const baseGame = () => ({
  id: 'game-1',
  appId: 'app-1',
  name: 'Example Game',
  spriteBindings: [
    { spriteId: 'native' },
    { spriteId: 'props' },
    { spriteId: 'draft-character' },
  ],
  musicBindings: [{ id: 'music-1', trackId: 'theme' }],
  compiledManifest: null,
});

describe('Game bundle integrity', () => {
  beforeEach(() => {
    state.game = baseGame();
    state.records = {
      native: { id: 'native', name: 'Native Hero', kind: 'character' },
      props: { id: 'props', name: 'Imported Props', kind: 'props' },
      'draft-character': { id: 'draft-character', name: 'Draft Character', kind: 'character' },
    };
    state.atlases = {
      native: {
        version: 4,
        atlasPath: 'runtime/v4/native.png',
        atlasSha256: 'native-atlas-sha',
        manifestPath: 'runtime/v4/native.json',
        manifestSha256: 'native-manifest-sha',
        geometry: { cellSize: 96 },
      },
    };
    state.assets = {
      props: [{ path: 'atlas/props.png', size: 512 }],
    };
    state.tracks = {
      theme: {
        id: 'theme',
        title: 'Example Theme',
        audioFilename: 'example-theme.ogg',
      },
    };
    state.manifest = null;
  });

  it('accepts native and imported runtime assets while preserving draft blockers', async () => {
    const resolved = await resolveGameAssets(state.game);
    expect(resolved.sprites.map((sprite) => [sprite.spriteId, sprite.sourceType])).toEqual([
      ['native', 'runtime-atlas'],
      ['props', 'imported-assets'],
    ]);
    expect(resolved.music).toHaveLength(1);
    expect(resolved.issues).toEqual([
      expect.objectContaining({
        assetId: 'draft-character',
        code: 'SPRITE_ATLAS_REQUIRED',
      }),
    ]);
    expect(resolved.summaries.sprites).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: 'props', status: 'ready', fileCount: 1 }),
      expect.objectContaining({ assetId: 'draft-character', status: 'blocked' }),
    ]));
  });

  it('reports a corrupt binding id as a blocked asset instead of throwing', async () => {
    // The atlas pointer read is issued in parallel with the record read, so a
    // binding whose id is not a valid slug must be gated — `spriteDir` throws a
    // 400 on one, which would fail the whole preflight instead of naming the
    // one bad binding.
    state.game.spriteBindings = [{ spriteId: '../escape' }];
    const resolved = await resolveGameAssets(state.game);
    expect(resolved.sprites).toEqual([]);
    expect(resolved.issues).toEqual([
      expect.objectContaining({ assetId: '../escape', code: 'SPRITE_MISSING' }),
    ]);
    expect(resolved.summaries.sprites[0]).toMatchObject({ status: 'blocked' });
  });

  it('does not accept loose atlas files as a compiled character atlas', async () => {
    state.game.spriteBindings = [{ spriteId: 'draft-character' }];
    state.game.musicBindings = [];
    state.assets['draft-character'] = [{ path: 'atlas/placeholder.png', size: 64 }];

    const resolved = await resolveGameAssets(state.game);

    expect(resolved.sprites).toEqual([]);
    expect(resolved.issues).toEqual([
      expect.objectContaining({
        assetId: 'draft-character',
        code: 'SPRITE_ATLAS_REQUIRED',
      }),
    ]);
  });

  it('reports an invalid stored audio path as one blocked asset', async () => {
    state.game.spriteBindings = [];
    state.tracks.theme.audioFilename = '../bad.mp3';

    const resolved = await resolveGameAssets(state.game);

    expect(resolved.music).toEqual([]);
    expect(resolved.issues).toEqual([
      expect.objectContaining({
        assetId: 'theme',
        code: 'TRACK_AUDIO_INTEGRITY_FAILED',
      }),
    ]);
    expect(resolved.summaries.music[0]).toMatchObject({
      status: 'blocked',
      message: 'Audio path invalid',
    });
  });

  it('marks a complete hash-matching manifest current and launchable', async () => {
    state.game.spriteBindings = state.game.spriteBindings.filter(
      (binding) => binding.spriteId !== 'draft-character',
    );
    const resolved = await resolveGameAssets(state.game);
    state.game.compiledManifest = {
      version: 3,
      manifestPath: 'manifests/game-assets-v3.json',
      manifestSha256: 'bundle-sha',
      inputSha256: resolved.inputSha256,
    };
    state.manifest = {
      kind: 'portos-game-assets',
      game: { id: 'game-1' },
      version: 3,
    };

    const integrity = await getGameIntegrity('game-1');
    expect(integrity.bundle.status).toBe('current');
    expect(integrity.readyToCompile).toBe(true);
    expect(integrity.canLaunch).toBe(true);
    expect(integrity.counts).toMatchObject({
      spriteReady: 2,
      spriteTotal: 2,
      musicReady: 1,
      musicTotal: 1,
      verifiedFiles: 4,
    });
  });

  it('marks the bundle stale when the serialized game name changes', async () => {
    state.game.spriteBindings = state.game.spriteBindings.filter(
      (binding) => binding.spriteId !== 'draft-character',
    );
    const resolved = await resolveGameAssets(state.game);
    state.game.compiledManifest = {
      version: 3,
      manifestPath: 'manifests/game-assets-v3.json',
      manifestSha256: 'bundle-sha',
      inputSha256: resolved.inputSha256,
    };
    state.manifest = {
      kind: 'portos-game-assets',
      game: { id: 'game-1', name: state.game.name },
      version: 3,
    };
    state.game.name = 'Renamed Example Game';

    const integrity = await getGameIntegrity('game-1');

    expect(integrity.bundle.status).toBe('stale');
    expect(integrity.canLaunch).toBe(false);
  });
});
