import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseTabSheet } from '../lib/tabNotation.js';
import {
  buildChordSchedule, createChordPlayer, resolveChordPlayhead, sheetChordOccurrences,
  DEFAULT_CHORD_TEMPO, DEFAULT_CHORD_BEATS_PER_BAR, CHORD_BEATS_MIN, CHORD_BEATS_MAX,
  CHORD_COUNT_IN_MAX,
} from '../lib/chordPlayback.js';
import { clampBpm } from '../lib/metronome.js';
import { useLocalStorageBool } from './useLocalStorageBool.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';

/**
 * Chord-sheet play-along transport for a SongBook `tab` / `chordpro` sheet
 * (#4104) — the React wrapper over `lib/chordPlayback.js`, and the chord-sheet
 * counterpart of `useDrumPlayer`. Owns the player lifecycle, the practice
 * settings (tempo / beats-per-chord / count-in / click) and the sounding-chord
 * highlight, so a host only renders controls.
 *
 * Practice tempo and beats-per-chord are PER-SONG, per-machine preferences (a
 * chord sheet carries no tempo of its own, and how long a chord is held is a
 * reading of the sheet rather than a property of it) — they persist to
 * `safeStorage` under the song id, exactly like the viewer's transpose offset,
 * and are never written into the record. The click is global to the machine: a
 * reference pulse you balance against your own playing, not a song property.
 *
 * A timing-critical edit (tempo, beats-per-chord, count-in) while playing STOPS
 * playback rather than re-timing a running schedule — already-scheduled audio
 * can't be moved. The click toggle is the exception: it gates future scheduling
 * only, so it applies live.
 *
 * THE HIGHLIGHT COMES FROM THE AUDIO CLOCK, not the player's `onChord` callback
 * — an event callback stands still through the count-in and cannot say WHERE in
 * a chord you are. One animation-frame loop polls the clock and commits to state
 * only when the sounding chord (or the beat) actually turns over, so the page
 * re-renders on chord changes rather than 60×/second.
 *
 * @param {string} text — the sheet source, already transposed by the caller.
 * @param {{ songId?: string }} [options] — `songId` keys the persisted settings.
 */
