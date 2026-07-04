import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';

// The service captures STATE_PATH at module-load time, so the scratch dir must
// exist before the import resolves. vi.hoisted runs before imports.
const scratch = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs');
  const { tmpdir } = require('os');
  const { join: j } = require('path');
  const dir = mkdtempSync(j(tmpdir(), 'rounds-svc-'));
  mkdirSync(j(dir, 'data'), { recursive: true });
  return { dir };
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: join(scratch.dir, 'data') },
  };
});

import * as svc from './rounds.js';
// The score DSL parser is a pure, dependency-free client module — import it here
// so the seeded scores are validated against the real parser at the source.
import { parseScore } from '../../client/src/lib/scoreNotation.js';

const STATE_FILE = join(scratch.dir, 'data', 'rounds.json');

describe('rounds service', () => {
  beforeEach(() => {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  });

  afterAll(() => {
    rmSync(scratch.dir, { recursive: true, force: true });
  });

  it('seeds the 500 Miles example on first read and persists it', async () => {
    const songs = await svc.listRounds();
    expect(songs.length).toBeGreaterThan(0);
    const seed = songs.find((s) => s.id === 'seed-500-miles');
    expect(seed).not.toBeNull();
    expect(seed.title).toBe('500 Miles');
    expect(seed.artist).toBe('Peter, Paul and Mary');
    expect(seed.rhythmShapeId).toBe('slow-4-4');
    // Persisted, so a re-read returns the same seed (no re-seed churn).
    expect(existsSync(STATE_FILE)).toBe(true);
    const again = await svc.listRounds();
    expect(again.find((s) => s.id === 'seed-500-miles')).toBeDefined();
  });

  it('creates a song with a generated id, newest-first', async () => {
    await svc.listRounds(); // seed
    const song = await svc.createRound({ title: 'Wayfaring Stranger', key: 'D minor', tempo: 60 });
    expect(song.id).toMatch(/^round-/);
    expect(song.title).toBe('Wayfaring Stranger');
    expect(song.tempo).toBe(60);
    const songs = await svc.listRounds();
    expect(songs[0].id).toBe(song.id); // unshifted to front
  });

  it('nulls a missing tempo on create', async () => {
    const noTempo = await svc.createRound({ title: 'No tempo' });
    expect(noTempo.tempo).toBeNull();
  });

  it('does not lose a song when a create races the first-read seed write', async () => {
    // Regression guard: on a fresh (unseeded) store, listRounds() previously
    // wrote the seed from the read path OUTSIDE the write queue, so a late
    // seed write could clobber a just-created song. Fire both without awaiting
    // the list first; the created song must survive.
    expect(existsSync(STATE_FILE)).toBe(false);
    const [, created] = await Promise.all([
      svc.listRounds(),
      svc.createRound({ title: 'Race winner' }),
    ]);
    const songs = await svc.listRounds();
    expect(songs.find((s) => s.id === created.id)).toBeTruthy();
    expect(songs.find((s) => s.title === '500 Miles')).toBeTruthy(); // seed also present
  });

  it('clamps an out-of-band tempo on the sanitize/read path', () => {
    // The route 400s an out-of-band tempo before createRound runs, so this
    // clamp only ever fires when reading hand-edited JSON — exercise it there.
    expect(svc.sanitizeRound({ id: 'x', tempo: 9000 }).tempo).toBe(svc.TEMPO_MAX);
    expect(svc.sanitizeRound({ id: 'x', tempo: 1 }).tempo).toBe(svc.TEMPO_MIN);
    expect(svc.sanitizeRound({ id: 'x', tempo: 'fast' }).tempo).toBeNull();
  });

  it('drops empty sections/layers and labels the survivors', async () => {
    const song = await svc.createRound({
      title: 'Layered',
      sections: [{ label: '', lyrics: '' }, { label: 'Verse', lyrics: 'la la' }],
      layers: [{ label: '', part: '', notes: '' }, { part: 'Bass', notes: 'root' }],
    });
    expect(song.sections).toHaveLength(1);
    expect(song.sections[0].label).toBe('Verse');
    expect(song.layers).toHaveLength(1);
    expect(song.layers[0].label).toBe('Layer'); // defaulted when blank but kept (has part/notes)
  });

  it('assigns a unique id to sections/layers submitted with a blank id', async () => {
    // The editor strips in-session temp ids before save (sends id: '') so the
    // server mints stable, non-colliding ids — guards against the reload
    // duplicate-key bug where persisted temp ids could be re-minted.
    const song = await svc.createRound({
      title: 'Blank ids',
      sections: [{ id: '', label: 'A', lyrics: '1' }, { id: '', label: 'B', lyrics: '2' }],
      layers: [{ id: '', label: 'L1', part: 'x' }, { id: '', label: 'L2', part: 'y' }],
    });
    const secIds = song.sections.map((s) => s.id);
    const layerIds = song.layers.map((l) => l.id);
    expect(new Set(secIds).size).toBe(2);   // unique
    expect(new Set(layerIds).size).toBe(2);
    for (const id of [...secIds, ...layerIds]) expect(id).toBeTruthy();
  });

  it('merges patches field-by-field — absent key preserves, present key applies', async () => {
    const song = await svc.createRound({ title: 'Original', artist: 'Someone', key: 'C' });
    const patched = await svc.updateRound(song.id, { title: 'Renamed', key: '' });
    expect(patched.title).toBe('Renamed');
    expect(patched.artist).toBe('Someone'); // untouched key preserved
    expect(patched.key).toBe('');           // empty string clears
    expect(patched.createdAt).toBe(song.createdAt); // createdAt is immutable across updates
  });

  it('throws NOT_FOUND when updating or deleting a missing song', async () => {
    await expect(svc.updateRound('song-nope', { title: 'x' })).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    await expect(svc.deleteRound('song-nope')).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deletes a song by id', async () => {
    const song = await svc.createRound({ title: 'Delete me' });
    const result = await svc.deleteRound(song.id);
    expect(result.id).toBe(song.id);
    const songs = await svc.listRounds();
    expect(songs.find((s) => s.id === song.id)).toBeUndefined();
  });

  it('sanitizeRound rejects shapeless records', () => {
    expect(svc.sanitizeRound(null)).toBeNull();
    expect(svc.sanitizeRound({})).toBeNull(); // no id
    expect(svc.sanitizeRound({ id: 'x' }).title).toBe('Untitled round');
  });

  it('sanitizes recordings — drops fileless takes, clamps peak, mints ids', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      recordings: [
        { layerId: 'lead', filename: 'a-vocal.wav', durationMs: 1200.7, peak: 0.4 },
        { layerId: 'bass', label: 'no file' },           // no filename → dropped
        { filename: 'b.wav', peak: 5, durationMs: -3 },  // peak clamped, duration floored
      ],
    });
    expect(song.recordings).toHaveLength(2);
    expect(song.recordings[0].filename).toBe('a-vocal.wav');
    expect(song.recordings[0].durationMs).toBe(1201);
    expect(song.recordings[0].id).toMatch(/^rec-/);
    expect(song.recordings[1].peak).toBe(1);   // clamped to max
    expect(song.recordings[1].durationMs).toBe(0); // negative floored
  });

  it('preserves a stable recording id submitted with the take', () => {
    const song = svc.sanitizeRound({ id: 'x', recordings: [{ id: 'rec-keep', filename: 'k.wav' }] });
    expect(song.recordings[0].id).toBe('rec-keep');
  });

  it('legacy takes load unchanged — no pitchTrack/accuracy keys added', () => {
    const song = svc.sanitizeRound({ id: 'x', recordings: [{ filename: 'legacy.wav', durationMs: 500 }] });
    const rec = song.recordings[0];
    expect(rec).not.toHaveProperty('pitchTrack');
    expect(rec).not.toHaveProperty('accuracy');
  });

  it('persists + bounds a downsampled pitchTrack, dropping shapeless samples', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      recordings: [{
        filename: 'take.wav',
        pitchTrack: [
          { tMs: 0.6, hz: 220, cents: -3.2, clarity: 0.9 }, // tMs rounded, kept
          { tMs: null, hz: null },                          // no time + no pitch → dropped
          { tMs: 100 },                                     // time only → kept, nulls fill
        ],
      }],
    });
    const track = song.recordings[0].pitchTrack;
    expect(track).toHaveLength(2);
    expect(track[0]).toEqual({ tMs: 1, hz: 220, cents: -3.2, clarity: 0.9 });
    expect(track[1]).toEqual({ tMs: 100, hz: null, cents: null, clarity: null });
  });

  it('clamps an oversized pitchTrack to PITCH_TRACK_MAX', () => {
    const samples = Array.from({ length: svc.PITCH_TRACK_MAX + 50 }, (_, i) => ({ tMs: i, hz: 200 }));
    const song = svc.sanitizeRound({ id: 'x', recordings: [{ filename: 't.wav', pitchTrack: samples }] });
    expect(song.recordings[0].pitchTrack).toHaveLength(svc.PITCH_TRACK_MAX);
  });

  it('persists an accuracy summary, clamping percent and dropping unknown grades', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      recordings: [{
        filename: 't.wav',
        accuracy: {
          percentInTune: 150,                                  // clamped to 100
          graded: 4,
          counts: { 'in-tune': 2, close: 1, off: 1, missed: 0 },
          perNote: ['in-tune', 'close', 'bogus', 'off', 'missed'], // 'bogus' dropped
        },
      }],
    });
    const acc = song.recordings[0].accuracy;
    expect(acc.percentInTune).toBe(100);
    expect(acc.graded).toBe(4);
    expect(acc.counts).toEqual({ 'in-tune': 2, close: 1, off: 1, missed: 0 });
    expect(acc.perNote).toEqual(['in-tune', 'close', 'off', 'missed']);
  });

  it('derives accuracy.graded from perNote when not supplied', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      recordings: [{ filename: 't.wav', accuracy: { perNote: ['in-tune', 'off'] } }],
    });
    expect(song.recordings[0].accuracy.graded).toBe(2);
    expect(song.recordings[0].accuracy.percentInTune).toBe(0);
  });

  it('omits accuracy when there is nothing to persist', () => {
    const song = svc.sanitizeRound({ id: 'x', recordings: [{ filename: 't.wav', accuracy: 'not-an-object' }] });
    expect(song.recordings[0]).not.toHaveProperty('accuracy');
  });

  // --- Training progress (#1028) -----------------------------------------
  it('legacy/untrained songs load with no progress key', () => {
    expect(svc.sanitizeRound({ id: 'x' })).not.toHaveProperty('progress');
    // An empty history object is nothing to persist → omit.
    expect(svc.sanitizeRound({ id: 'x', progress: { history: {} } })).not.toHaveProperty('progress');
  });

  it('persists a per-scope training history, clamping percent and dropping zero-note attempts', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      progress: {
        history: {
          '__whole__': [
            { percentInTune: 250, graded: 6, at: '2026-06-08T00:00:00.000Z' }, // clamped to 100
            { percentInTune: 50, graded: 0 }, // zero-note → dropped
          ],
          'sec-1': [{ percentInTune: 80, graded: 4 }],
        },
      },
    });
    expect(song.progress.history['__whole__']).toHaveLength(1);
    expect(song.progress.history['__whole__'][0].percentInTune).toBe(100);
    expect(song.progress.history['sec-1'][0].graded).toBe(4);
  });

  it('drops a scope whose attempts all fail sanitization', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      progress: { history: { 'sec-1': [{ percentInTune: 90, graded: 0 }], 'sec-2': [{ percentInTune: 70, graded: 3 }] } },
    });
    expect(song.progress.history).not.toHaveProperty('sec-1');
    expect(song.progress.history['sec-2']).toHaveLength(1);
  });

  it('drops prototype-pollution-prone scope keys from a hand-edited file', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      progress: { history: { '__proto__': [{ percentInTune: 90, graded: 3 }], 'sec-1': [{ percentInTune: 70, graded: 3 }] } },
    });
    expect(Object.keys(song.progress.history)).toEqual(['sec-1']);
    // The Object prototype was not polluted.
    expect({}.percentInTune).toBeUndefined();
  });

  it('clamps an oversized per-scope history to PROGRESS_HISTORY_MAX', () => {
    const attempts = Array.from({ length: svc.PROGRESS_HISTORY_MAX + 20 }, () => ({ percentInTune: 80, graded: 3 }));
    const song = svc.sanitizeRound({ id: 'x', progress: { history: { 'sec-1': attempts } } });
    expect(song.progress.history['sec-1']).toHaveLength(svc.PROGRESS_HISTORY_MAX);
  });

  it('updateRound merges progress and preserves it across an unrelated edit', async () => {
    await svc.listRounds();
    const created = await svc.createRound({ title: 'Practice me' });
    const withProgress = await svc.updateRound(created.id, {
      progress: { history: { '__whole__': [{ percentInTune: 85, graded: 5 }] } },
    });
    expect(withProgress.progress.history['__whole__']).toHaveLength(1);
    // A later edit that doesn't touch progress keeps it (absent key preserves).
    const renamed = await svc.updateRound(created.id, { title: 'Renamed' });
    expect(renamed.progress.history['__whole__']).toHaveLength(1);
  });

  it('refreshRoundFromTemplate preserves the user training progress', async () => {
    await svc.listRounds();
    const seedId = [...svc.BUILTIN_ROUND_IDS][0];
    await svc.updateRound(seedId, { progress: { history: { 'sec-1': [{ percentInTune: 90, graded: 4 }] } } });
    const refreshed = await svc.refreshRoundFromTemplate(seedId);
    expect(refreshed.progress.history['sec-1']).toHaveLength(1);
  });

  it('stamps builtIn from the seed-id set, ignoring the raw value', () => {
    const seedId = [...svc.BUILTIN_ROUND_IDS][0];
    expect(svc.sanitizeRound({ id: seedId }).builtIn).toBe(true);
    // A custom song can't spoof builtIn even if the raw record claims it.
    expect(svc.sanitizeRound({ id: 'song-custom', builtIn: true }).builtIn).toBe(false);
  });

  it('seeds the 500 Miles default as a built-in with reference videos', async () => {
    const songs = await svc.listRounds();
    const seed = songs.find((s) => s.title === '500 Miles');
    expect(seed.builtIn).toBe(true);
    expect(seed.references.length).toBeGreaterThan(0);
    expect(seed.references.every((r) => r.url.includes('tiktok.com'))).toBe(true);
  });

  it('ships a sheet-music score on the 500 Miles default', async () => {
    const songs = await svc.listRounds();
    const seed = songs.find((s) => s.title === '500 Miles');
    expect(seed.score).toContain('clef: treble');
    expect(seed.score).toContain('(train)');
  });

  it('sanitizes the score field — trims and caps to SCORE_MAX_LENGTH', () => {
    expect(svc.sanitizeRound({ id: 'x', score: '  | C4q |  ' }).score).toBe('| C4q |');
    expect(svc.sanitizeRound({ id: 'x', score: 123 }).score).toBe(''); // non-string → ''
    const long = 'C'.repeat(svc.SCORE_MAX_LENGTH + 50);
    expect(svc.sanitizeRound({ id: 'x', score: long }).score.length).toBe(svc.SCORE_MAX_LENGTH);
  });

  it('sanitizes scoreParts — drops scoreless entries, mints ids, defaults labels', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      scoreParts: [
        { id: 'part-keep', label: 'Bass', role: 'bass', score: '| G2w(x) |' },
        { role: 'mid-harmony-1', score: '  | B4q |  ' }, // no id/label → minted id, default label
        { label: 'No notes', role: 'bass' },             // no score → dropped
        { score: '   ' },                                // blank score → dropped
      ],
    });
    expect(song.scoreParts).toHaveLength(2);
    expect(song.scoreParts[0].id).toBe('part-keep');
    expect(song.scoreParts[1].id).toMatch(/^part-/);
    expect(song.scoreParts[1].label).toBe('Part');   // default when blank
    expect(song.scoreParts[1].score).toBe('| B4q |'); // trimmed
  });

  it('defaults scoreParts to [] when absent (backward compatible)', () => {
    expect(svc.sanitizeRound({ id: 'x' }).scoreParts).toEqual([]);
  });

  it('sanitizes references — drops urlless entries, mints ids', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      references: [
        { url: 'https://www.tiktok.com/@u/video/123', label: 'A' },
        { label: 'no url' },          // no url → dropped
        { id: 'ref-keep', url: 'https://example.com' },
      ],
    });
    expect(song.references).toHaveLength(2);
    expect(song.references[0].id).toMatch(/^ref-/);
    expect(song.references[1].id).toBe('ref-keep');
  });

  it('reference audioFilename/segments round-trip; absent keys stay absent (#2106)', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      references: [
        { url: 'https://example.com/plain' }, // legacy — no analysis fields
        {
          url: 'https://www.tiktok.com/@u/video/9',
          audioFilename: '  abc123-ref.wav  ',
          segments: [
            { layerId: 'lead', startMs: 0, endMs: 14000 },
            { layerId: 'bass', startMs: 14000.7, endMs: 29000.2 }, // rounded
          ],
        },
      ],
    });
    // Legacy reference: the new keys must not appear at all.
    expect('audioFilename' in song.references[0]).toBe(false);
    expect('segments' in song.references[0]).toBe(false);
    // Analysis reference: trimmed filename + clamped/rounded segments.
    expect(song.references[1].audioFilename).toBe('abc123-ref.wav');
    expect(song.references[1].segments).toEqual([
      { layerId: 'lead', startMs: 0, endMs: 14000 },
      { layerId: 'bass', startMs: 14001, endMs: 29000 },
    ]);
  });

  it('drops malformed reference segments and bounds the list (#2106)', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      references: [{
        url: 'https://example.com',
        segments: [
          { layerId: 'a', startMs: 5000, endMs: 5000 },   // zero-length → dropped
          { layerId: 'b', startMs: 9000, endMs: 1000 },   // inverted → dropped
          { layerId: 'c', startMs: 'x', endMs: 2000 },    // non-finite → dropped
          { layerId: 'd', startMs: -50, endMs: 2000 },    // clamped to 0
          'not-an-object',                                 // shapeless → dropped
        ],
      }],
    });
    expect(song.references[0].segments).toEqual([
      { layerId: 'd', startMs: 0, endMs: 2000 },
    ]);
    // An all-invalid list leaves the key absent (no empty-array husk).
    const empty = svc.sanitizeRound({
      id: 'y',
      references: [{ url: 'https://example.com', segments: [{ startMs: 1, endMs: 1 }] }],
    });
    expect('segments' in empty.references[0]).toBe(false);
    // Bound: more than REF_SEGMENTS_MAX spans are truncated.
    const many = svc.sanitizeRound({
      id: 'z',
      references: [{
        url: 'https://example.com',
        segments: Array.from({ length: svc.REF_SEGMENTS_MAX + 5 }, (_, i) => ({
          layerId: `l${i}`, startMs: i * 1000, endMs: i * 1000 + 500,
        })),
      }],
    });
    expect(many.references[0].segments).toHaveLength(svc.REF_SEGMENTS_MAX);
  });

  it('refreshes a built-in from template, preserving recordings + learned', async () => {
    await svc.listRounds(); // seed
    const seedId = [...svc.BUILTIN_ROUND_IDS][0];
    // User edits the song and records a take + marks it learned.
    const edited = await svc.updateRound(seedId, {
      title: 'My edited title',
      sections: [{ label: 'Custom', lyrics: 'changed' }],
      score: '', // user cleared the sheet music
      learned: true,
      recordings: [{ filename: 'my-take.wav', durationMs: 1000 }],
      references: [{ url: 'https://example.com/mine' }],
    });
    expect(edited.title).toBe('My edited title');
    expect(edited.score).toBe('');

    const refreshed = await svc.refreshRoundFromTemplate(seedId);
    // Shipped content restored…
    expect(refreshed.title).toBe('500 Miles');
    expect(refreshed.references.every((r) => r.url.includes('tiktok.com'))).toBe(true);
    expect(refreshed.sections.some((s) => s.lyrics.includes('miss the train'))).toBe(true);
    expect(refreshed.score).toContain('clef: treble'); // sheet music restored too
    // …user-owned state preserved.
    expect(refreshed.learned).toBe(true);
    expect(refreshed.recordings).toHaveLength(1);
    expect(refreshed.recordings[0].filename).toBe('my-take.wav');
    expect(refreshed.createdAt).toBe(edited.createdAt);
    expect(refreshed.builtIn).toBe(true);
  });

  it('unassigns a recording whose layer the template lacks when refreshing', async () => {
    await svc.listRounds();
    const seedId = [...svc.BUILTIN_ROUND_IDS][0];
    await svc.updateRound(seedId, {
      layers: [{ id: 'custom-counter', label: 'Counter', part: 'Tenor' }],
      recordings: [{ filename: 'take.wav', layerId: 'custom-counter' }],
    });
    const refreshed = await svc.refreshRoundFromTemplate(seedId);
    // Layers reset to the template set, so the custom layer is gone…
    expect(refreshed.layers.some((l) => l.id === 'custom-counter')).toBe(false);
    // …and the take that referenced it is unassigned rather than orphaned.
    expect(refreshed.recordings).toHaveLength(1);
    expect(refreshed.recordings[0].layerId).toBe('');
  });

  it('drops a non-http(s) reference url (defense-in-depth)', () => {
    const song = svc.sanitizeRound({
      id: 'x',
      references: [
        { url: 'javascript:alert(1)' },        // dangerous scheme → dropped
        { url: 'https://www.tiktok.com/@u/video/1' },
      ],
    });
    expect(song.references).toHaveLength(1);
    expect(song.references[0].url).toBe('https://www.tiktok.com/@u/video/1');
  });

  it('refresh throws NOT_BUILTIN for a custom song and NOT_FOUND for a missing one', async () => {
    const custom = await svc.createRound({ title: 'Mine' });
    await expect(svc.refreshRoundFromTemplate(custom.id)).rejects.toMatchObject({ code: svc.ERR_NOT_BUILTIN });
    await expect(svc.refreshRoundFromTemplate('song-nope')).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('seeds the four traditional rounds as built-ins with parseable scores', async () => {
    const songs = await svc.listRounds();
    for (const title of ['Hey Ho Nobody Home', 'Ah Poor Bird', 'Rose Rose Rose Red', 'Zum Gali Gali']) {
      const round = songs.find((s) => s.title === title);
      expect(round, `missing seed "${title}"`).toBeTruthy();
      expect(round.builtIn).toBe(true);
      expect(round.score).toContain('clef: treble');
    }
  });

  it('ships parseable sheet-music scores on every seeded song', async () => {
    const songs = await svc.listRounds();
    const withScore = songs.filter((s) => s.score);
    expect(withScore.length).toBeGreaterThan(0);
    for (const s of withScore) {
      const parsed = parseScore(s.score);
      expect(parsed.errors, `${s.title}: ${parsed.errors.join('; ')}`).toEqual([]);
      // Every measure should be a full bar (4 beats in these 4/4 scores) and the
      // score must contain at least one note.
      expect(parsed.measures.some((m) => m.notes.length > 0)).toBe(true);
      for (const [i, m] of parsed.measures.entries()) {
        expect(Math.abs(m.beats - 4) < 1e-9, `${s.title} bar ${i + 1} = ${m.beats} beats`).toBe(true);
      }
    }
  });

  it('links the three classic quodlibet rounds to each other as partners', async () => {
    const songs = await svc.listRounds();
    const heyHo = songs.find((s) => s.id === 'seed-hey-ho-nobody-home');
    expect(heyHo.partnerRoundIds).toEqual(
      expect.arrayContaining(['seed-ah-poor-bird', 'seed-rose-rose-rose-red', 'seed-zum-gali-gali']),
    );
    // The link is symmetric — each partner names Hey Ho back.
    for (const id of heyHo.partnerRoundIds) {
      const partner = songs.find((s) => s.id === id);
      expect(partner.partnerRoundIds).toContain('seed-hey-ho-nobody-home');
    }
  });

  it('the corrected Hey Ho melody is D-centered with all naturals (no B, issue #2105)', async () => {
    const songs = await svc.listRounds();
    const heyHo = songs.find((s) => s.id === 'seed-hey-ho-nobody-home');
    const parsed = parseScore(heyHo.score);
    expect(parsed.errors).toEqual([]);
    const letters = parsed.measures.flatMap((m) => m.notes.filter((n) => !n.rest).map((n) => n.pitch.letter));
    // The old mis-transcription centered on G and climbed to a B-natural major
    // third; the fix removes every B and re-centers on D.
    expect(letters).not.toContain('B');
    expect(letters[0]).toBe('D');
    // The pitch content is the D natural-minor pentachord D–E–F–G–A only.
    expect([...new Set(letters)].sort()).toEqual(['A', 'D', 'E', 'F', 'G']);
  });

  it('the D-minor quodlibet trio has no {B,F} tritone at any aligned beat (issue #2105)', async () => {
    const songs = await svc.listRounds();
    const trio = ['seed-hey-ho-nobody-home', 'seed-ah-poor-bird', 'seed-rose-rose-rose-red']
      .map((id) => songs.find((s) => s.id === id));
    trio.forEach((s, i) => expect(s, `missing quodlibet round ${i}`).toBeTruthy());

    // Expand a score into an eighth-note grid of sounding pitch letters (one entry
    // per 0.5-beat slot; null for a rest). Asserts a clean parse and full 4/4 bars
    // along the way, so the trio's mechanical validity rides on this check too.
    const GRID = 0.5;
    const toGrid = (round) => {
      const parsed = parseScore(round.score);
      expect(parsed.errors, `${round.title}: ${parsed.errors.join('; ')}`).toEqual([]);
      const grid = [];
      for (const [i, m] of parsed.measures.entries()) {
        expect(Math.abs(m.beats - 4) < 1e-9, `${round.title} bar ${i + 1} = ${m.beats} beats`).toBe(true);
        for (const n of m.notes) {
          const slots = Math.round(n.duration.beats / GRID);
          for (let k = 0; k < slots; k += 1) grid.push(n.rest ? null : n.pitch.letter);
        }
      }
      return grid;
    };

    const grids = trio.map(toGrid);
    // Align the three looping rounds over the least common multiple of their
    // lengths and assert no beat ever sounds a B and an F together (the tritone
    // that the old G-centered Hey Ho produced against the partners' F naturals).
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const lcmLen = grids.reduce((acc, g) => (acc * g.length) / gcd(acc, g.length), 1);
    for (let i = 0; i < lcmLen; i += 1) {
      const sounding = new Set();
      for (const g of grids) { const p = g[i % g.length]; if (p) sounding.add(p); }
      expect(
        sounding.has('B') && sounding.has('F'),
        `B-against-F tritone at slot ${i}: {${[...sounding].sort().join(',')}}`,
      ).toBe(false);
    }
  });

  it('sanitizes partnerRoundIds — drops blanks, dedupes, and drops self-references', () => {
    const song = svc.sanitizeRound({
      id: 'seed-rose-rose-rose-red',
      partnerRoundIds: ['seed-ah-poor-bird', '', '  ', 'seed-ah-poor-bird', 'seed-rose-rose-rose-red', 42],
    });
    // 'seed-rose-rose-rose-red' (self) and the dup/blanks/non-string are removed.
    expect(song.partnerRoundIds).toEqual(['seed-ah-poor-bird']);
  });

  it('defaults partnerRoundIds to [] and round-trips a patch', async () => {
    const song = await svc.createRound({ title: 'Solo' });
    expect(song.partnerRoundIds).toEqual([]);
    const patched = await svc.updateRound(song.id, { partnerRoundIds: [song.id, 'song-other'] });
    expect(patched.partnerRoundIds).toEqual(['song-other']); // self dropped
  });

  it('getRound returns null for a non-existent id', async () => {
    await svc.listRounds(); // ensure seeded
    const missing = await svc.getRound('song-does-not-exist-xyz');
    expect(missing).toBeNull();
  });
});
