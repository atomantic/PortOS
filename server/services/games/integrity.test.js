import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
  records: {},
  atlases: {},
  assets: {},
  manifest: null,
  // On-disk bytes, keyed by the suffix `sha256File` is asked for. Tests mutate
  // this to simulate a file whose bytes changed under a recorded hash, or that
  // vanished (`null`) — without it the mock always echoes the hash the fixture
  // pointer declares, so the mismatch comparison can never be false and a
  // regression that inverted it would ship green.
  hashes: {},
  // Distinct from `hashes[path] === null` (missing): an unreadable file, which
  // must produce the same verdict but a different diagnosis.
  unreadable: new Set(),
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
  getTrack: vi.fn(async (id) => ({
    id,
    title: 'Example Theme',
    audioFilename: 'example-theme.ogg',
  })),
}));

vi.mock('../pipeline/musicLibrary.js', () => ({
  statMusicTrack: vi.fn(async () => ({ sizeBytes: 128 })),
  isSafeMusicFilename: vi.fn((name) => /\.(?:mp3|wav|m4a|ogg|flac)$/i.test(String(name || ''))),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { music: '/tmp/music' },
  readJSONFile: vi.fn(async () => state.manifest),
  // Content-exact, not length-based — a canonical-stringify change that happened
  // to preserve length must still register as a changed input.
  sha256Text: vi.fn((value) => `text-sha:${String(value)}`),
  // Mirrors the real `sha256File`: REJECTS on a file it can't read (the caller
  // owns the catch), so a test can drive the missing/unreadable branches.
  sha256File: vi.fn(async (path) => {
    const key = Object.keys(state.hashes).find((suffix) => path.endsWith(suffix));
    if (state.unreadable.has(key)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
    }
    const hash = key ? state.hashes[key] : null;
    if (hash === null || hash === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    }
    return hash;
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
    // Every file present and matching what its pointer records.
    state.hashes = {
      'native.png': 'native-atlas-sha',
      'native.json': 'native-manifest-sha',
      'props.png': 'props-sha',
      'example-theme.ogg': 'music-sha',
      'game-assets-v3.json': 'bundle-sha',
    };
    state.unreadable = new Set();
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

  // A "verified" bundle is only worth the hash comparisons behind it. These
  // drive the branches that decide missing / unreadable / changed bytes — the
  // detection the whole feature exists for.
  describe('hash verification', () => {
    const buildableGame = () => {
      state.game.spriteBindings = [{ spriteId: 'native' }];
      state.game.musicBindings = [];
    };

    it('blocks a sprite whose atlas bytes changed under its recorded hash', async () => {
      buildableGame();
      state.hashes['native.png'] = 'someone-recompressed-the-png';
      const resolved = await resolveGameAssets(state.game);
      expect(resolved.sprites).toEqual([]);
      expect(resolved.issues).toEqual([
        expect.objectContaining({
          assetId: 'native',
          code: 'SPRITE_ATLAS_INTEGRITY_FAILED',
        }),
      ]);
    });

    it('blocks a sprite whose atlas file is gone', async () => {
      buildableGame();
      state.hashes['native.png'] = null;
      const resolved = await resolveGameAssets(state.game);
      expect(resolved.issues[0]).toMatchObject({ code: 'SPRITE_ATLAS_INTEGRITY_FAILED' });
    });

    it('blocks a sprite whose atlas file is present but unreadable', async () => {
      // Same verdict as missing (no verifiable bytes), but the cause is a
      // permissions failure on intact bytes — `hashIfPresent` must not let the
      // EACCES escape and fail the whole read-only sweep.
      buildableGame();
      state.unreadable.add('native.png');
      const resolved = await resolveGameAssets(state.game);
      expect(resolved.issues[0]).toMatchObject({ code: 'SPRITE_ATLAS_INTEGRITY_FAILED' });
    });

    it('blocks an imported runtime asset that is unreadable', async () => {
      state.game.spriteBindings = [{ spriteId: 'props' }];
      state.game.musicBindings = [];
      state.unreadable.add('props.png');
      const resolved = await resolveGameAssets(state.game);
      expect(resolved.sprites).toEqual([]);
      expect(resolved.issues[0]).toMatchObject({
        assetId: 'props',
        code: 'SPRITE_ATLAS_INTEGRITY_FAILED',
      });
    });

    it('blocks a track whose stored filename is not a supported music name', async () => {
      // `sanitizeTrack` only trims the top-level audioFilename, so a legacy or
      // peer-synced track can carry one `statMusicTrack` would THROW a 400 on.
      // It has to become one blocked row, not a failed preflight.
      state.game.spriteBindings = [];
      const { getTrack } = await import('../tracks/index.js');
      getTrack.mockResolvedValueOnce({ id: 'theme', title: 'Legacy Theme', audioFilename: 'theme.opus' });
      const resolved = await resolveGameAssets(state.game);
      expect(resolved.music).toEqual([]);
      expect(resolved.issues).toEqual([
        expect.objectContaining({ assetId: 'theme', code: 'TRACK_AUDIO_REQUIRED' }),
      ]);
    });
  });

  describe('bundle status', () => {
    const withBuiltBundle = async (overrides = {}) => {
      state.game.spriteBindings = [{ spriteId: 'native' }];
      state.game.musicBindings = [];
      const resolved = await resolveGameAssets(state.game);
      state.game.compiledManifest = {
        version: 3,
        manifestPath: 'manifests/game-assets-v3.json',
        manifestSha256: 'bundle-sha',
        inputSha256: resolved.inputSha256,
        ...overrides,
      };
      state.manifest = { kind: 'portos-game-assets', game: { id: 'game-1' }, version: 3 };
      return resolved;
    };

    it('goes stale when a bound asset changes after the build', async () => {
      await withBuiltBundle();
      // Re-point the sprite at a new atlas version: same files, different
      // recorded hashes, so the resolved input no longer matches the pointer.
      state.atlases.native = { ...state.atlases.native, version: 5 };
      state.hashes['native.png'] = 'v5-atlas-sha';
      state.atlases.native.atlasSha256 = 'v5-atlas-sha';

      const integrity = await getGameIntegrity('game-1');
      expect(integrity.bundle.status).toBe('stale');
      expect(integrity.canLaunch).toBe(false);
    });

    it('goes stale when a bound asset is blocked, without launching', async () => {
      await withBuiltBundle();
      state.hashes['native.png'] = null;
      const integrity = await getGameIntegrity('game-1');
      expect(integrity.bundle.status).toBe('stale');
      expect(integrity.canLaunch).toBe(false);
    });

    it('is corrupt when the manifest file no longer matches its recorded hash', async () => {
      await withBuiltBundle();
      state.hashes['game-assets-v3.json'] = 'edited-by-hand';
      const integrity = await getGameIntegrity('game-1');
      expect(integrity.bundle.status).toBe('corrupt');
      expect(integrity.canLaunch).toBe(false);
    });

    it('is corrupt when the manifest file is gone', async () => {
      await withBuiltBundle();
      state.hashes['game-assets-v3.json'] = null;
      const integrity = await getGameIntegrity('game-1');
      expect(integrity.bundle.status).toBe('corrupt');
    });

    it('is corrupt when the manifest describes a different game or version', async () => {
      await withBuiltBundle();
      state.manifest = { kind: 'portos-game-assets', game: { id: 'other-game' }, version: 3 };
      expect((await getGameIntegrity('game-1')).bundle.status).toBe('corrupt');

      state.manifest = { kind: 'portos-game-assets', game: { id: 'game-1' }, version: 9 };
      expect((await getGameIntegrity('game-1')).bundle.status).toBe('corrupt');

      state.manifest = { kind: 'something-else', game: { id: 'game-1' }, version: 3 };
      expect((await getGameIntegrity('game-1')).bundle.status).toBe('corrupt');
    });

    it('is corrupt when the pointer records no manifest path at all', async () => {
      await withBuiltBundle({ manifestPath: '' });
      expect((await getGameIntegrity('game-1')).bundle.status).toBe('corrupt');
    });

    it('keeps a byte-perfect bundle current when only the managed app is missing', async () => {
      // The app blocker is not asset drift. Reporting `stale` here would tell
      // the user "Bound assets changed after this bundle was built" — false —
      // and pair a "Needs rebuild" badge with a disabled Rebuild button.
      await withBuiltBundle();
      const { getAppById } = await import('../apps.js');
      getAppById.mockResolvedValueOnce(null);

      const integrity = await getGameIntegrity('game-1');
      expect(integrity.bundle.status).toBe('current');
      expect(integrity.issues).toEqual([
        expect.objectContaining({ code: 'APP_MISSING', assetType: 'app' }),
      ]);
      expect(integrity.readyToCompile).toBe(false);
      expect(integrity.canLaunch).toBe(false);
    });
  });
});