export default function useChordPlayer(text, { songId } = {}) {
  const { lines } = useMemo(() => parseTabSheet(text), [text]);
  const occurrences = useMemo(() => sheetChordOccurrences(lines), [lines]);
  const chordCount = occurrences.length;
  // A sheet can hold chord tokens that none of them voice ("N.C." alone) — Play
  // gates on something actually sounding, not on the token count.
  const hasChords = useMemo(
    () => buildChordSchedule(lines).events.some((ev) => !ev.rest),
    [lines],
  );

  const bpmKey = songId ? `songbook:chordBpm:${songId}` : null;
  const beatsKey = songId ? `songbook:chordBeats:${songId}` : null;

  const [bpm, setBpmState] = useState(DEFAULT_CHORD_TEMPO);
  const [beatsPerBar, setBeatsPerBarState] = useState(DEFAULT_CHORD_BEATS_PER_BAR);
  const [countInBars, setCountInBarsState] = useState(1);
  // Off by default: a strummed backing already lands on its own downbeats, so a
  // click over it is the deliberate choice rather than the resting state. The
  // hook's own default keeps "never chosen" distinct from "chosen off".
  const [clickEnabled, setClickEnabled] = useLocalStorageBool('songbook:chordClick', false);
  const [playing, setPlaying] = useState(false);
  const [pulse, setPulse] = useState(null);

  const playerRef = useRef(null);
  // Intent mirror of `playing`: during a first play the player's own flag only
  // flips after `await ctx.resume()`, so a rapid double-toggle read off the
  // player would start playback twice instead of netting out to a cancel.
  const playingRef = useRef(false);
  const setPlayingBoth = useCallback((v) => {
    playingRef.current = v;
    setPlaying(v);
  }, []);

  // Seed the per-song settings. `null` from safeReadStorage is "never set" —
  // distinct from a stored value — so a fresh song takes the defaults.
  useEffect(() => {
    setBpmState(clampBpm(bpmKey ? safeReadStorage(bpmKey) : null) ?? DEFAULT_CHORD_TEMPO);
  }, [bpmKey]);
  useEffect(() => {
    const stored = Number(beatsKey ? safeReadStorage(beatsKey) : null);
    setBeatsPerBarState(
      Number.isFinite(stored) && stored >= CHORD_BEATS_MIN && stored <= CHORD_BEATS_MAX
        ? Math.trunc(stored)
        : DEFAULT_CHORD_BEATS_PER_BAR,
    );
  }, [beatsKey]);

  // One player per sheet; torn down when the sheet changes or the host unmounts,
  // so no interval or scheduled tone outlives the view. Settings arrive from the
  // sync effect below, which runs right after this one.
  useEffect(() => {
    if (!chordCount) {
      playerRef.current = null;
      return undefined;
    }
    const player = createChordPlayer(lines, { onEnded: () => setPlayingBoth(false) });
    playerRef.current = player;
    return () => {
      player.stop();
      playerRef.current = null;
      setPlayingBoth(false);
    };
  }, [lines, chordCount, setPlayingBoth]);

  // Push the timing settings into whatever player is mounted. The player's own
  // setters rebuild only while idle, and every timing setter below stops
  // playback first — so this never re-times live audio.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setBpm(bpm);
    player.setBeatsPerBar(beatsPerBar);
    player.setCountIn(countInBars);
  }, [lines, bpm, beatsPerBar, countInBars]);

  // The click touches no timing, so it gets its own effect rather than joining
  // the one above — folding it in would rebuild the schedule to deliver what is
  // really a one-line assignment.
  useEffect(() => {
    playerRef.current?.setClick(clickEnabled);
  }, [lines, clickEnabled]);

  // Live read off the audio clock — the source both consumers below share.
  const getPlayhead = useCallback(() => {
    const player = playerRef.current;
    if (!player || !playingRef.current) return null;
    return resolveChordPlayhead(player.schedule(), player.position());
  }, []);

  // The sounding chord + beat readout, polled per frame and committed only when
  // it changes (see the header note).
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== 'function') {
      setPulse(null);
      return undefined;
    }
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      const head = getPlayhead();
      const next = head && {
        index: head.countIn ? null : head.index,
        beat: head.beat,
        countingIn: !!head.countIn,
      };
      setPulse((prev) => (
        prev?.index === next?.index && prev?.beat === next?.beat && prev?.countingIn === next?.countingIn
          ? prev
          : next
      ));
    });
    return () => cancelAnimationFrame(raf);
  }, [playing, getPlayhead]);

  // Which sheet token to light. `null` while counting in and while stopped — a
  // stale highlight left on the last chord reads as "still playing".
  const sounding = useMemo(() => {
    if (!playing || pulse?.index == null) return null;
    const occurrence = occurrences[pulse.index];
    return occurrence ? { index: pulse.index, ...occurrence } : null;
  }, [playing, pulse?.index, occurrences]);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setPlayingBoth(false);
  }, [setPlayingBoth]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playingRef.current) { stop(); return; }
    // The same gate the Play button carries — a sheet with no voiceable chord
    // has nothing to sound, and a key binding must not route around a disabled
    // button.
    if (!hasChords) return;
    setPlayingBoth(true);
    // play() resolves once playback has STARTED; an autoplay-policy failure
    // lands here — reset the button rather than lying "playing".
    Promise.resolve(player.play()).catch((err) => {
      console.error(`🎸 Chord play-along failed to start: ${err.message}`);
      setPlayingBoth(false);
    });
  }, [setPlayingBoth, stop, hasChords]);

  // Timing-critical edits stop playback first (see the header note); the sync
  // effect above then hands the new value to the now-idle player.
  const stopIfPlaying = useCallback(() => {
    if (playingRef.current) stop();
  }, [stop]);

  const setBpm = useCallback((next) => {
    const clamped = clampBpm(next);
    if (clamped == null) return;
    stopIfPlaying();
    setBpmState(clamped);
    if (bpmKey) safeWriteStorage(bpmKey, String(clamped));
  }, [stopIfPlaying, bpmKey]);

  // Percent of the default reference tempo (the practice-slower control). A
  // chord sheet has no written tempo, so DEFAULT_CHORD_TEMPO is the 100% mark.
  const setBpmPercent = useCallback((percent) => {
    setBpm(Math.round((DEFAULT_CHORD_TEMPO * percent) / 100));
  }, [setBpm]);

  const setBeatsPerBar = useCallback((next) => {
    const n = Math.trunc(Number(next));
    if (!Number.isFinite(n) || n < CHORD_BEATS_MIN || n > CHORD_BEATS_MAX) return;
    stopIfPlaying();
    setBeatsPerBarState(n);
    if (beatsKey) safeWriteStorage(beatsKey, String(n));
  }, [stopIfPlaying, beatsKey]);

  const setCountInBars = useCallback((next) => {
    stopIfPlaying();
    setCountInBarsState(Math.max(0, Math.min(CHORD_COUNT_IN_MAX, Math.trunc(Number(next)) || 0)));
  }, [stopIfPlaying]);

  return {
    chordCount,
    hasChords,
    writtenTempo: DEFAULT_CHORD_TEMPO,
    bpm,
    setBpm,
    setBpmPercent,
    beatsPerBar,
    setBeatsPerBar,
    countInBars,
    setCountInBars,
    clickEnabled,
    setClickEnabled,
    playing,
    pulse,
    sounding,
    getPlayhead,
    toggle,
    stop,
  };
}
