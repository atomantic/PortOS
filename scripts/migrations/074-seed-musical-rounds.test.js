import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { ROUND_IDS, ROUND_SEEDS } from './074-seed-musical-rounds.js';
import { SEED_ROUNDS, sanitizeRound } from '../../server/services/rounds.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const ids = (path) => readJson(path).songs.map((s) => s.id);

describe('migration 074 — backfill the four built-in rounds', () => {
  let rootDir;
  let songsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-074-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('does not drift from the shipped seed rounds', () => {
    // ROUND_SEEDS is derived from SEED_ROUNDS, so this guards the id list and the
    // sanitized shape: every round id must resolve to a shipped seed.
    expect(ROUND_SEEDS).toHaveLength(ROUND_IDS.length);
    for (const id of ROUND_IDS) {
      const seed = SEED_ROUNDS.find((s) => s.id === id);
      expect(seed, `SEED_ROUNDS missing ${id}`).toBeTruthy();
      const round = ROUND_SEEDS.find((s) => s.id === id);
      expect(round).toEqual(sanitizeRound(seed));
    }
  });

  it('no-ops when data/songs.json is missing (fresh install seeds it directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(songsPath)).toBe(false);
  });

  it('prepends all four rounds onto an install that lacks them', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles', title: '500 Miles' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(4);
    expect(ids(songsPath)).toEqual([...ROUND_IDS, 'seed-500-miles']);
    // The persisted record carries the full shipped content (melody + lyrics).
    const heyHo = readJson(songsPath).songs.find((s) => s.id === 'seed-hey-ho-nobody-home');
    expect(heyHo.title).toBe('Hey Ho Nobody Home');
    expect(heyHo.score).toContain('Hey');
    expect(heyHo.partnerRoundIds).toContain('seed-ah-poor-bird');
  });

  it('only adds the rounds that are missing', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-ah-poor-bird', title: 'mine' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(3);
    // The user's existing ah-poor-bird record is untouched (not clobbered).
    const ahPoorBird = readJson(songsPath).songs.find((s) => s.id === 'seed-ah-poor-bird');
    expect(ahPoorBird.title).toBe('mine');
    expect(ids(songsPath)).not.toContain(undefined);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(songsPath, { songs: [{ id: 'seed-500-miles' }] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second).toEqual({ updated: 0, reason: 'already-present' });
  });

  it('skips an unparseable songs.json instead of throwing', async () => {
    writeFileSync(songsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });

  it('skips an unexpected shape (no songs array)', async () => {
    writeJson(songsPath, { notSongs: true });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unexpected-shape' });
  });
});
