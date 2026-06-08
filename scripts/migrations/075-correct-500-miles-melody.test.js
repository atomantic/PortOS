import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './075-correct-500-miles-melody.js';
import { SCORE_500_MILES as NEW_SCORE } from './073-seed-500-miles-score.js';
import { SEED_SONGS } from '../../server/services/songs.js';

// The OLD C-major placeholder the migration upgrades FROM (kept in lockstep with
// the constant inside the migration; this is the version we detect and replace).
const OLD_SCORE = [
  'clef: treble',
  'key: C',
  'time: 4/4',
  'tempo: 68',
  '',
  '| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I\'m) E4q(on) |',
  '| [F] F4q(You) A4q(will) A4q(know) A4q(that) | [C] G4h(I) E4q(am) C4q(gone) |',
  '| [F] F4q(You) A4q(can) A4q(hear) A4q(the) | [C] G4q(whis-) E4q(tle) C4h(blow) |',
  '| [G] D4q(A) F4q(hun-) G4q(dred) rq | [C] C4w(miles) |',
].join('\n');

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findSong = (path, id) => readJson(path).songs.find((s) => s.id === id);

describe('migration 075 — correct 500 Miles melody to G major', () => {
  let rootDir;
  let songsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-075-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('the corrected score equals the shipped seed (no drift)', () => {
    const seed = SEED_SONGS.find((s) => s.id === 'seed-500-miles');
    expect(seed.score).toBe(NEW_SCORE);
    expect(seed.key).toBe('G major');
  });

  it('no-ops when data/songs.json is missing (fresh install seeds the correct melody)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(songsPath)).toBe(false);
  });

  it('upgrades a record holding the old C-major placeholder', async () => {
    writeJson(songsPath, {
      songs: [{ id: 'seed-500-miles', key: 'C major', score: OLD_SCORE, updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const song = findSong(songsPath, 'seed-500-miles');
    expect(song.score).toBe(NEW_SCORE);
    expect(song.key).toBe('G major');
    expect(song.updatedAt).not.toBe('2026-01-01T00:00:00.000Z'); // bumped
  });

  it('matches the old score across CRLF line endings', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', score: OLD_SCORE.replace(/\n/g, '\r\n') }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(findSong(songsPath, 'seed-500-miles').score).toBe(NEW_SCORE);
  });

  it('never clobbers a user-authored score', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', score: '| C4w(mine) |' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'not-old-score' });
    expect(findSong(songsPath, 'seed-500-miles').score).toBe('| C4w(mine) |');
  });

  it('is idempotent — re-running over the corrected score is a no-op', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', key: 'G major', score: NEW_SCORE }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'not-old-score' });
  });

  it('no-ops when 500 Miles is absent (user deleted it)', async () => {
    writeJson(songsPath, { songs: [{ id: 'song-custom', score: OLD_SCORE }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'song-absent' });
  });

  it('skips an unparseable songs.json instead of throwing', async () => {
    writeFileSync(songsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });
});
