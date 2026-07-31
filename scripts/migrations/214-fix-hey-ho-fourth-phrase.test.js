import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, {
  OLD_HEY_HO_SCORE_6BAR,
  OLD_HEY_HO_LYRICS,
  OLD_HEY_HO_NOTATION,
  OLD_HEY_HO_VOICE_3_NOTES,
  OLD_HEY_HO_VOICE_4_NOTES,
  NEW_HEY_HO_SCORE,
  NEW_HEY_HO_SCORE_PARTS,
  NEW_HEY_HO_LYRICS,
  NEW_HEY_HO_NOTATION,
  NEW_HEY_HO_VOICE_3_NOTES,
  NEW_HEY_HO_VOICE_4_NOTES,
} from './214-fix-hey-ho-fourth-phrase.js';
import { OLD_HEY_HO_SCORE as PRE_2105_SCORE } from './158-fix-hey-ho-melody.js';
import { SEED_ROUNDS } from '../../server/services/rounds.js';

const ROUND_ID = 'seed-hey-ho-nobody-home';
const SECTION_ID = 'sec-round';
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const findRound = (path, id) => readJson(path).rounds.find((r) => r.id === id);
const findLyrics = (path) => findRound(path, ROUND_ID).sections.find((s) => s.id === SECTION_ID).lyrics;
const findLayer = (path, id) => findRound(path, ROUND_ID).layers.find((l) => l.id === id);

// A stored record in the exact pre-#3238 shipped shape.
const oldRecord = () => ({
  id: ROUND_ID,
  score: OLD_HEY_HO_SCORE_6BAR,
  scoreParts: [{ id: 'part-heyho-v2' }, { id: 'part-heyho-v3' }],
  notation: OLD_HEY_HO_NOTATION,
  sections: [{ id: SECTION_ID, label: 'Round', lyrics: OLD_HEY_HO_LYRICS }],
  layers: [
    { id: 'voice-1', notes: 'Starts the round and sings it straight through. Everyone learns this line first.' },
    { id: 'voice-2', notes: 'Enters as Voice 1 reaches "Meat nor drink…" (phrase 2) — one full phrase behind the lead.' },
    { id: 'voice-3', notes: OLD_HEY_HO_VOICE_3_NOTES },
    { id: 'voice-4', notes: OLD_HEY_HO_VOICE_4_NOTES },
  ],
});

