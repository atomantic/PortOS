import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { SCORE_500_MILES } from './073-seed-500-miles-score.js';
import { SEED_SONGS } from '../../server/services/songs.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findSong = (path, id) => readJson(path).songs.find((s) => s.id === id);

describe('migration 073 — backfill 500 Miles sheet-music score', () => {
  let rootDir;
  let songsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-073-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('does not drift from the shipped seed score', () => {
    const seed = SEED_SONGS.find((s) => s.id === 'seed-500-miles');
    expect(seed.score).toBe(SCORE_500_MILES);
  });

  it('no-ops when data/songs.json is missing (fresh install seeds it directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(songsPath)).toBe(false);
  });

  it('seeds the score onto a 500 Miles record that lacks one', async () => {
    writeJson(songsPath, {
      songs: [{ id: 'seed-500-miles', title: '500 Miles', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const song = findSong(songsPath, 'seed-500-miles');
    expect(song.score).toBe(SCORE_500_MILES);
    expect(song.updatedAt).not.toBe('2026-01-01T00:00:00.000Z'); // bumped
  });

  it('treats an empty-string score as missing and fills it', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', score: '   ' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(findSong(songsPath, 'seed-500-miles').score).toBe(SCORE_500_MILES);
  });

  it('never clobbers a user-authored score', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', score: '| C4w(mine) |' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-applied' });
    expect(findSong(songsPath, 'seed-500-miles').score).toBe('| C4w(mine) |');
  });

  it('is idempotent across re-runs', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles' }] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('already-applied');
  });

  it('no-ops when 500 Miles is absent (user deleted it)', async () => {
    writeJson(songsPath, { songs: [{ id: 'song-custom', score: '' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'song-absent' });
  });

  it('skips an unparseable songs.json instead of throwing', async () => {
    writeFileSync(songsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });
});
