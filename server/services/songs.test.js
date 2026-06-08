import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

// The service captures STATE_PATH at module-load time, so the scratch dir must
// exist before the import resolves. vi.hoisted runs before imports.
const scratch = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs');
  const { tmpdir } = require('os');
  const { join: j } = require('path');
  const dir = mkdtempSync(j(tmpdir(), 'songs-svc-'));
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

import * as svc from './songs.js';
// The score DSL parser is a pure, dependency-free client module — import it here
// so the seeded scores are validated against the real parser at the source.
import { parseScore } from '../../client/src/lib/scoreNotation.js';

const STATE_FILE = join(scratch.dir, 'data', 'songs.json');

describe('songs service', () => {
  beforeEach(() => {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  });

  it('seeds the 500 Miles example on first read and persists it', async () => {
    const songs = await svc.listSongs();
    expect(songs.length).toBeGreaterThan(0);
    const seed = songs.find((s) => s.title === '500 Miles');
    expect(seed).toBeTruthy();
    expect(seed.artist).toBe('Peter, Paul and Mary');
    expect(seed.rhythmShapeId).toBe('slow-4-4');
    // Persisted, so a re-read returns the same seed (no re-seed churn).
    expect(existsSync(STATE_FILE)).toBe(true);
    const again = await svc.listSongs();
    expect(again.find((s) => s.title === '500 Miles')).toBeTruthy();
  });

  it('creates a song with a generated id, newest-first', async () => {
    await svc.listSongs(); // seed
    const song = await svc.createSong({ title: 'Wayfaring Stranger', key: 'D minor', tempo: 60 });
    expect(song.id).toMatch(/^song-/);
    expect(song.title).toBe('Wayfaring Stranger');
    expect(song.tempo).toBe(60);
    const songs = await svc.listSongs();
    expect(songs[0].id).toBe(song.id); // unshifted to front
  });

  it('nulls a missing tempo on create', async () => {
    const noTempo = await svc.createSong({ title: 'No tempo' });
    expect(noTempo.tempo).toBeNull();
  });

  it('does not lose a song when a create races the first-read seed write', async () => {
    // Regression guard: on a fresh (unseeded) store, listSongs() previously
    // wrote the seed from the read path OUTSIDE the write queue, so a late
    // seed write could clobber a just-created song. Fire both without awaiting
    // the list first; the created song must survive.
    expect(existsSync(STATE_FILE)).toBe(false);
    const [, created] = await Promise.all([
      svc.listSongs(),
      svc.createSong({ title: 'Race winner' }),
    ]);
    const songs = await svc.listSongs();
    expect(songs.find((s) => s.id === created.id)).toBeTruthy();
    expect(songs.find((s) => s.title === '500 Miles')).toBeTruthy(); // seed also present
  });

  it('clamps an out-of-band tempo on the sanitize/read path', () => {
    // The route 400s an out-of-band tempo before createSong runs, so this
    // clamp only ever fires when reading hand-edited JSON — exercise it there.
    expect(svc.sanitizeSong({ id: 'x', tempo: 9000 }).tempo).toBe(svc.TEMPO_MAX);
    expect(svc.sanitizeSong({ id: 'x', tempo: 1 }).tempo).toBe(svc.TEMPO_MIN);
    expect(svc.sanitizeSong({ id: 'x', tempo: 'fast' }).tempo).toBeNull();
  });

  it('drops empty sections/layers and labels the survivors', async () => {
    const song = await svc.createSong({
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
    const song = await svc.createSong({
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
    const song = await svc.createSong({ title: 'Original', artist: 'Someone', key: 'C' });
    const patched = await svc.updateSong(song.id, { title: 'Renamed', key: '' });
    expect(patched.title).toBe('Renamed');
    expect(patched.artist).toBe('Someone'); // untouched key preserved
    expect(patched.key).toBe('');           // empty string clears
    expect(patched.createdAt).toBe(song.createdAt); // createdAt is immutable across updates
  });

  it('throws NOT_FOUND when updating or deleting a missing song', async () => {
    await expect(svc.updateSong('song-nope', { title: 'x' })).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    await expect(svc.deleteSong('song-nope')).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deletes a song by id', async () => {
    const song = await svc.createSong({ title: 'Delete me' });
    const result = await svc.deleteSong(song.id);
    expect(result.id).toBe(song.id);
    const songs = await svc.listSongs();
    expect(songs.find((s) => s.id === song.id)).toBeUndefined();
  });

  it('sanitizeSong rejects shapeless records', () => {
    expect(svc.sanitizeSong(null)).toBeNull();
    expect(svc.sanitizeSong({})).toBeNull(); // no id
    expect(svc.sanitizeSong({ id: 'x' }).title).toBe('Untitled song');
  });

  it('sanitizes recordings — drops fileless takes, clamps peak, mints ids', () => {
    const song = svc.sanitizeSong({
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
    const song = svc.sanitizeSong({ id: 'x', recordings: [{ id: 'rec-keep', filename: 'k.wav' }] });
    expect(song.recordings[0].id).toBe('rec-keep');
  });

  it('stamps builtIn from the seed-id set, ignoring the raw value', () => {
    const seedId = [...svc.BUILTIN_SONG_IDS][0];
    expect(svc.sanitizeSong({ id: seedId }).builtIn).toBe(true);
    // A custom song can't spoof builtIn even if the raw record claims it.
    expect(svc.sanitizeSong({ id: 'song-custom', builtIn: true }).builtIn).toBe(false);
  });

  it('seeds the 500 Miles default as a built-in with reference videos', async () => {
    const songs = await svc.listSongs();
    const seed = songs.find((s) => s.title === '500 Miles');
    expect(seed.builtIn).toBe(true);
    expect(seed.references.length).toBeGreaterThan(0);
    expect(seed.references.every((r) => r.url.includes('tiktok.com'))).toBe(true);
  });

  it('ships a sheet-music score on the 500 Miles default', async () => {
    const songs = await svc.listSongs();
    const seed = songs.find((s) => s.title === '500 Miles');
    expect(seed.score).toContain('clef: treble');
    expect(seed.score).toContain('(train)');
  });

  it('sanitizes the score field — trims and caps to SCORE_MAX_LENGTH', () => {
    expect(svc.sanitizeSong({ id: 'x', score: '  | C4q |  ' }).score).toBe('| C4q |');
    expect(svc.sanitizeSong({ id: 'x', score: 123 }).score).toBe(''); // non-string → ''
    const long = 'C'.repeat(svc.SCORE_MAX_LENGTH + 50);
    expect(svc.sanitizeSong({ id: 'x', score: long }).score.length).toBe(svc.SCORE_MAX_LENGTH);
  });

  it('sanitizes scoreParts — drops scoreless entries, mints ids, defaults labels', () => {
    const song = svc.sanitizeSong({
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
    expect(svc.sanitizeSong({ id: 'x' }).scoreParts).toEqual([]);
  });

  it('sanitizes references — drops urlless entries, mints ids', () => {
    const song = svc.sanitizeSong({
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

  it('refreshes a built-in from template, preserving recordings + learned', async () => {
    await svc.listSongs(); // seed
    const seedId = [...svc.BUILTIN_SONG_IDS][0];
    // User edits the song and records a take + marks it learned.
    const edited = await svc.updateSong(seedId, {
      title: 'My edited title',
      sections: [{ label: 'Custom', lyrics: 'changed' }],
      score: '', // user cleared the sheet music
      learned: true,
      recordings: [{ filename: 'my-take.wav', durationMs: 1000 }],
      references: [{ url: 'https://example.com/mine' }],
    });
    expect(edited.title).toBe('My edited title');
    expect(edited.score).toBe('');

    const refreshed = await svc.refreshSongFromTemplate(seedId);
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
    await svc.listSongs();
    const seedId = [...svc.BUILTIN_SONG_IDS][0];
    await svc.updateSong(seedId, {
      layers: [{ id: 'custom-counter', label: 'Counter', part: 'Tenor' }],
      recordings: [{ filename: 'take.wav', layerId: 'custom-counter' }],
    });
    const refreshed = await svc.refreshSongFromTemplate(seedId);
    // Layers reset to the template set, so the custom layer is gone…
    expect(refreshed.layers.some((l) => l.id === 'custom-counter')).toBe(false);
    // …and the take that referenced it is unassigned rather than orphaned.
    expect(refreshed.recordings).toHaveLength(1);
    expect(refreshed.recordings[0].layerId).toBe('');
  });

  it('drops a non-http(s) reference url (defense-in-depth)', () => {
    const song = svc.sanitizeSong({
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
    const custom = await svc.createSong({ title: 'Mine' });
    await expect(svc.refreshSongFromTemplate(custom.id)).rejects.toMatchObject({ code: svc.ERR_NOT_BUILTIN });
    await expect(svc.refreshSongFromTemplate('song-nope')).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('seeds the four traditional rounds as built-ins with parseable scores', async () => {
    const songs = await svc.listSongs();
    for (const title of ['Hey Ho Nobody Home', 'Ah Poor Bird', 'Rose Rose Rose Red', 'Zum Gali Gali']) {
      const round = songs.find((s) => s.title === title);
      expect(round, `missing seed "${title}"`).toBeTruthy();
      expect(round.builtIn).toBe(true);
      expect(round.score).toContain('clef: treble');
    }
  });

  it('ships parseable sheet-music scores on every seeded song', async () => {
    const songs = await svc.listSongs();
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
    const songs = await svc.listSongs();
    const heyHo = songs.find((s) => s.id === 'seed-hey-ho-nobody-home');
    expect(heyHo.partnerSongIds).toEqual(
      expect.arrayContaining(['seed-ah-poor-bird', 'seed-rose-rose-rose-red', 'seed-zum-gali-gali']),
    );
    // The link is symmetric — each partner names Hey Ho back.
    for (const id of heyHo.partnerSongIds) {
      const partner = songs.find((s) => s.id === id);
      expect(partner.partnerSongIds).toContain('seed-hey-ho-nobody-home');
    }
  });

  it('sanitizes partnerSongIds — drops blanks, dedupes, and drops self-references', () => {
    const song = svc.sanitizeSong({
      id: 'seed-rose-rose-rose-red',
      partnerSongIds: ['seed-ah-poor-bird', '', '  ', 'seed-ah-poor-bird', 'seed-rose-rose-rose-red', 42],
    });
    // 'seed-rose-rose-rose-red' (self) and the dup/blanks/non-string are removed.
    expect(song.partnerSongIds).toEqual(['seed-ah-poor-bird']);
  });

  it('defaults partnerSongIds to [] and round-trips a patch', async () => {
    const song = await svc.createSong({ title: 'Solo' });
    expect(song.partnerSongIds).toEqual([]);
    const patched = await svc.updateSong(song.id, { partnerSongIds: [song.id, 'song-other'] });
    expect(patched.partnerSongIds).toEqual(['song-other']); // self dropped
  });
});
