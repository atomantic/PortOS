import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './076-seed-500-miles-harmony-parts.js';
import { SEED_500_MILES_SCORE_PARTS, SEED_SONGS } from '../../server/services/songs.js';
import { parseScore } from '../../client/src/lib/scoreNotation.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findSong = (path, id) => readJson(path).songs.find((s) => s.id === id);

describe('migration 076 — seed 500 Miles harmony parts', () => {
  let rootDir;
  let songsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-076-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('the seed song carries the five shipped harmony parts (single source)', () => {
    const seed = SEED_SONGS.find((s) => s.id === 'seed-500-miles');
    expect(seed.scoreParts).toBe(SEED_500_MILES_SCORE_PARTS);
    expect(SEED_500_MILES_SCORE_PARTS.map((p) => p.role)).toEqual([
      'bass', 'mid-harmony-2', 'mid-harmony-1', 'high-harmony-2', 'high-harmony-1',
    ]);
  });

  it('every shipped part parses cleanly to eight 4-beat bars', () => {
    for (const part of SEED_500_MILES_SCORE_PARTS) {
      const parsed = parseScore(part.score);
      expect(parsed.errors).toEqual([]);
      expect(parsed.measures).toHaveLength(8);
      for (const m of parsed.measures) expect(m.beats).toBe(4);
    }
    // High Harmony I rests through the opening (sparse, late entrance).
    const highI = SEED_500_MILES_SCORE_PARTS.find((p) => p.role === 'high-harmony-1');
    const parsed = parseScore(highI.score);
    expect(parsed.measures.slice(0, 4).every((m) => m.notes.every((n) => n.rest))).toBe(true);
    // High Harmony II carries the F# leading tone on the D7 bar (bar 6).
    const highII = parseScore(SEED_500_MILES_SCORE_PARTS.find((p) => p.role === 'high-harmony-2').score);
    expect(highII.measures[5].notes.some((n) => n.pitch?.letter === 'F' && n.pitch?.accidental === '#')).toBe(true);
  });

  it('no-ops when data/songs.json is missing (fresh install seeds parts directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(songsPath)).toBe(false);
  });

  it('backfills parts onto a 500 Miles record that has none', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', title: '500 Miles' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const song = findSong(songsPath, 'seed-500-miles');
    expect(song.scoreParts).toHaveLength(5);
    expect(song.scoreParts.map((p) => p.role)).toEqual(SEED_500_MILES_SCORE_PARTS.map((p) => p.role));
  });

  it('treats an empty scoreParts array as missing and fills it', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', scoreParts: [] }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(findSong(songsPath, 'seed-500-miles').scoreParts).toHaveLength(5);
  });

  it('never clobbers existing user/AI-derived parts', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', scoreParts: [{ id: 'mine', label: 'Mine', role: 'bass', score: '| G2w |' }] }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-applied' });
    expect(findSong(songsPath, 'seed-500-miles').scoreParts).toEqual([{ id: 'mine', label: 'Mine', role: 'bass', score: '| G2w |' }]);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles' }] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('already-applied');
  });

  it('no-ops when 500 Miles is absent (user deleted it)', async () => {
    writeJson(songsPath, { songs: [{ id: 'song-custom' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'song-absent' });
  });

  it('skips an unparseable songs.json instead of throwing', async () => {
    writeFileSync(songsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });
});
