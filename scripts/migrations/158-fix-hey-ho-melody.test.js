import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, {
  OLD_HEY_HO_SCORE,
  OLD_HEY_HO_NOTATION,
  NEW_HEY_HO_SCORE,
  NEW_HEY_HO_SCORE_PARTS,
  NEW_HEY_HO_NOTATION,
} from './158-fix-hey-ho-melody.js';
import { SEED_ROUNDS } from '../../server/services/rounds.js';

const ROUND_ID = 'seed-hey-ho-nobody-home';
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findRound = (path, id) => readJson(path).rounds.find((r) => r.id === id);

describe('migration 158 — fix Hey Ho Nobody Home melody', () => {
  let rootDir;
  let roundsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-158-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    roundsPath = join(rootDir, 'data', 'rounds.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Drift guard (b): the migration's NEW constants ARE the current seed (identity,
  // not copies) — so the migration can never restore a stale melody.
  it('new constants are the current seed (single source, no drift)', () => {
    const seed = SEED_ROUNDS.find((r) => r.id === ROUND_ID);
    expect(NEW_HEY_HO_SCORE).toBe(seed.score);
    expect(NEW_HEY_HO_SCORE_PARTS).toBe(seed.scoreParts);
    expect(NEW_HEY_HO_NOTATION).toBe(seed.notation);
  });

  // Drift guard (a): the frozen OLD constants are the pre-#2105 shipped strings —
  // recognizably the wrong transcription, and DIFFERENT from the corrected seed.
  it('old constants are the frozen pre-fix shipped strings, distinct from the new seed', () => {
    expect(OLD_HEY_HO_SCORE).not.toBe(NEW_HEY_HO_SCORE);
    // The old melody was G-centered with a B-natural major third.
    expect(OLD_HEY_HO_SCORE).toContain('G4h(Hey)');
    expect(OLD_HEY_HO_SCORE).toContain('B4e(mon-)');
    // The corrected melody is D-centered with all naturals and no B.
    expect(NEW_HEY_HO_SCORE).toContain('D4h(Hey)');
    expect(NEW_HEY_HO_SCORE).not.toContain('B4');
    expect(OLD_HEY_HO_NOTATION).not.toBe(NEW_HEY_HO_NOTATION);
    expect(OLD_HEY_HO_NOTATION).toContain('B natural');
    expect(NEW_HEY_HO_NOTATION).not.toContain('B natural');
  });

  it('no-ops when data/rounds.json is missing (fresh install seeds the fix directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(roundsPath)).toBe(false);
  });

  it('replaces score + scoreParts + notation on an untouched old record', async () => {
    writeJson(roundsPath, {
      rounds: [{ id: ROUND_ID, title: 'Hey Ho Nobody Home', score: OLD_HEY_HO_SCORE, scoreParts: [{ id: 'stale' }], notation: OLD_HEY_HO_NOTATION }],
    });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 1, fixedScore: true, fixedNotation: true });
    const round = findRound(roundsPath, ROUND_ID);
    expect(round.score).toBe(NEW_HEY_HO_SCORE);
    expect(round.scoreParts).toEqual(NEW_HEY_HO_SCORE_PARTS);
    expect(round.notation).toBe(NEW_HEY_HO_NOTATION);
  });

  it('deep-clones the scoreParts (persisted record does not share identity with the seed)', async () => {
    writeJson(roundsPath, { rounds: [{ id: ROUND_ID, score: OLD_HEY_HO_SCORE }] });
    await migration.up({ rootDir });
    const round = findRound(roundsPath, ROUND_ID);
    // Value-equal but written to disk and re-read — proves it serialized cleanly.
    expect(round.scoreParts).toEqual(NEW_HEY_HO_SCORE_PARTS);
  });

  it('corrects notation on a record whose score was customized (score left alone)', async () => {
    const custom = 'clef: treble\nkey: C\ntime: 4/4\n\n| C4w(my) |';
    writeJson(roundsPath, { rounds: [{ id: ROUND_ID, score: custom, notation: OLD_HEY_HO_NOTATION }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 1, fixedScore: false, fixedNotation: true });
    const round = findRound(roundsPath, ROUND_ID);
    expect(round.score).toBe(custom);
    expect(round.notation).toBe(NEW_HEY_HO_NOTATION);
  });

  it('never clobbers a customized score with stock-but-already-fixed notation', async () => {
    const custom = 'clef: treble\nkey: C\ntime: 4/4\n\n| C4w(my) |';
    writeJson(roundsPath, { rounds: [{ id: ROUND_ID, score: custom, notation: NEW_HEY_HO_NOTATION }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'already-applied' });
    expect(findRound(roundsPath, ROUND_ID).score).toBe(custom);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(roundsPath, { rounds: [{ id: ROUND_ID, score: OLD_HEY_HO_SCORE, notation: OLD_HEY_HO_NOTATION }] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second).toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('no-ops when Hey Ho is absent (user deleted it)', async () => {
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
