import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'creative-catalog-writeback-'));
const fault = vi.hoisted(() => ({ path: null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => String(args[0]) === fault.path
      ? Promise.reject(Object.assign(new Error('injected read denial'), { code: 'EACCES' }))
      : actual.readFile(...args),
  };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const albums = await import('./albums/file.js');
const artists = await import('./artists/file.js');
const authors = await import('./authors/file.js');
const tracks = await import('./tracks/file.js');
const timeline = await import('./videoTimeline/local.js');
const { writersRoomStore, _resetWritersRoomStore } = await import('./writersRoom/store.js');
const { PATHS } = await import('../lib/fileUtils.js');

const timestamp = '2026-01-01T00:00:00.000Z';
const writersRoomRoot = join(PATHS.data, 'writers-room');

const stores = [
  {
    name: 'album catalog',
    path: join(PATHS.data, 'albums.json'),
    seed: [{
      id: 'album-existing', title: 'Existing album', artistId: '', artist: '', description: '', genre: '',
      releaseYear: null, coverImageUrl: '', trackIds: [], createdAt: timestamp, updatedAt: timestamp,
      deleted: false, deletedAt: null,
    }],
    mutate: () => albums.createAlbum({ title: 'New album' }),
    preserved: data => data.some(record => record.id === 'album-existing' && record.title === 'Existing album'),
    initialized: data => data.some(record => record.title === 'New album'),
  },
  {
    name: 'artist catalog',
    path: join(PATHS.data, 'artists.json'),
    seed: [{
      id: 'artist-existing', name: 'Existing artist', genre: '', bio: '', musicalStyle: '',
      physicalDescription: '', portraitStyle: '', portraitImageUrl: '', createdAt: timestamp,
      updatedAt: timestamp, deleted: false, deletedAt: null,
    }],
    mutate: () => artists.createArtist({ name: 'New artist' }),
    preserved: data => data.some(record => record.id === 'artist-existing' && record.name === 'Existing artist'),
    initialized: data => data.some(record => record.name === 'New artist'),
  },
  {
    name: 'author catalog',
    path: join(PATHS.data, 'authors.json'),
    seed: [{
      id: 'auth-existing', name: 'Existing author', writingStyle: '', bio: '', physicalDescription: '',
      headshotStyle: '', headshotImageUrl: '', createdAt: timestamp, updatedAt: timestamp,
      deleted: false, deletedAt: null,
    }],
    mutate: () => authors.createAuthor({ name: 'New author' }),
    preserved: data => data.some(record => record.id === 'auth-existing' && record.name === 'Existing author'),
    initialized: data => data.some(record => record.name === 'New author'),
  },
  {
    name: 'track catalog',
    path: join(PATHS.data, 'tracks.json'),
    seed: [{
      id: 'track-existing', title: 'Existing track', albumId: '', artistId: '', artist: '', concept: '',
      lyrics: '', prompt: '', engine: '', modelId: '', durationSec: null, audioFilename: '',
      chiptuneScore: null, chiptunePrompt: '', createdAt: timestamp, updatedAt: timestamp,
      deleted: false, deletedAt: null,
    }],
    mutate: () => tracks.createTrack({ title: 'New track' }),
    preserved: data => data.some(record => record.id === 'track-existing' && record.title === 'Existing track'),
    initialized: data => data.some(record => record.title === 'New track'),
  },
  {
    name: 'video timeline projects',
    path: join(PATHS.data, 'video-projects.json'),
    seed: [{
      id: 'project-existing', name: 'Existing timeline', createdAt: timestamp, updatedAt: timestamp,
      schemaVersion: 2, segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [],
    }],
    mutate: () => timeline.createProject('New timeline'),
    preserved: data => data.some(record => record.id === 'project-existing' && record.name === 'Existing timeline'),
    initialized: data => data.some(record => record.name === 'New timeline'),
  },
  {
    name: 'Writers Room folders',
    path: join(writersRoomRoot, 'folders.json'),
    seed: [{
      id: 'wr-folder-existing', name: 'Existing folder', parentId: null, sortOrder: 0,
      createdAt: timestamp, updatedAt: timestamp,
    }],
    mutate: () => writersRoomStore().writeFolder({
      id: 'wr-folder-new', name: 'New folder', parentId: null, sortOrder: 1,
      createdAt: timestamp, updatedAt: timestamp,
    }),
    preserved: data => data.some(record => record.id === 'wr-folder-existing' && record.name === 'Existing folder'),
    initialized: data => data.some(record => record.id === 'wr-folder-new'),
  },
  {
    name: 'Writers Room exercises',
    path: join(writersRoomRoot, 'exercises.json'),
    seed: [{
      id: 'wr-ex-existing', workId: 'wr-work-existing', status: 'finished',
      startedAt: timestamp, finishedAt: timestamp,
    }],
    mutate: () => writersRoomStore().writeExercise({
      id: 'wr-ex-new', workId: 'wr-work-new', status: 'running', startedAt: timestamp,
    }),
    preserved: data => data.some(record => record.id === 'wr-ex-existing' && record.status === 'finished'),
    initialized: data => data.some(record => record.id === 'wr-ex-new'),
  },
];

beforeEach(() => {
  fault.path = null;
  _resetWritersRoomStore();
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// These service/store boundaries uniquely prove that each owned path refuses to
// persist its fallback. Real temporary files pin the bytes; only the read fault is injected.
describe.each(stores)('$name durable write-back', store => {
  it.each(['{"truncated":', '', '{"records":{}}'])(
    'preserves unreadable bytes (%j) and can retry after repair',
    async (bytes) => {
      mkdirSync(dirname(store.path), { recursive: true });
      writeFileSync(store.path, bytes);

      await expect(store.mutate()).rejects.toMatchObject({ code: 'UNREADABLE_STORE', status: 500 });
      expect(readFileSync(store.path, 'utf8')).toBe(bytes);

      writeFileSync(store.path, JSON.stringify(store.seed));
      await store.mutate();
      const saved = JSON.parse(readFileSync(store.path, 'utf8'));
      expect(store.preserved(saved)).toBe(true);
    },
  );

  it('preserves existing bytes on an injected filesystem read failure', async () => {
    mkdirSync(dirname(store.path), { recursive: true });
    const bytes = JSON.stringify(store.seed);
    writeFileSync(store.path, bytes);
    fault.path = store.path;

    await expect(store.mutate()).rejects.toMatchObject({ code: 'UNREADABLE_STORE', status: 500 });
    expect(readFileSync(store.path, 'utf8')).toBe(bytes);
  });

  it('initializes an absent file through the mutation boundary', async () => {
    await store.mutate();
    expect(store.initialized(JSON.parse(readFileSync(store.path, 'utf8')))).toBe(true);
  });
});
