/** Real transactions against portos_test; no live database or media/provider work. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { checkHealth, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fixture = await vi.hoisted(async () => {
  const { randomUUID } = await import('node:crypto');
  return { schema: 'music_membership_' + randomUUID().replaceAll('-', ''), created: false };
});
const fault = vi.hoisted(() => ({ failWrite: 0, writes: 0 }));
// Every connection in this suite's pool has ONLY the invocation-owned schema
// in its search path. Never initialize or clean up the shared public schema.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: {
    ...actual.default,
    Pool: function Pool(options) {
      return new actual.default.Pool({ ...options, options: '-csearch_path=' + fixture.schema });
    },
  } };
});
// Only inject a persistence failure. BEGIN/COMMIT/ROLLBACK, row locks, advisory
// locks, reads and every other write still execute on the real PostgreSQL pool.
vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureSchema: async () => {
      if (!fixture.created) throw new Error('Fixture schema must exist before initializing music stores');
      const { libraryDdl } = await import('../lib/db/schema/library.js');
      for (const sql of libraryDdl) await actual.query(sql);
    },
    withTransaction: (operation) => actual.withTransaction((client) => operation({
      query: async (sql, params) => {
        if (/^INSERT INTO (albums|tracks)\b/.test(sql) && ++fault.writes === fault.failWrite) {
          // A real SQL error aborts this PostgreSQL transaction.
          return client.query('SELECT 1 / 0');
        }
        return client.query(sql, params);
      },
    })),
  };
});
vi.mock('../lib/pgFileFacade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isFileBackend: () => false,
    createRecordStoreBackendSelector: (options) => actual.createRecordStoreBackendSelector({ ...options, isTestMode: () => false }),
  };
});

const health = await checkHealth();
const runDb = requireDbOrSkip('trackAlbumMembership.db.test', health.connected, health.error);
const prefix = 'Example membership fixture';
const events = [];
const subscribe = vi.fn(async () => {});
let albums;
let tracks;
let membership;
let bus;
let app;
const onUpdated = (event) => events.push(['updated', event]);
const onDeleted = (event) => events.push(['deleted', event]);

const createAlbum = (input = {}) => membership.createAlbumWithTracks({ title: prefix, ...input });
const createTrack = async (albumId = '') => (await membership.createTrackWithAlbum({ title: prefix, albumId })).track;
const snapshot = async () => ({
  albums: (await query('SELECT data FROM albums WHERE title = $1 ORDER BY id', [prefix])).rows,
  tracks: (await query('SELECT data FROM tracks WHERE title = $1 ORDER BY id', [prefix])).rows,
});

async function cleanup() {
  await query('DELETE FROM tracks WHERE title = $1', [prefix]);
  await query('DELETE FROM albums WHERE title = $1', [prefix]);
}

describe.skipIf(!runDb)('atomic local album membership on PostgreSQL', () => {
  beforeAll(async () => {
    expect((await query('SELECT current_database() AS name')).rows[0].name).toBe('portos_test');
    vi.stubEnv('MEMORY_BACKEND', '');
    await query(`CREATE SCHEMA ${fixture.schema}`);
    fixture.created = true;
    expect((await query('SHOW search_path')).rows[0].search_path).toBe(fixture.schema);
    albums = await import('./albums/index.js');
    tracks = await import('./tracks/index.js');
    membership = await import('./trackAlbumMembership.js');
    await albums.prepareAlbumsBackend();
    await tracks.prepareTracksBackend();
    bus = await import('./sharing/recordEvents.js');
    bus.recordEvents.on('updated', onUpdated);
    bus.recordEvents.on('deleted', onDeleted);
    bus.registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: subscribe });
    const { default: routes } = await import('../routes/albums.js');
    app = express();
    app.use(express.json());
    app.use('/api/albums', routes);
    app.use(errorMiddleware);
  });
  beforeEach(async () => {
    await cleanup();
    fault.failWrite = 0;
    fault.writes = 0;
    events.length = 0;
    subscribe.mockClear();
  });
  afterAll(async () => {
    if (bus) {
      bus.recordEvents.off('updated', onUpdated);
      bus.recordEvents.off('deleted', onDeleted);
      bus.__resetSubscriptionAdapter();
    }
    try {
      if (fixture.created) await query(`DROP SCHEMA ${fixture.schema} CASCADE`);
    } finally {
      vi.unstubAllEnvs();
      await close();
    }
  });

  it('retains competing additions and admits only one claimant for the final slot', async () => {
    const album = await createAlbum();
    const additions = await Promise.all([createTrack(album.id), createTrack(album.id)]);
    expect((await albums.getAlbum(album.id)).trackIds.sort()).toEqual(additions.map((t) => t.id).sort());
    const full = await createAlbum({ trackIds: Array.from({ length: albums.TRACK_IDS_MAX - 1 }, (_, i) => `track-example-${i}`) });
    const results = await Promise.allSettled([createTrack(full.id), createTrack(full.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('ALBUM_FULL');
    expect((await albums.getAlbum(full.id)).trackIds).toHaveLength(albums.TRACK_IDS_MAX);
    const saved = (await snapshot()).tracks.map(({ data }) => data);
    expect(saved.filter((track) => track.albumId === full.id)).toHaveLength(1);
  });

  // Each case represents a different public mutation whose partial commit
  // would require a different repair (duplicate create, stale move or tombstone).
  it.each(['album create', 'album edit', 'album delete', 'track create', 'track move', 'track delete'])(
    'rolls back %s on a later write failure, emits nothing, and succeeds on retry', async (operation) => {
      const source = await createAlbum({ description: 'Preserved metadata' });
      const destination = await createAlbum();
      const track = await createTrack(source.id);
      const before = await snapshot();
      const actions = {
        'album create': () => request(app).post('/api/albums').send({ title: prefix, trackIds: [track.id] }),
        'album edit': () => request(app).patch(`/api/albums/${source.id}`).send({ trackIds: [] }),
        'album delete': () => request(app).delete(`/api/albums/${source.id}`),
        'track create': () => createTrack(source.id),
        'track move': () => membership.updateTrackWithAlbum(track, { albumId: destination.id }),
        'track delete': () => membership.deleteTrackWithAlbum(track.id),
      };
      fault.writes = 0;
      fault.failWrite = operation === 'track move' ? 3 : 2;
      events.length = 0;
      subscribe.mockClear();
      if (operation.startsWith('album')) {
        const response = await actions[operation]();
        expect(response.status).toBe(500);
        expect(response.body).toMatchObject({ code: expect.any(String), error: expect.any(String) });
      } else {
        await expect(actions[operation]()).rejects.toThrow('division by zero');
      }
      expect(await snapshot()).toEqual(before);
      expect(events).toEqual([]);
      expect(subscribe).not.toHaveBeenCalled();
      fault.failWrite = 0;
      const result = await actions[operation]();
      if (operation.startsWith('album')) expect(result.status).toBe(operation === 'album create' ? 201 : 200);
      expect(events.length).toBeGreaterThan(0);
      if (operation === 'album create') expect((await snapshot()).albums).toHaveLength(3);
      if (operation === 'track create') expect((await snapshot()).tracks).toHaveLength(2);
      if (operation === 'album delete') expect((await tracks.getTrack(track.id)).albumId).toBe('');
      if (operation === 'track delete') expect((await albums.getAlbum(source.id)).trackIds).toEqual([]);
    },
  );

  it('shares the lock across album edits and stale track moves without replacing metadata', async () => {
    const source = await createAlbum();
    const destination = await createAlbum({ genre: 'Example genre' });
    const third = await createAlbum();
    const track = await createTrack(source.id);
    const neighbor = await createTrack(destination.id);
    await membership.updateAlbumWithTracks(destination.id, { trackIds: [neighbor.id, track.id] });
    await Promise.all([
      membership.updateTrackWithAlbum(track, { albumId: third.id }),
      membership.updateAlbumWithTracks(destination.id, { description: 'Example description' }),
    ]);
    expect(await albums.getAlbum(destination.id)).toMatchObject({ trackIds: [neighbor.id], genre: 'Example genre', description: 'Example description' });
    expect((await albums.getAlbum(source.id)).trackIds).toEqual([]);
    expect((await tracks.getTrack(track.id)).albumId).toBe(third.id);
    expect((await albums.getAlbum(third.id)).trackIds).toEqual([track.id]);
  });
});
