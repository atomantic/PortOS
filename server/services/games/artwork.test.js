import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
  source: Buffer.from('title-art-v1'),
  destination: null,
}));

// Normalize separators AND drop the drive letter at every mock boundary. The
// service composes these with path.join and anchors the repo with
// resolve(app.repoPath) — on Windows that yields H:\app\game\… — while the
// fixtures below are spelled POSIX, so every read/write missed and the service
// reported the artwork as missing.
const toPosix = (v) => (typeof v === 'string'
  ? v.split('\\').join('/').replace(/^[A-Za-z]:/, '')
  : v);

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (rawPath) => {
    const path = toPosix(rawPath);
    if (path === '/gallery/title.png') return state.source;
    if (path === '/app/game/assets/art/title.png' && state.destination) return state.destination;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { images: '/gallery' },
  atomicWrite: vi.fn(async (rawPath, bytes) => {
    const path = toPosix(rawPath);
    if (path === '/app/game/assets/art/title.png') state.destination = Buffer.from(bytes);
  }),
  isPathInsideDir: vi.fn((dir, candidate) => toPosix(candidate).startsWith(`${toPosix(dir)}/`)),
}));

vi.mock('../apps.js', () => ({
  getAppById: vi.fn(async () => ({ id: 'app-1', name: 'Example App', repoPath: '/app' })),
}));

vi.mock('../appDeployer.js', () => ({ isDeploying: vi.fn(() => false) }));

vi.mock('./records.js', () => ({
  getGame: vi.fn(async () => state.game),
  mutateGame: vi.fn(async (_id, mutator) => {
    state.game = await mutator(state.game);
    return state.game;
  }),
}));

import { atomicWrite } from '../../lib/fileUtils.js';
import { publishGameArtwork } from './artwork.js';

const gameFixture = () => ({
  id: 'game-1',
  appId: 'app-1',
  artworkBindings: [{
    id: 'artwork-1',
    imageFilename: 'title.png',
    label: 'Title Key Art',
    role: 'title-key-art',
    destinationPath: 'game/assets/art/title.png',
    publication: null,
  }],
});

describe('publishGameArtwork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.game = gameFixture();
    state.source = Buffer.from('title-art-v1');
    state.destination = null;
  });

  it('publishes gallery bytes and records provenance', async () => {
    const result = await publishGameArtwork('game-1', 'artwork-1');
    expect(result.publication.wrote).toBe(true);
    expect(state.destination).toEqual(state.source);
    expect(state.game.artworkBindings[0].publication).toMatchObject({
      destinationPath: 'game/assets/art/title.png',
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('is a byte-preserving no-op when the destination is current', async () => {
    state.destination = Buffer.from(state.source);
    const result = await publishGameArtwork('game-1', 'artwork-1');
    expect(result.publication.wrote).toBe(false);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('refuses to replace unmanaged destination bytes without acknowledgement', async () => {
    state.destination = Buffer.from('hand-authored-game-art');
    await expect(publishGameArtwork('game-1', 'artwork-1')).rejects.toMatchObject({
      code: 'PUBLISH_DEST_OCCUPIED',
      status: 409,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});
