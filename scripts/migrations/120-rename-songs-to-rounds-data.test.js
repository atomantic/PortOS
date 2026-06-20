import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './120-rename-songs-to-rounds-data.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 120 — rename songs.json → rounds.json', () => {
  let rootDir;
  let songsPath;
  let roundsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-120-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    songsPath = join(rootDir, 'data', 'songs.json');
    roundsPath = join(rootDir, 'data', 'rounds.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('renames the file, the top-level key, and the partnerSongIds field', async () => {
    writeJson(songsPath, {
      songs: [
        { id: 'seed-hey-ho', title: 'Hey Ho', partnerSongIds: ['seed-ah-poor-bird'] },
        { id: 'round-custom', title: 'Mine', partnerSongIds: [] },
      ],
    });
    await migration.up({ rootDir });

    expect(existsSync(songsPath)).toBe(false);
    expect(existsSync(roundsPath)).toBe(true);
    const doc = readJson(roundsPath);
    expect(Array.isArray(doc.rounds)).toBe(true);
    expect(doc).not.toHaveProperty('songs');
    expect(doc.rounds[0].partnerRoundIds).toEqual(['seed-ah-poor-bird']);
    expect(doc.rounds[0]).not.toHaveProperty('partnerSongIds');
    expect(doc.rounds[1].partnerRoundIds).toEqual([]);
  });

  it('no-ops when neither songs.json nor rounds.json exists (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(songsPath)).toBe(false);
    expect(existsSync(roundsPath)).toBe(false);
  });

  it('is idempotent — a second run after migrating changes nothing', async () => {
    writeJson(songsPath, { songs: [{ id: 'r1', partnerSongIds: ['r2'] }] });
    await migration.up({ rootDir });
    const afterFirst = readFileSync(roundsPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(roundsPath, 'utf-8')).toBe(afterFirst);
    expect(existsSync(songsPath)).toBe(false);
  });

  it('leaves files alone when BOTH songs.json and rounds.json exist (resolve manually), but still normalizes rounds.json', async () => {
    writeJson(songsPath, { songs: [{ id: 'legacy' }] });
    writeJson(roundsPath, { songs: [{ id: 'r1', partnerSongIds: ['r2'] }] });
    await migration.up({ rootDir });

    // The rename is skipped (both present), so songs.json is untouched…
    expect(existsSync(songsPath)).toBe(true);
    // …but rounds.json still gets the top-level key + field normalization.
    const doc = readJson(roundsPath);
    expect(Array.isArray(doc.rounds)).toBe(true);
    expect(doc.rounds[0].partnerRoundIds).toEqual(['r2']);
  });

  it('does not touch an already-migrated rounds.json (rounds key present)', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'r1', partnerRoundIds: ['r2'] }] });
    const before = readFileSync(roundsPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(roundsPath, 'utf-8')).toBe(before);
  });
});
