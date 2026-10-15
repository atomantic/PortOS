import { describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({ reserved: 0, capacity: 20 }));
// A bounded pool stand-in rejects instead of waiting ten seconds when cold
// backend health checks compete for a fully reserved transaction pool.
vi.mock('../lib/db.js', () => ({
  checkHealth: async () => {
    if (pool.reserved === pool.capacity) throw new Error('Synthetic pool exhausted during backend initialization');
    return { connected: true };
  },
  ensureSchema: async () => {},
  withTransaction: async (operation) => {
    pool.reserved++;
    await Promise.resolve();
    try {
      return await operation({ query: async () => ({ rows: [] }) });
    } finally {
      pool.reserved--;
    }
  },
}));
vi.mock('../lib/pgFileFacade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isFileBackend: () => false,
    createRecordStoreBackendSelector: (options) => actual.createRecordStoreBackendSelector({ ...options, isTestMode: () => false }),
  };
});
vi.mock('./albums/db.js', () => ({}));
vi.mock('./tracks/db.js', () => ({
  createTrack: async (input) => ({ id: `track-${input.title}`, ...input }),
}));

import { createTrackWithAlbum } from './trackAlbumMembership.js';

describe('cold music store startup', () => {
  it('completes a full pool of concurrent first writes without starving backend initialization', async () => {
    vi.stubEnv('MEMORY_BACKEND', '');
    try {
      const saved = await Promise.all(Array.from({ length: pool.capacity }, (_, i) =>
        createTrackWithAlbum({ title: `example-${i}` })));
      expect(new Set(saved.map(({ track }) => track.id)).size).toBe(pool.capacity);
      expect(saved.every(({ track }) => track.albumId === '')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
