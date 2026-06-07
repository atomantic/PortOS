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
});
