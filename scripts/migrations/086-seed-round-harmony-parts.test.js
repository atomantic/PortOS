import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './086-seed-round-harmony-parts.js';
import { SEED_ROUND_SCORE_PARTS, SEED_ROUNDS } from '../../server/services/rounds.js';
import { parseScore } from '../../client/src/lib/scoreNotation.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findSong = (path, id) => readJson(path).songs.find((s) => s.id === id);
const ROUND_IDS = Object.keys(SEED_ROUND_SCORE_PARTS);

describe('migration 086 — seed round harmony (canon voice) parts', () => {
  let rootDir;
  let songsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-086-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('every round seed carries its shipped canon voice parts (single source)', () => {
    for (const id of ROUND_IDS) {
      const seed = SEED_ROUNDS.find((s) => s.id === id);
      expect(seed.scoreParts).toBe(SEED_ROUND_SCORE_PARTS[id]);
      expect(seed.scoreParts.length).toBeGreaterThan(0);
    }
  });

  it('each canon voice is the melody delayed by whole-bar rests and parses cleanly', () => {
    for (const id of ROUND_IDS) {
      const song = SEED_ROUNDS.find((s) => s.id === id);
      const melodyBars = parseScore(song.score).measures.length;
      song.scoreParts.forEach((part, i) => {
        const parsed = parseScore(part.score);
        expect(parsed.errors).toEqual([]);
        for (const m of parsed.measures) expect(m.beats).toBe(4);
        // A canon voice = N leading whole-rest bars + the full melody. Each voice
        // enters later than the previous, so its bar count strictly increases.
        const leadingRestBars = parsed.measures.findIndex((m) => m.notes.some((n) => !n.rest));
        expect(leadingRestBars).toBeGreaterThan(0);
        expect(parsed.measures.length).toBe(melodyBars + leadingRestBars);
        if (i > 0) {
          const prev = parseScore(song.scoreParts[i - 1].score).measures.length;
          expect(parsed.measures.length).toBeGreaterThan(prev);
        }
      });
    }
  });

  it('no-ops when data/songs.json is missing (fresh install seeds parts directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(songsPath)).toBe(false);
  });

  it('backfills parts onto every round that has none', async () => {
    writeJson(songsPath, { songs: ROUND_IDS.map((id) => ({ id, title: id })) });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(ROUND_IDS.length);
    for (const id of ROUND_IDS) {
      expect(findSong(songsPath, id).scoreParts).toHaveLength(SEED_ROUND_SCORE_PARTS[id].length);
    }
  });

  it('treats an empty scoreParts array as missing and fills it', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-ah-poor-bird', scoreParts: [] }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(findSong(songsPath, 'seed-ah-poor-bird').scoreParts.length)
      .toBe(SEED_ROUND_SCORE_PARTS['seed-ah-poor-bird'].length);
  });

  it('never clobbers a round that already has user/AI-derived parts', async () => {
    const mine = [{ id: 'mine', label: 'Mine', role: 'voice-2', score: '| D4w |' }];
    writeJson(songsPath, {
      songs: [
        { id: 'seed-hey-ho-nobody-home', scoreParts: mine },
        { id: 'seed-ah-poor-bird' },
      ],
    });
    const result = await migration.up({ rootDir });
    // Only Ah Poor Bird (no parts) is filled; Hey Ho's custom parts are untouched.
    expect(result.updated).toBe(1);
    expect(findSong(songsPath, 'seed-hey-ho-nobody-home').scoreParts).toEqual(mine);
    expect(findSong(songsPath, 'seed-ah-poor-bird').scoreParts.length).toBeGreaterThan(0);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(songsPath, { songs: ROUND_IDS.map((id) => ({ id })) });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('already-applied');
  });

  it('no-ops when no rounds are present (user deleted them)', async () => {
    writeJson(songsPath, { songs: [{ id: 'song-custom' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('skips an unparseable songs.json instead of throwing', async () => {
    writeFileSync(songsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });
});
