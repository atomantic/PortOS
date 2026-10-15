import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const failure = vi.hoisted(() => ({ writes: [], reads: null }));
const dataRoot = mkdtempSync(join(tmpdir(), 'music-membership-'));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: dataRoot },
    readJSONFile: async (path, ...args) => {
      if (failure.reads && path.endsWith(failure.reads)) throw new Error('Synthetic read failure');
      return actual.readJSONFile(path, ...args);
    },
    atomicWrite: async (path, records) => {
      if (failure.writes.length && path.endsWith(failure.writes[0])) {
        failure.writes.shift();
        throw new Error('Synthetic write failure');
      }
      return actual.atomicWrite(path, records);
    },
  };
});

const albums = await import('./albums/index.js');
const tracks = await import('./tracks/index.js');
const membership = await import('./trackAlbumMembership.js');
const { recordEvents, registerSubscriptionAdapter, __resetSubscriptionAdapter } = await import('./sharing/recordEvents.js');
const { default: routes } = await import('../routes/albums.js');
const app = express();
app.use(express.json());
app.use('/api/albums', routes);
app.use(errorMiddleware);
const events = [];
const updated = (...args) => events.push(['updated', ...args]);
const deleted = (...args) => events.push(['deleted', ...args]);
recordEvents.on('updated', updated);
recordEvents.on('deleted', deleted);
const subscribe = vi.fn(async () => {});

beforeEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  failure.writes = [];
  failure.reads = null;
  events.length = 0;
  subscribe.mockClear();
  registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: subscribe });
});
afterAll(() => {
  recordEvents.off('updated', updated);
  recordEvents.off('deleted', deleted);
  __resetSubscriptionAdapter();
  rmSync(dataRoot, { recursive: true, force: true });
});

const createAlbum = (input = {}) => membership.createAlbumWithTracks({ title: 'Example Album', ...input });
const createTrack = async (albumId = '') => (await membership.createTrackWithAlbum({ title: 'Example Track', albumId })).track;

