import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
  records: {},
  atlases: {},
  assets: {},
  manifest: null,
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
  isValidSpriteId: vi.fn(() => true),
}));

vi.mock('../tracks/index.js', () => ({
  getTrack: vi.fn(async (id) => ({
    id,
    title: 'Example Theme',
    audioFilename: 'example-theme.ogg',
  })),
}));

vi.mock('../pipeline/musicLibrary.js', () => ({
  statMusicTrack: vi.fn(async () => ({ sizeBytes: 128 })),
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
});
