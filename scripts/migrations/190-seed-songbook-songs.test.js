import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './190-seed-songbook-songs.js';

let rootDir;
let liveDir;
let seedDir;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-190-'));
  liveDir = join(rootDir, 'data', 'brain');
  seedDir = join(rootDir, 'data.reference', 'brain');
  mkdirSync(seedDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// Invented seed fixture (privacy convention) — mirrors the shipped shape:
// records keyed by stable id, no originInstanceId (boot backfill stamps it).
const SEEDS = {
  records: {
    'song-seed-alpha': { title: 'Example Song A', artist: 'Traditional', attachments: [], createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' },
    'song-seed-beta': { title: 'Example Song B', artist: 'Traditional', attachments: [], createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' },
  },
};

const writeSeed = (obj = SEEDS) => writeFileSync(join(seedDir, 'songs.json'), JSON.stringify(obj, null, 2));
const writeLive = (obj) => {
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, 'songs.json'), JSON.stringify(obj, null, 2));
};
const readLive = () => JSON.parse(readFileSync(join(liveDir, 'songs.json'), 'utf-8'));

describe('migration 190 — seed songbook songs', () => {
  it('adds every seed to an existing empty store (the setup-data gap)', async () => {
    writeSeed();
    writeLive({ records: {} });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'seeded', added: 2 });
    expect(Object.keys(readLive().records).sort()).toEqual(['song-seed-alpha', 'song-seed-beta']);
  });

  it('creates the live store (with parent dirs) when missing', async () => {
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result.added).toBe(2);
    expect(readLive().records['song-seed-alpha'].title).toBe('Example Song A');
  });

  it('never overwrites an existing id — user-edited and tombstoned copies survive', async () => {
    writeSeed();
    writeLive({
      records: {
        'song-seed-alpha': { title: 'My Customized Copy', updatedAt: '2026-08-01T00:00:00.000Z' },
        'song-seed-beta': { _deleted: true, updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: '2026-08-01T00:00:00.000Z', originInstanceId: 'x' },
        'user-song-1': { title: 'User Song' },
      },
    });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    const live = readLive();
    expect(live.records['song-seed-alpha'].title).toBe('My Customized Copy');
    expect(live.records['song-seed-beta']._deleted).toBe(true); // deleted seed stays deleted
    expect(live.records['user-song-1'].title).toBe('User Song');
  });

  it('is idempotent — a second run adds nothing', async () => {
    writeSeed();
    writeLive({ records: {} });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('already-present');
    expect(Object.keys(readLive().records)).toHaveLength(2);
  });

  it('adds only the missing seeds when some are already present', async () => {
    writeSeed();
    writeLive({ records: { 'song-seed-alpha': { title: 'Kept' } } });
    const result = await migration.up({ rootDir });
    expect(result.added).toBe(1);
    const live = readLive();
    expect(live.records['song-seed-alpha'].title).toBe('Kept');
    expect(live.records['song-seed-beta'].title).toBe('Example Song B');
  });

  it('no-ops when the seed file is missing or empty', async () => {
    const missing = await migration.up({ rootDir });
    expect(missing).toMatchObject({ ok: true, reason: 'no-seeds' });
    expect(existsSync(join(liveDir, 'songs.json'))).toBe(false);

    writeSeed({ records: {} });
    const empty = await migration.up({ rootDir });
    expect(empty.reason).toBe('no-seeds');
  });

  it('treats an unreadable live file as an empty store', async () => {
    writeSeed();
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'songs.json'), '{not json');
    const result = await migration.up({ rootDir });
    expect(result.added).toBe(2);
    expect(Object.keys(readLive().records)).toHaveLength(2);
  });

  it('seeds the SHIPPED reference records against a real repo layout shape', async () => {
    // Sanity-pin the shipped seed file: three instrument variants of the same
    // public-domain song, no originInstanceId, stable ids.
    const shipped = JSON.parse(readFileSync(new URL('../../data.reference/brain/songs.json', import.meta.url), 'utf-8'));
    const ids = Object.keys(shipped.records);
    expect(ids.sort()).toEqual(['song-seed-hotrs-guitar', 'song-seed-hotrs-piano', 'song-seed-hotrs-ukulele']);
    for (const id of ids) {
      const rec = shipped.records[id];
      expect(rec.title).toBe('House of the Rising Sun');
      expect(rec.artist).toBe('Traditional');
      expect(rec.originInstanceId).toBeUndefined(); // boot backfill stamps it
      expect(rec.attachments).toEqual([]);
      expect(rec.content.format).toBe('tab');
      expect(rec.content.text).toContain('There is a house in New Orleans');
      expect(rec.createdAt).toBe('2026-07-15T00:00:00.000Z');
    }
    expect(new Set(ids.map((id) => shipped.records[id].instrument))).toEqual(new Set(['guitar', 'piano', 'ukulele']));
  });
});