describe('local membership workflows through real file persistence (not a PostgreSQL guarantee)', () => {
  it('retains concurrent additions in order and enforces the final slot without an orphan', async () => {
    const album = await createAlbum();
    const added = await Promise.all([createTrack(album.id), createTrack(album.id)]);
    expect((await albums.getAlbum(album.id)).trackIds).toEqual(added.map((track) => track.id));
    const full = await createAlbum({ trackIds: Array.from({ length: albums.TRACK_IDS_MAX - 1 }, (_, i) => `track-example-${i}`) });
    const results = await Promise.allSettled([createTrack(full.id), createTrack(full.id)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason.code).toBe('ALBUM_FULL');
    expect((await tracks.listTracks()).filter((track) => track.albumId === full.id)).toHaveLength(1);
    expect((await albums.getAlbum(full.id)).trackIds).toHaveLength(albums.TRACK_IDS_MAX);
    await membership.updateTrackWithAlbum(results[0].value, { albumId: full.id });
  });

  it('serializes album edits, stale track moves and deletion while preserving metadata and order', async () => {
    const source = await createAlbum();
    const destination = await createAlbum({ genre: 'example genre' });
    const third = await createAlbum();
    const track = await createTrack(source.id);
    const neighbor = await createTrack(destination.id);
    const saved = await request(app).patch(`/api/albums/${destination.id}`).send({ trackIds: [neighbor.id, track.id] });
    expect(saved.status).toBe(200);
    await membership.updateTrackWithAlbum(track, { albumId: third.id, title: 'Example edit' });
    expect((await albums.getAlbum(source.id)).trackIds).toEqual([]);
    expect(await albums.getAlbum(destination.id)).toMatchObject({ trackIds: [neighbor.id], genre: 'example genre' });
    await Promise.all([
      membership.deleteTrackWithAlbum(track.id),
      request(app).patch(`/api/albums/${third.id}`).send({ description: 'Example description' }),
    ]);
    expect(await tracks.getTrack(track.id)).toBeNull();
    expect(await albums.getAlbum(third.id)).toMatchObject({ trackIds: [], description: 'Example description' });
  });

  it('rolls back a failed album PATCH, reports the standard error envelope, and permits retry', async () => {
    const album = await createAlbum();
    const track = await createTrack(album.id);
    events.length = 0;
    failure.writes = ['tracks.json'];
    const response = await request(app).patch(`/api/albums/${album.id}`).send({ trackIds: [] });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('MUSIC_MEMBERSHIP_WRITE_FAILED');
    expect((await albums.getAlbum(album.id)).trackIds).toEqual([track.id]);
    expect((await tracks.getTrack(track.id)).albumId).toBe(album.id);
    expect(events).toEqual([]);
    expect((await request(app).patch(`/api/albums/${album.id}`).send({ trackIds: [] })).status).toBe(200);
    expect((await tracks.getTrack(track.id)).albumId).toBe('');
  });

  it('does not strand a failed album DELETE behind a tombstone', async () => {
    const album = await createAlbum();
    const track = await createTrack(album.id);
    failure.writes = ['tracks.json'];
    expect((await request(app).delete(`/api/albums/${album.id}`)).status).toBe(500);
    expect(await albums.getAlbum(album.id)).not.toBeNull();
    expect((await request(app).delete(`/api/albums/${album.id}`)).status).toBe(200);
    expect(await albums.getAlbum(album.id)).toBeNull();
    expect((await tracks.getTrack(track.id)).albumId).toBe('');
  });

  it('discards failed creates without emitting events or leaving duplicate records on retry', async () => {
    const track = await createTrack();
    events.length = 0;
    subscribe.mockClear();
    failure.writes = ['tracks.json'];
    const input = { title: 'Example retry', trackIds: [track.id] };
    expect((await request(app).post('/api/albums').send(input)).status).toBe(500);
    expect(await albums.listAlbums()).toEqual([]);
    expect(events).toEqual([]);
    expect(subscribe).not.toHaveBeenCalled();
    expect((await request(app).post('/api/albums').send(input)).status).toBe(201);
    expect(await albums.listAlbums()).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('distinguishes missing/deleted tracks from storage failures', async () => {
    const removed = await createTrack();
    await membership.deleteTrackWithAlbum(removed.id);
    const response = await request(app).post('/api/albums').send({ title: 'Example legacy', trackIds: ['track-missing', removed.id] });
    expect(response.status).toBe(201);
    failure.reads = 'tracks.json';
    expect((await request(app).patch(`/api/albums/${response.body.id}`).send({ trackIds: [] })).status).toBe(500);
    failure.reads = null;
    expect((await albums.getAlbum(response.body.id)).trackIds).toEqual(['track-missing', removed.id]);
  });

  it('preserves completed audio for full/missing destinations but propagates arbitrary storage failures', async () => {
    const full = await createAlbum({ trackIds: Array.from({ length: albums.TRACK_IDS_MAX }, (_, i) => `track-example-${i}`) });
    for (const albumId of [full.id, 'album-missing']) {
      const result = await membership.createTrackWithAlbum({ title: 'Example completed', albumId, audioFilename: 'example.wav' }, { preserveUnassigned: true });
      expect(result.track).toMatchObject({ albumId: '', audioFilename: 'example.wav' });
      expect(result.albumAssignmentError.code).toBe(albumId === full.id ? 'ALBUM_FULL' : 'ALBUM_NOT_FOUND');
    }
    failure.reads = 'albums.json';
    await expect(membership.createTrackWithAlbum({ title: 'Example failed', albumId: full.id }, { preserveUnassigned: true })).rejects.toThrow('Synthetic read failure');
    expect(await tracks.listTracks()).toHaveLength(2);
  });

  it('explicitly requires reconciliation when a failed file write cannot be restored', async () => {
    const album = await createAlbum();
    await createTrack(album.id);
    failure.writes = ['tracks.json', 'albums.json'];
    const response = await request(app).delete(`/api/albums/${album.id}`);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('MUSIC_MEMBERSHIP_RECONCILIATION_REQUIRED');
    expect(response.body.error).toContain('before retrying');
  });
});
