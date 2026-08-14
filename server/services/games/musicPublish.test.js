import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
  track: null,
  source: Buffer.from('theme-audio-v1'),
  destination: null,
}));

// Normalize separators at every mock boundary. The service composes these
// paths with path.join, so on Windows it asks for '\\app\\game\\assets\\music\\…'
// while the fixtures below are spelled POSIX — the reads then missed, and the
// service reported the audio as "missing or unreadable" instead of publishing.
// The leading drive letter goes too: publishCore anchors the repo with
// resolve(app.repoPath), and resolve('/app') on Windows yields 'H:\app' — the
// drive of the current working directory. These fixtures describe a
// POSIX-rooted repo, so drop the drive to compare the part that is meaningful.
const toPosix = (v) => (typeof v === 'string'
  ? v.split('\\').join('/').replace(/^[A-Za-z]:/, '')
  : v);

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (rawPath) => {
    const path = toPosix(rawPath);
    if (path === '/library/example-theme.ogg') return state.source;
    if (path === '/app/game/assets/music/example-theme.ogg' && state.destination) return state.destination;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { music: '/library' },
  atomicWrite: vi.fn(async (rawPath, bytes) => {
    const path = toPosix(rawPath);
    if (path === '/app/game/assets/music/example-theme.ogg') state.destination = Buffer.from(bytes);
  }),
  isPathInsideDir: vi.fn((dir, candidate) => toPosix(candidate).startsWith(`${toPosix(dir)}/`)),
}));

vi.mock('../apps.js', () => ({
  getAppById: vi.fn(async () => ({ id: 'app-1', name: 'Example App', repoPath: '/app' })),
}));

vi.mock('../appDeployer.js', () => ({ isDeploying: vi.fn(() => false) }));

vi.mock('../tracks/index.js', () => ({
  getTrack: vi.fn(async () => state.track),
}));

vi.mock('../pipeline/musicLibrary.js', () => ({
  isSafeMusicFilename: vi.fn((name) => /^[^/\\]+\.(?:mp3|wav|m4a|ogg|flac)$/i.test(String(name || ''))),
}));

vi.mock('./records.js', () => ({
  getGame: vi.fn(async () => state.game),
  mutateGame: vi.fn(async (_id, mutator) => {
    state.game = await mutator(state.game);
    return state.game;
  }),
}));

import { atomicWrite } from '../../lib/fileUtils.js';
import { isDeploying } from '../appDeployer.js';
import { publishGameMusic } from './musicPublish.js';

const gameFixture = () => ({
  id: 'game-1',
  appId: 'app-1',
  musicBindings: [{
    id: 'music-1',
    trackId: 'theme',
    destinationPath: 'game/assets/music/example-theme.ogg',
    publication: null,
  }],
});

describe('publishGameMusic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.game = gameFixture();
    state.track = { id: 'theme', title: 'Example Theme', audioFilename: 'example-theme.ogg' };
    state.source = Buffer.from('theme-audio-v1');
    state.destination = null;
  });

  it('publishes library audio bytes and records provenance', async () => {
    const result = await publishGameMusic('game-1', 'music-1');
    expect(result.publication.wrote).toBe(true);
    expect(state.destination).toEqual(state.source);
    expect(state.game.musicBindings[0].publication).toMatchObject({
      destinationPath: 'game/assets/music/example-theme.ogg',
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('is a byte-preserving no-op when the destination is current', async () => {
    state.destination = Buffer.from(state.source);
    const result = await publishGameMusic('game-1', 'music-1');
    expect(result.publication.wrote).toBe(false);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('refuses to replace unmanaged destination bytes without acknowledgement', async () => {
    state.destination = Buffer.from('hand-authored-game-audio');
    await expect(publishGameMusic('game-1', 'music-1')).rejects.toMatchObject({
      code: 'PUBLISH_DEST_OCCUPIED',
      status: 409,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('overwrites unmanaged destination bytes once acknowledged', async () => {
    state.destination = Buffer.from('hand-authored-game-audio');
    const result = await publishGameMusic('game-1', 'music-1', { acknowledgeOverwrite: true });
    expect(result.publication.wrote).toBe(true);
    expect(state.destination).toEqual(state.source);
  });

  it('requires a destination before publishing', async () => {
    state.game.musicBindings[0].destinationPath = null;
    await expect(publishGameMusic('game-1', 'music-1')).rejects.toMatchObject({
      code: 'MUSIC_DESTINATION_REQUIRED',
      status: 409,
    });
  });

  it('refuses a track that has no rendered audio yet', async () => {
    state.track = { id: 'theme', title: 'Example Theme' };
    await expect(publishGameMusic('game-1', 'music-1')).rejects.toMatchObject({
      code: 'TRACK_AUDIO_REQUIRED',
      status: 409,
    });
  });

  it('refuses to write while the bound app is deploying', async () => {
    isDeploying.mockReturnValueOnce(true);
    await expect(publishGameMusic('game-1', 'music-1')).rejects.toMatchObject({
      code: 'APP_DEPLOY_IN_PROGRESS',
      status: 409,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});
