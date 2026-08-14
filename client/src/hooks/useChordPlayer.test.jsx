import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useChordPlayer from './useChordPlayer.js';
import { DEFAULT_CHORD_TEMPO, DEFAULT_CHORD_BEATS_PER_BAR } from '../lib/chordPlayback.js';

// No AudioContext is created here: the hook only builds schedules until play()
// is pressed, so this suite covers the settings/derivation half. The audible
// half lives in lib/chordPlayer.test.js against the shared Web Audio fake.

// Invented placeholder sheet (privacy convention).
const SHEET = 'C        G\nNonsense lyric line';

describe('useChordPlayer', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('counts the sheet\'s chords and starts idle', () => {
    const { result } = renderHook(() => useChordPlayer(SHEET));
    expect(result.current.chordCount).toBe(2);
    expect(result.current.hasChords).toBe(true);
    expect(result.current.playing).toBe(false);
    expect(result.current.sounding).toBeNull();
    expect(result.current.bpm).toBe(DEFAULT_CHORD_TEMPO);
    expect(result.current.beatsPerBar).toBe(DEFAULT_CHORD_BEATS_PER_BAR);
  });

  it('reports a sheet whose only chord tokens are unvoiceable as having nothing to play', () => {
    // The tokens parse (so the transport bar appears) but none of them sound —
    // "there are tokens" and "something will sound" must not collapse together.
    const { result } = renderHook(() => useChordPlayer('N.C.   N.C.'));
    expect(result.current.chordCount).toBe(2);
    expect(result.current.hasChords).toBe(false);
  });

  it('stands up no player for a sheet with no chords', () => {
    const { result } = renderHook(() => useChordPlayer('just some words here'));
    expect(result.current.chordCount).toBe(0);
    expect(result.current.hasChords).toBe(false);
    // The toggle is inert rather than throwing on a missing player.
    act(() => { result.current.toggle(); });
    expect(result.current.playing).toBe(false);
  });

  it('persists tempo and beats-per-chord per song, and reads them back', () => {
    const { result, unmount } = renderHook(() => useChordPlayer(SHEET, { songId: 'song-1' }));
    act(() => { result.current.setBpm(112); });
    act(() => { result.current.setBeatsPerBar(3); });
    expect(result.current.bpm).toBe(112);
    expect(result.current.beatsPerBar).toBe(3);
    unmount();

    const reopened = renderHook(() => useChordPlayer(SHEET, { songId: 'song-1' }));
    expect(reopened.result.current.bpm).toBe(112);
    expect(reopened.result.current.beatsPerBar).toBe(3);

    // …and a DIFFERENT song is untouched by it.
    const other = renderHook(() => useChordPlayer(SHEET, { songId: 'song-2' }));
    expect(other.result.current.bpm).toBe(DEFAULT_CHORD_TEMPO);
    expect(other.result.current.beatsPerBar).toBe(DEFAULT_CHORD_BEATS_PER_BAR);
  });

  it('rejects out-of-range settings rather than storing them', () => {
    const { result } = renderHook(() => useChordPlayer(SHEET, { songId: 'song-3' }));
    act(() => { result.current.setBeatsPerBar(99); });
    expect(result.current.beatsPerBar).toBe(DEFAULT_CHORD_BEATS_PER_BAR);
    act(() => { result.current.setBpm('nonsense'); });
    expect(result.current.bpm).toBe(DEFAULT_CHORD_TEMPO);
    act(() => { result.current.setCountInBars(99); });
    expect(result.current.countInBars).toBe(4);
  });

  it('sets the tempo from a percent of the reference tempo', () => {
    const { result } = renderHook(() => useChordPlayer(SHEET));
    act(() => { result.current.setBpmPercent(50); });
    expect(result.current.bpm).toBe(Math.round(DEFAULT_CHORD_TEMPO / 2));
  });
});
