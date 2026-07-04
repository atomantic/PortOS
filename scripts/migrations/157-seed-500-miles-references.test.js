import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './157-seed-500-miles-references.js';
import { SEED_500_MILES_REFERENCES, SEED_ROUNDS } from '../../server/services/rounds.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findRound = (path, id) => readJson(path).rounds.find((r) => r.id === id);

describe('migration 157 — seed 500 Miles reference videos', () => {
  let rootDir;
  let roundsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-157-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    roundsPath = join(rootDir, 'data', 'rounds.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('the seed round carries the shipped references (single source, no drift)', () => {
    const seed = SEED_ROUNDS.find((r) => r.id === 'seed-500-miles');
    expect(seed.references).toBe(SEED_500_MILES_REFERENCES);
    expect(SEED_500_MILES_REFERENCES).toHaveLength(3);
    expect(SEED_500_MILES_REFERENCES.every((r) => r.url.startsWith('https://www.tiktok.com/'))).toBe(true);
  });

  it('no-ops when data/rounds.json is missing (fresh install seeds references directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(roundsPath)).toBe(false);
  });

  it('backfills references onto a 500 Miles record that has none', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'seed-500-miles', title: '500 Miles' }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const round = findRound(roundsPath, 'seed-500-miles');
    expect(round.references).toHaveLength(3);
    expect(round.references.map((r) => r.id)).toEqual(SEED_500_MILES_REFERENCES.map((r) => r.id));
  });

  it('treats an empty references array as missing and fills it', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'seed-500-miles', references: [] }] });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(findRound(roundsPath, 'seed-500-miles').references).toHaveLength(3);
  });

  it('never clobbers an existing user reference list', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'seed-500-miles', references: [{ id: 'mine', url: 'https://example.com/mine', label: 'Mine', note: '' }] }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-applied' });
    expect(findRound(roundsPath, 'seed-500-miles').references).toEqual([{ id: 'mine', url: 'https://example.com/mine', label: 'Mine', note: '' }]);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'seed-500-miles' }] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('already-applied');
  });

  it('no-ops when 500 Miles is absent (user deleted it)', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'round-custom' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'round-absent' });
  });

  it('skips an unparseable rounds.json instead of throwing', async () => {
    writeFileSync(roundsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });
});