describe('migration 214 — Hey Ho Nobody Home fourth phrase + lyric', () => {
  let rootDir;
  let roundsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-214-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    roundsPath = join(rootDir, 'data', 'rounds.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Drift guard (a): the migration's NEW constants ARE the current seed (identity,
  // not copies) — so the migration can never restore a stale melody or lyric.
  it('new constants are the current seed (single source, no drift)', () => {
    const seed = SEED_ROUNDS.find((r) => r.id === ROUND_ID);
    expect(NEW_HEY_HO_SCORE).toBe(seed.score);
    expect(NEW_HEY_HO_SCORE_PARTS).toBe(seed.scoreParts);
    expect(NEW_HEY_HO_NOTATION).toBe(seed.notation);
    expect(NEW_HEY_HO_LYRICS).toBe(seed.sections.find((s) => s.id === SECTION_ID).lyrics);
    // Pin the content, not just the identity: a renamed section id would make
    // BOTH sides of the comparison above `undefined` and pass vacuously, and the
    // migration would then write `undefined` over a user's lyrics.
    expect(typeof NEW_HEY_HO_LYRICS).toBe('string');
    expect(NEW_HEY_HO_LYRICS).toContain('Hey, hey, ho.');
    // Same vacuous-pass hazard for the layer notes, which are looked up by id.
    expect(NEW_HEY_HO_VOICE_3_NOTES).toBe(seed.layers.find((l) => l.id === 'voice-3').notes);
    expect(NEW_HEY_HO_VOICE_4_NOTES).toBe(seed.layers.find((l) => l.id === 'voice-4').notes);
    expect(NEW_HEY_HO_VOICE_3_NOTES).not.toMatch(/three phrases/i);
    expect(NEW_HEY_HO_VOICE_4_NOTES).not.toMatch(/unison/i);
    // And the frozen old strings must be the pre-fix text, not the new text.
    expect(OLD_HEY_HO_VOICE_3_NOTES).toMatch(/three phrases/i);
    expect(OLD_HEY_HO_VOICE_4_NOTES).toMatch(/unison/i);
  });

  // Drift guard (b): the frozen OLD constants are the post-158 / pre-3238 shipped
  // strings — the correct pitches but only three phrases, and the repeated line 4.
  it('old constants are the frozen pre-fix shipped strings, distinct from the new seed', () => {
    expect(OLD_HEY_HO_SCORE_6BAR).not.toBe(NEW_HEY_HO_SCORE);
    // It is the POST-158 melody (D-centered, no B) — not the pre-#2105 one.
    expect(OLD_HEY_HO_SCORE_6BAR).toContain('D4h(Hey)');
    expect(OLD_HEY_HO_SCORE_6BAR).not.toContain('B4');
    expect(OLD_HEY_HO_SCORE_6BAR).not.toBe(PRE_2105_SCORE);
    // Three phrases in, four out — the new melody adds the closing line.
    expect(OLD_HEY_HO_SCORE_6BAR.split('\n').filter((l) => l.includes('|')).length).toBe(3);
    expect(NEW_HEY_HO_SCORE.split('\n').filter((l) => l.includes('|')).length).toBe(4);
    expect(NEW_HEY_HO_SCORE).toContain('D4h(ho)');
    // The lyric fix: line 4 stops repeating line 1.
    expect(OLD_HEY_HO_LYRICS.split('\n')[3]).toBe('Hey, ho, nobody home.');
    expect(NEW_HEY_HO_LYRICS.split('\n')[3]).toBe('Hey, hey, ho.');
    // The first three lines are untouched by the fix.
    expect(NEW_HEY_HO_LYRICS.split('\n').slice(0, 3)).toEqual(OLD_HEY_HO_LYRICS.split('\n').slice(0, 3));
    expect(OLD_HEY_HO_NOTATION).not.toBe(NEW_HEY_HO_NOTATION);
  });

  it('no-ops when data/rounds.json is missing (fresh install seeds the fix directly)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(roundsPath)).toBe(false);
  });

  it('skips an unparseable rounds file without throwing', async () => {
    writeFileSync(roundsPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'unreadable' });
  });

  it('no-ops when the built-in round is absent', async () => {
    writeJson(roundsPath, { rounds: [{ id: 'seed-500-miles' }] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'round-absent' });
  });

  it('extends the melody, canon voices, lyric and notation on an untouched install', async () => {
    writeJson(roundsPath, { rounds: [oldRecord()] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedScore: true, fixedLyrics: true, fixedNotation: true });

    const round = findRound(roundsPath, ROUND_ID);
    expect(round.score).toBe(NEW_HEY_HO_SCORE);
    expect(round.scoreParts).toEqual(NEW_HEY_HO_SCORE_PARTS);
    expect(round.notation).toBe(NEW_HEY_HO_NOTATION);
    expect(findLyrics(roundsPath)).toBe(NEW_HEY_HO_LYRICS);
    expect(round.updatedAt).toBeTruthy();
  });

  it('persists the fourth canon voice', async () => {
    writeJson(roundsPath, { rounds: [oldRecord()] });
    await migration.up({ rootDir });
    const round = findRound(roundsPath, ROUND_ID);
    expect(round.scoreParts).toHaveLength(3);
    expect(round.scoreParts.map((p) => p.id)).toEqual(['part-heyho-v2', 'part-heyho-v3', 'part-heyho-v4']);
  });

  // The write deep-clones the shipped parts. Re-reading the file can't prove that
  // (JSON.parse always yields fresh objects, so an identity assertion there passes
  // whether or not the clone exists) — what it protects is the in-memory seed,
  // which a later migration in the same process would otherwise share and mutate.
  it('does not mutate the in-memory seed while writing the record', async () => {
    const before = JSON.parse(JSON.stringify(NEW_HEY_HO_SCORE_PARTS));
    writeJson(roundsPath, { rounds: [oldRecord()] });
    await migration.up({ rootDir });
    expect(NEW_HEY_HO_SCORE_PARTS).toEqual(before);
  });

  it('keeps a user-added score part when it extends the shipped canon voices', async () => {
    // scoreParts is independently editable (Add part / AI-derive), so a stock
    // melody can carry a hand-written part. Replacing the whole array would
    // silently delete it.
    const mine = { id: 'part-mine-a1b2', label: 'My bass line', role: '', score: 'clef: bass\n\n| D3w |' };
    const record = oldRecord();
    record.scoreParts = [{ id: 'part-heyho-v2' }, { id: 'part-heyho-v3' }, mine];
    writeJson(roundsPath, { rounds: [record] });
    await migration.up({ rootDir });

    const parts = findRound(roundsPath, ROUND_ID).scoreParts;
    expect(parts.map((p) => p.id)).toEqual(['part-heyho-v2', 'part-heyho-v3', 'part-heyho-v4', 'part-mine-a1b2']);
    expect(parts.at(-1)).toEqual(mine);
  });

  it('corrects the stale voice guidance the fourth phrase invalidates', async () => {
    writeJson(roundsPath, { rounds: [oldRecord()] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedLayers: 2 });
    // Voice 4 is a real staggered entry now, not a unison double of the lead.
    expect(findLayer(roundsPath, 'voice-4').notes).toBe(NEW_HEY_HO_VOICE_4_NOTES);
    expect(findLayer(roundsPath, 'voice-4').notes).not.toMatch(/unison/i);
    // Voice 3 no longer claims the round is three phrases long.
    expect(findLayer(roundsPath, 'voice-3').notes).toBe(NEW_HEY_HO_VOICE_3_NOTES);
    expect(findLayer(roundsPath, 'voice-3').notes).not.toMatch(/three phrases/i);
    // An untouched layer stays untouched.
    expect(findLayer(roundsPath, 'voice-1').notes).toBe(oldRecord().layers[0].notes);
  });

  it('never clobbers voice guidance the user rewrote, and fixes the other layer', async () => {
    const myNotes = 'I come in on the last line, an octave down.';
    const record = oldRecord();
    record.layers = record.layers.map((l) => (l.id === 'voice-4' ? { ...l, notes: myNotes } : l));
    writeJson(roundsPath, { rounds: [record] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ fixedLayers: 1 });
    expect(findLayer(roundsPath, 'voice-4').notes).toBe(myNotes);
    expect(findLayer(roundsPath, 'voice-3').notes).toBe(NEW_HEY_HO_VOICE_3_NOTES);
  });

  it('tolerates a record with no layers array', async () => {
    const record = oldRecord();
    delete record.layers;
    writeJson(roundsPath, { rounds: [record] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedScore: true, fixedLayers: 0 });
    expect(findRound(roundsPath, ROUND_ID).score).toBe(NEW_HEY_HO_SCORE);
  });

  it('is idempotent across re-runs', async () => {
    writeJson(roundsPath, { rounds: [oldRecord()] });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second).toEqual({ updated: 0, reason: 'already-applied' });
    expect(findRound(roundsPath, ROUND_ID).score).toBe(NEW_HEY_HO_SCORE);
  });

  it('never clobbers a customized score', async () => {
    const custom = 'clef: treble\nkey: C\n\n| D4w(Mine) |';
    writeJson(roundsPath, { rounds: [{ ...oldRecord(), score: custom }] });
    await migration.up({ rootDir });
    expect(findRound(roundsPath, ROUND_ID).score).toBe(custom);
  });

  it('still corrects stock lyrics and notation when the score is customized', async () => {
    const custom = 'clef: treble\nkey: C\n\n| D4w(Mine) |';
    writeJson(roundsPath, { rounds: [{ ...oldRecord(), score: custom }] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedScore: false, fixedLyrics: true, fixedNotation: true });
    expect(findLyrics(roundsPath)).toBe(NEW_HEY_HO_LYRICS);
    expect(findRound(roundsPath, ROUND_ID).notation).toBe(NEW_HEY_HO_NOTATION);
  });

  it('never clobbers customized lyrics while still extending a stock score', async () => {
    const myLyrics = 'Hey, ho, nobody home,\nI sing it my own way.';
    const record = oldRecord();
    record.sections = [{ id: SECTION_ID, label: 'Round', lyrics: myLyrics }];
    writeJson(roundsPath, { rounds: [record] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedScore: true, fixedLyrics: false });
    expect(findLyrics(roundsPath)).toBe(myLyrics);
    expect(findRound(roundsPath, ROUND_ID).score).toBe(NEW_HEY_HO_SCORE);
  });

  it('tolerates a record with no sections array', async () => {
    const record = oldRecord();
    delete record.sections;
    writeJson(roundsPath, { rounds: [record] });
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 1, fixedScore: true, fixedLyrics: false });
    expect(findRound(roundsPath, ROUND_ID).score).toBe(NEW_HEY_HO_SCORE);
  });
});
