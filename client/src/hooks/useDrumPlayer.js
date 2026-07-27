import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDrumChart, drumChartHasMusic } from '../lib/drumNotation.js';
import { createDrumPlayer, resolveLoopRange } from '../lib/drumPlayback.js';
import { clampBpm } from '../lib/metronome.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';

/**
 * Drum play-along transport for a SongBook `drum` chart (#3115) — React wrapper
 * over `lib/drumPlayback.js`. Owns the player lifecycle, the practice settings
 * (tempo / count-in / loop range / click) and the sheet playhead, so
 * `SongBookViewer` only renders controls.
 *
 * Practice tempo is a PER-MACHINE preference, not synced content: it persists to
 * `safeStorage` under the song id (exactly like the viewer's transpose offset)
 * and is never written into the record.
 *
 * A timing-critical edit (tempo, count-in, loop range) while playing STOPS
 * playback rather than re-timing a running schedule — already-scheduled audio
 * can't be moved, so a live rebase would desync the playhead from what you hear.
 * The user presses play again at the new setting. The click toggle is the
 * exception: it only gates FUTURE scheduling, so it applies live.
 *
 * Settings live in state AND are pushed into the player by a sync effect, so the
 * order the seeding effects happen to run in can't leave the player holding a
 * stale tempo (the per-song stored tempo lands after the player is created).
 *
 * The player, its interval and its scheduled audio are torn down on stop, on a
 * chart/song change, and on unmount — nothing survives the view.
 *
 * @param {string} text — the raw drum-chart source.
 * @param {{ songId?: string }} [options] — `songId` keys the persisted tempo.
 */
export default function useDrumPlayer(text, { songId } = {}) {
  const chart = useMemo(() => parseDrumChart(text), [text]);
  const barCount = chart.bars.length;
  // Bars can parse while every cell is a rest — there'd be nothing to hear, so
  // the transport gates Play on real hits rather than on the bar count.
  const hasMusic = useMemo(() => drumChartHasMusic(text), [text]);
  // The chart's own `tempo:` marking — the 100% reference for the percent buttons.
  const writtenTempo = clampBpm(chart.tempo) ?? 90;

  const storageKey = songId ? `songbook:drumBpm:${songId}` : null;
  const [bpm, setBpmState] = useState(writtenTempo);
  const [countInBars, setCountInBarsState] = useState(1);
  const [loopEnabled, setLoopEnabledState] = useState(false);
  const [loopFrom, setLoopFromState] = useState(1);
  const [loopTo, setLoopToState] = useState(1);
  const [clickEnabled, setClickEnabledState] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [activeStep, setActiveStep] = useState(null);

  const playerRef = useRef(null);
  // Intent mirror of `playing`: during a first play the player's own flag only
  // flips after `await ctx.resume()`, so a rapid double-toggle read off the
  // player would start playback twice instead of netting out to a cancel (same
  // guard as useMidiPlayer).
  const playingRef = useRef(false);
  const setPlayingBoth = useCallback((v) => {
    playingRef.current = v;
    setPlaying(v);
  }, []);

  // Seed the practice tempo: the stored per-song value if there is one, else the
  // chart's written tempo. `null` from safeReadStorage is "never set" — distinct
  // from a stored value — so a fresh song follows its own marking.
  useEffect(() => {
    const stored = storageKey ? clampBpm(safeReadStorage(storageKey)) : null;
    setBpmState(stored ?? writtenTempo);
  }, [storageKey, writtenTempo]);

  // A chart change invalidates the loop range (the bar count differs).
  useEffect(() => {
    setLoopFromState(1);
    setLoopToState(Math.max(1, barCount));
  }, [barCount]);

  // One player per chart; torn down when the chart changes or the host unmounts,
  // so no interval or scheduled hit outlives the view. Initial settings come from
  // the sync effect below, which runs right after this one.
  useEffect(() => {
    if (!chart.bars.length) {
      playerRef.current = null;
      return undefined;
    }
    const player = createDrumPlayer(chart, {
      onStep: (info) => setActiveStep(info),
      onEnded: () => { setPlayingBoth(false); setActiveStep(null); },
    });
    playerRef.current = player;
    return () => {
      player.stop();
      playerRef.current = null;
      setPlayingBoth(false);
      setActiveStep(null);
    };
  }, [chart, setPlayingBoth]);

  // Push the current settings into whatever player is mounted. The player's own
  // setters rebuild its schedule only while idle, and every timing-critical
  // setter below stops playback first — so this never re-times live audio.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setBpm(bpm);
    player.setCountIn(countInBars);
    player.setLoop(loopEnabled ? { from: loopFrom, to: loopTo } : null);
    player.setClick(clickEnabled);
  }, [chart, bpm, countInBars, loopEnabled, loopFrom, loopTo, clickEnabled]);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setPlayingBoth(false);
    setActiveStep(null);
  }, [setPlayingBoth]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playingRef.current) { stop(); return; }
    setPlayingBoth(true);
    // play() resolves once playback has STARTED; an autoplay-policy failure lands
    // here — reset the button rather than lying "playing".
    Promise.resolve(player.play()).catch((err) => {
      console.error(`🥁 Drum play-along failed to start: ${err.message}`);
      setPlayingBoth(false);
      setActiveStep(null);
    });
  }, [setPlayingBoth, stop]);

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
    if (storageKey) safeWriteStorage(storageKey, String(clamped));
  }, [stopIfPlaying, storageKey]);

  // Percent of the chart's WRITTEN tempo (the practice-slower control).
  const setBpmPercent = useCallback((percent) => {
    setBpm(Math.round((writtenTempo * percent) / 100));
  }, [setBpm, writtenTempo]);

  const setCountInBars = useCallback((next) => {
    stopIfPlaying();
    setCountInBarsState(Math.max(0, Math.min(4, Math.trunc(Number(next)) || 0)));
  }, [stopIfPlaying]);

  const setLoopEnabled = useCallback((enabled) => {
    stopIfPlaying();
    setLoopEnabledState(!!enabled);
  }, [stopIfPlaying]);

  // Clamped against the real bar count so the two selects can't describe a range
  // the chart doesn't have.
  const setLoopRange = useCallback((from, to) => {
    const range = resolveLoopRange(barCount, { from, to }) || { from: 1, to: Math.max(1, barCount) };
    stopIfPlaying();
    setLoopFromState(range.from);
    setLoopToState(range.to);
  }, [barCount, stopIfPlaying]);

  // Click only gates FUTURE scheduling — safe to flip mid-groove.
  const setClickEnabled = useCallback((enabled) => setClickEnabledState(!!enabled), []);

  // The bar the `[` / `]` loop-endpoint shortcuts act on: the playhead's bar
  // while playing, else the current loop start.
  const currentBar = activeStep?.bar || loopFrom;

  return {
    chart,
    barCount,
    hasMusic,
    writtenTempo,
    bpm,
    setBpm,
    setBpmPercent,
    countInBars,
    setCountInBars,
    loopEnabled,
    setLoopEnabled,
    loopFrom,
    loopTo,
    setLoopRange,
    clickEnabled,
    setClickEnabled,
    playing,
    activeStep,
    currentBar,
    toggle,
    stop,
  };
}
