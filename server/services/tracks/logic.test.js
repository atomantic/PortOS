import { describe, it, expect } from 'vitest';
import {
  sanitizeTrack, buildTrackRecord, applyTrackPatch, mergeTrackRecord, trackAudioFilename,
  sanitizeRender, makeRender, selectRenderPatch, deleteRenderPatch,
  TITLE_MAX, LYRICS_MAX, DURATION_MIN_SEC, DURATION_MAX_SEC, RENDERS_MAX,
} from './logic.js';

describe('tracks logic', () => {
  describe('sanitizeTrack', () => {
    it('drops records without an id or title', () => {
      expect(sanitizeTrack(null)).toBeNull();
      expect(sanitizeTrack({})).toBeNull();
      expect(sanitizeTrack({ id: 'track-1' })).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: '  ' })).toBeNull();
    });

    it('trims fields and normalizes the shape', () => {
      const t = sanitizeTrack({
        id: 'track-1',
        title: `  ${'t'.repeat(TITLE_MAX + 50)}  `,
        albumId: '  album-9  ',
        artistId: '  artist-9  ',
        artist: '  Nova  ',
        lyrics: `  ${'l'.repeat(LYRICS_MAX + 10)}  `,
        prompt: '  warm folk  ',
        engine: '  acestep  ',
        modelId: '  ace-v1  ',
        durationSec: 180,
        audioFilename: '  music-abc.mp3  ',
      });
      expect(t.title.length).toBe(TITLE_MAX);
      expect(t.albumId).toBe('album-9');
      expect(t.artistId).toBe('artist-9');
      expect(t.artist).toBe('Nova');
      expect(t.lyrics.length).toBe(LYRICS_MAX);
      expect(t.engine).toBe('acestep');
      expect(t.modelId).toBe('ace-v1');
      expect(t.durationSec).toBe(180);
      expect(t.audioFilename).toBe('music-abc.mp3');
    });

    it('clamps a garbage duration to null', () => {
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: 0 }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: DURATION_MAX_SEC + 1 }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: 'long' }).durationSec).toBeNull();
      expect(sanitizeTrack({ id: 'track-1', title: 'X', durationSec: DURATION_MIN_SEC }).durationSec).toBe(DURATION_MIN_SEC);
    });
  });

  describe('applyTrackPatch', () => {
    const base = buildTrackRecord({ title: 'Intro', lyrics: 'la la' }, { id: 'track-1', now: '2026-06-14T00:00:00.000Z' });
    it('overwrites present keys, preserves absent, applies clear', () => {
      const next = applyTrackPatch(base, { title: 'Intro (Reprise)', lyrics: '' });
      expect(next.title).toBe('Intro (Reprise)');
      expect(next.lyrics).toBe('');
    });
  });

  describe('mergeTrackRecord (LWW)', () => {
    const local = buildTrackRecord({ title: 'Local' }, { id: 'track-1', now: '2026-06-01T00:00:00.000Z' });
    it('inserts / newer-wins / older-loses', () => {
      expect(mergeTrackRecord(null, { ...local, title: 'R' }).inserted).toBe(true);
      expect(mergeTrackRecord(local, { ...local, title: 'New', updatedAt: '2099-01-01T00:00:00.000Z' }).remoteWins).toBe(true);
      expect(mergeTrackRecord(local, { ...local, title: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }).remoteWins).toBe(false);
    });
  });

  describe('render history', () => {
    it('backfills a legacy single-pointer track with one render (stable id, track createdAt)', () => {
      const t = sanitizeTrack({
        id: 'track-1', title: 'X', audioFilename: 'music-abc.wav',
        engine: 'musicgen', modelId: 'musicgen-medium', durationSec: 12, prompt: 'warm folk',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      expect(t.renders).toHaveLength(1);
      expect(t.renders[0]).toMatchObject({
        audioFilename: 'music-abc.wav', engine: 'musicgen', modelId: 'musicgen-medium', durationSec: 12, prompt: 'warm folk',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      // Deterministic id derived from the filename — re-sanitizing (the DB read
      // path) yields the SAME id, no drift.
      expect(sanitizeTrack(t).renders[0].id).toBe(t.renders[0].id);
    });

    it('no audio → empty render history (no synthesized entry)', () => {
      expect(sanitizeTrack({ id: 'track-1', title: 'X' }).renders).toEqual([]);
    });

    it('sanitizes, de-dups by id, and caps the render list to RENDERS_MAX (newest kept)', () => {
      const renders = [];
      for (let i = 0; i < RENDERS_MAX + 5; i += 1) {
        renders.push({ id: `render-${i}`, audioFilename: `music-${i}.wav`, createdAt: `2026-01-01T00:00:0${i % 10}.000Z` });
      }
      renders.push({ id: 'render-0', audioFilename: 'music-dupe.wav' }); // duplicate id dropped
      renders.push({ id: 'render-x', audioFilename: '' }); // no audio dropped
      const t = sanitizeTrack({ id: 'track-1', title: 'X', renders });
      expect(t.renders).toHaveLength(RENDERS_MAX);
      // Oldest fell off the front; the newest pushed entry survived.
      expect(t.renders.some((r) => r.id === 'render-x')).toBe(false);
      expect(t.renders[t.renders.length - 1].id).toBe(`render-${RENDERS_MAX + 4}`);
    });

    it('sanitizeRender drops entries without usable audio bytes', () => {
      expect(sanitizeRender({ id: 'r1' })).toBeNull();
      expect(sanitizeRender({ id: 'r1', audioFilename: '../x.wav' })).toBeNull();
      expect(sanitizeRender({ audioFilename: 'a.wav' }).id).toMatch(/^r-/); // deterministic fallback id
    });

    it('makeRender stamps the caller-supplied id + now', () => {
      const r = makeRender({ audioFilename: 'a.wav', engine: 'musicgen' }, { id: 'render-7', now: '2026-03-03T00:00:00.000Z' });
      expect(r).toMatchObject({ id: 'render-7', audioFilename: 'a.wav', engine: 'musicgen', createdAt: '2026-03-03T00:00:00.000Z' });
    });

    it('selectRenderPatch points the active fields at the chosen render, not prompt/lyrics', () => {
      const track = sanitizeTrack({
        id: 'track-1', title: 'X', audioFilename: 'b.wav', lyrics: 'keep me',
        renders: [
          { id: 'r-a', audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 },
          { id: 'r-b', audioFilename: 'b.wav', engine: 'audioldm2', modelId: 'm2', durationSec: 20 },
        ],
      });
      const patch = selectRenderPatch(track, 'r-a');
      expect(patch).toEqual({ audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 });
      expect(patch).not.toHaveProperty('lyrics');
      expect(selectRenderPatch(track, 'missing')).toBeNull();
    });

    it('deleteRenderPatch re-points active to newest remaining when the active take is removed', () => {
      const track = sanitizeTrack({
        id: 'track-1', title: 'X', audioFilename: 'b.wav', engine: 'audioldm2', modelId: 'm2', durationSec: 20,
        renders: [
          { id: 'r-a', audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 },
          { id: 'r-b', audioFilename: 'b.wav', engine: 'audioldm2', modelId: 'm2', durationSec: 20 },
        ],
      });
      const patch = deleteRenderPatch(track, 'r-b'); // remove the active render
      expect(patch.renders.map((r) => r.id)).toEqual(['r-a']);
      expect(patch).toMatchObject({ audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 });
    });

    it('deleteRenderPatch leaves the active pointer alone when a non-active take is removed', () => {
      const track = sanitizeTrack({
        id: 'track-1', title: 'X', audioFilename: 'b.wav',
        renders: [
          { id: 'r-a', audioFilename: 'a.wav' },
          { id: 'r-b', audioFilename: 'b.wav' },
        ],
      });
      const patch = deleteRenderPatch(track, 'r-a');
      expect(patch).toEqual({ renders: [expect.objectContaining({ id: 'r-b' })] });
      expect(deleteRenderPatch(track, 'missing')).toBeNull();
    });

    it('deleting the last render clears the active pointer', () => {
      const track = sanitizeTrack({ id: 'track-1', title: 'X', audioFilename: 'a.wav', engine: 'musicgen', renders: [{ id: 'r-a', audioFilename: 'a.wav', engine: 'musicgen' }] });
      const patch = deleteRenderPatch(track, 'r-a');
      expect(patch).toMatchObject({ renders: [], audioFilename: '', engine: '', modelId: '', durationSec: null });
    });

    it('renders is patchable so the route can append history', () => {
      const base = buildTrackRecord({ title: 'X' }, { id: 'track-1', now: '2026-01-01T00:00:00.000Z' });
      const r = makeRender({ audioFilename: 'a.wav', engine: 'musicgen' }, { id: 'render-1', now: '2026-01-01T00:00:00.000Z' });
      const next = applyTrackPatch(base, { renders: [r], audioFilename: 'a.wav' });
      expect(next.renders).toHaveLength(1);
      expect(next.renders[0].id).toBe('render-1');
    });
  });

  describe('trackAudioFilename', () => {
    it('returns a bare filename, null for blank or path-ish input', () => {
      expect(trackAudioFilename('music-abc.mp3')).toBe('music-abc.mp3');
      expect(trackAudioFilename('')).toBeNull();
      expect(trackAudioFilename('../escape.mp3')).toBeNull();
      expect(trackAudioFilename('sub/dir.mp3')).toBeNull();
    });
  });

  describe('chiptune fields (#2911)', () => {
    const score = {
      version: 1, bpm: 120, stepsPerBeat: 4, beatsPerBar: 4,
      channels: [{ id: 'pulse1', wave: 'square' }],
      patterns: { A: { bars: 1, notes: { pulse1: [{ step: 0, pitch: 'C5', len: 4 }] } } },
      order: ['A'],
    };

    it('sanitizes a valid score, nulls an invalid one, keeps the prompt', () => {
      const track = sanitizeTrack({ id: 'track-1', title: 'X', chiptuneScore: score, chiptunePrompt: 'farm loop' });
      expect(track.chiptuneScore).toMatchObject({ bpm: 120 });
      expect(track.chiptunePrompt).toBe('farm loop');
      const bad = sanitizeTrack({ id: 'track-1', title: 'X', chiptuneScore: { version: 99 } });
      expect(bad.chiptuneScore).toBeNull();
    });

    it('is patchable — absent preserves, present overwrites', () => {
      const base = sanitizeTrack({ id: 'track-1', title: 'X', chiptuneScore: score, chiptunePrompt: 'v1' });
      const untouched = applyTrackPatch(base, { title: 'Y' });
      expect(untouched.chiptuneScore).toMatchObject({ bpm: 120 });
      expect(untouched.chiptunePrompt).toBe('v1');
      const cleared = applyTrackPatch(base, { chiptuneScore: null, chiptunePrompt: '' });
      expect(cleared.chiptuneScore).toBeNull();
      expect(cleared.chiptunePrompt).toBe('');
    });

    it('merge preserves the local score when a winning remote payload lacks the keys entirely', () => {
      // A ≤v2 (chiptune-unaware) peer's payload has no chiptune keys — its
      // newer unrelated edit must not erase the local composition.
      const local = sanitizeTrack({ id: 'track-1', title: 'X', chiptuneScore: score, chiptunePrompt: 'v1', updatedAt: '2026-01-01T00:00:00.000Z' });
      const behindPeer = { id: 'track-1', title: 'Renamed', updatedAt: '2026-02-01T00:00:00.000Z' };
      const merged = mergeTrackRecord(local, behindPeer);
      expect(merged.remoteWins).toBe(true);
      expect(merged.next.title).toBe('Renamed');
      expect(merged.next.chiptuneScore).toMatchObject({ bpm: 120 });
      expect(merged.next.chiptunePrompt).toBe('v1');
    });

    it('merge applies an explicit remote clear (key present with null/empty)', () => {
      const local = sanitizeTrack({ id: 'track-1', title: 'X', chiptuneScore: score, chiptunePrompt: 'v1', updatedAt: '2026-01-01T00:00:00.000Z' });
      const v3Clear = { id: 'track-1', title: 'X', chiptuneScore: null, chiptunePrompt: '', updatedAt: '2026-02-01T00:00:00.000Z' };
      const merged = mergeTrackRecord(local, v3Clear);
      expect(merged.remoteWins).toBe(true);
      expect(merged.next.chiptuneScore).toBeNull();
      expect(merged.next.chiptunePrompt).toBe('');
    });
  });
});
