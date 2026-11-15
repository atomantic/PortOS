/**
 * Drum play-along transport for a SongBook `drum` chart (#3115): parses the chart
 * (`lib/drumNotation.js`), owns one `createDrumPlayer` per chart plus the practice settings and the
 * sheet playhead.
 *
 * Returns `{ chart, barCount, writtenTempo, bpm, setBpm, setBpmPercent, countInBars, setCountInBars,
 * loopEnabled, setLoopEnabled, loopFrom, loopTo, setLoopRange, clickEnabled, setClickEnabled,
 * clickVolume, setClickVolume, kitId, setKitId, playing, activeStep, currentBar, toggle, stop }`. The
 * practice tempo persists per song in `safeStorage` (never into the record) while the selected kit
 * (`songbook:drumKit`), the click toggle (`songbook:drumClick`) and the click level
 * (`songbook:drumClickVolume`) persist per MACHINE; a timing-critical edit (tempo / count-in / loop)
 * STOPS playback rather than re-timing already-scheduled audio, while the click toggle, the click
 * level and the kit swap apply live (raising the level off silence also unmutes, so the slider is
 * never a dead control); the player + its interval + scheduled hits tear down on stop, chart change
 * and unmount. Use when: The SongBook viewer and snapshot-based drum previews. Don't hand-wire
 * `createDrumPlayer` + BPM persistence + playhead state again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDrumChart, chartHasMusic } from '../lib/drumNotation.js';
import {
  createDrumPlayer, resolveLoopRange, resolvePlayhead,
  clampClickVolume, DEFAULT_CLICK_VOLUME,
} from '../lib/drumPlayback.js';
import { resolveDrumKit } from '../lib/drumKits.js';
import { clampBpm } from '../lib/metronome.js';
import { useLocalStorageBool, useLocalStoragePersisted } from './useLocalStorageBool.js';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';

// The selected kit is global to the machine (see the `kitId` state below).
const KIT_STORAGE_KEY = 'songbook:drumKit';
// So is the metronome level (see the header note).
const CLICK_VOLUME_STORAGE_KEY = 'songbook:drumClickVolume';

/**
 * Drum play-along transport for a SongBook `drum` chart (#3115) — React wrapper
 * over `lib/drumPlayback.js`. Owns the player lifecycle, the practice settings
 * (tempo / count-in / loop range / click on-off and level) and the playback
 * position, so `SongBookViewer` only renders controls.
 *
 * Practice tempo is a PER-MACHINE preference, not synced content: it persists to
 * `safeStorage` under the song id (exactly like the viewer's transpose offset)
 * and is never written into the record. The metronome — both its on/off and its
 * level — is the same kind of preference but global to the MACHINE: the click is
 * a reference pulse you balance against your own playing, not a property of any
 * one song.
 *
 * A timing-critical edit (tempo, count-in, loop range) while playing STOPS
 * playback rather than re-timing a running schedule — already-scheduled audio
 * can't be moved, so a live rebase would desync the position from what you hear.
 * The user presses play again at the new setting. The click toggle, the click
 * level and the kit selection are the exceptions: they gate or scale FUTURE
 * scheduling only, so they apply live.
 *
 * Settings live in state AND are pushed into the player by a sync effect, so the
 * order the seeding effects happen to run in can't leave the player holding a
 * stale tempo (the per-song stored tempo lands after the player is created).
 *
 * POSITION COMES FROM THE AUDIO CLOCK, never from the player's `onStep` event
 * callback — see `resolvePlayhead`. Two consumers, two rates:
 * - `getPlayhead()` is a stable on-demand read for the sheet's own animation
 *   frame loop (a continuous line can't go through React state 8×/second);
 * - `pulse` is the same position quantized to `{ bar, beat, countingIn }` for
 *   the transport's readout, polled per frame but only ever committed to state
 *   when the beat actually turns over — so the whole page re-renders on beats,
 *   not on steps.
 *
 * The player, its interval and its scheduled audio are torn down on stop, on a
 * chart/song change, and on unmount — nothing survives the view.
 *
 * @param {string} text — the raw drum-chart source.
 * @param {{ songId?: string, initialSettings?: object }} [options] — `songId`
 *   keys the persisted tempo; `initialSettings` seeds a second transport that
 *   should inherit the first transport's count-in and loop configuration.
 */
export default function useDrumPlayer(text, { songId, initialSettings } = {}) {
  const chart = useMemo(() => parseDrumChart(text), [text]);
  const barCount = chart.bars.length;
  // Bars can parse while every cell is a rest — there'd be nothing to hear, so
  // the transport gates Play on real hits rather than on the bar count.
  const hasMusic = useMemo(() => chartHasMusic(chart), [chart]);
  // The chart's own `tempo:` marking — the 100% reference for the percent buttons.
  const writtenTempo = clampBpm(chart.tempo) ?? 90;
  const beatsPerBar = chart.time?.beats || 4;
  const subdivision = chart.subdivision || 1;

  const storageKey = songId ? `songbook:drumBpm:${songId}` : null;
  const [bpm, setBpmState] = useState(writtenTempo);
  const initialLoop = resolveLoopRange(
    barCount,
    initialSettings?.loopEnabled
      ? { from: initialSettings.loopFrom, to: initialSettings.loopTo }
      : null,
  );
  const initialCountIn = initialSettings?.countInBars == null
    ? 1
    : Math.max(0, Math.min(4, Math.trunc(Number(initialSettings.countInBars)) || 0));
  const [countInBars, setCountInBarsState] = useState(initialCountIn);
  const [loopEnabled, setLoopEnabledState] = useState(!!initialSettings?.loopEnabled);
  const [loopFrom, setLoopFromState] = useState(initialLoop?.from ?? 1);
  const [loopTo, setLoopToState] = useState(initialLoop?.to ?? Math.max(1, barCount));
  // The click is a play-along METRONOME, so it defaults on — practising a groove
  // against no pulse is the unusual case, and "never chosen" must not read as
  // "chosen off" (the hook's own default handles that distinction).
  const [clickEnabled, setClickEnabled] = useLocalStorageBool('songbook:drumClick', true);
  // How loud that click sits over the kit. `parse` only runs on a value that was
  // really stored, and `clampClickVolume` returns null for a garbled one — which
  // together keep "never chosen" (→ full) distinct from a stored 0 (→ silent).
  const [clickVolume, setClickVolumeState] = useLocalStoragePersisted(
    CLICK_VOLUME_STORAGE_KEY,
    DEFAULT_CLICK_VOLUME,
    { parse: (raw) => clampClickVolume(raw) ?? DEFAULT_CLICK_VOLUME },
  );
  // Which synth kit sounds the chart (909 / 808 / acoustic). Like the metronome
  // it's a taste setting global to the MACHINE, not per song — and it changes no
  // timing, so unlike the tempo/loop settings it applies without stopping
  // playback. `resolveDrumKit` normalizes a missing or stale stored id.
  const [kitId, setKitIdState] = useState(() => resolveDrumKit(safeReadStorage(KIT_STORAGE_KEY)).id);
  const [playing, setPlaying] = useState(false);
  const [pulse, setPulse] = useState(null);

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

  // A later chart change invalidates the loop range. The initial bar count is
  // already represented by the state initializers above, including any range
  // inherited by an edit preview.
  const previousBarCountRef = useRef(barCount);
  useEffect(() => {
    if (previousBarCountRef.current === barCount) return;
    previousBarCountRef.current = barCount;
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
      onEnded: () => setPlayingBoth(false),
    });
    playerRef.current = player;
    return () => {
      player.stop();
      playerRef.current = null;
      setPlayingBoth(false);
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
  }, [chart, bpm, countInBars, loopEnabled, loopFrom, loopTo]);

  // The settings that touch no timing get their OWN effect rather than joining
  // the one above: each timing setter there rebuilds the schedule while idle, so
  // folding these in would re-flatten and re-sort every event three times over
  // to deliver what are really one-line assignments.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setClick(clickEnabled);
    player.setClickVolume(clickVolume);
    player.setKit(kitId);
  }, [chart, clickEnabled, clickVolume, kitId]);

  // Live playhead read — the source both consumers below share. Stable identity
  // so a caller's animation-frame loop can depend on it without restarting.
  const getPlayhead = useCallback(() => {
    const player = playerRef.current;
    if (!player || !playingRef.current) return null;
    return resolvePlayhead(player.schedule(), player.position());
  }, []);

  // The transport's beat/bar readout, polled off the same clock and committed
  // only when it changes (see the header note).
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== 'function') {
      setPulse(null);
      return undefined;
    }
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      const head = getPlayhead();
      const next = head && (head.countIn
        ? { bar: null, beat: head.beat, countingIn: true }
        : { bar: head.bar, beat: Math.floor(head.stepFloat / subdivision) + 1, countingIn: false });
      setPulse((prev) => (
        prev?.bar === next?.bar && prev?.beat === next?.beat && prev?.countingIn === next?.countingIn
          ? prev
          : next
      ));
    });
    return () => cancelAnimationFrame(raf);
  }, [playing, getPlayhead, subdivision]);

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setPlayingBoth(false);
  }, [setPlayingBoth]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playingRef.current) { stop(); return; }
    // Same gate the Play button carries — an all-rest chart has nothing to sound,
    // and the space-key binding must not route around a disabled button.
    if (!hasMusic) return;
    setPlayingBoth(true);
    // play() resolves once playback has STARTED; an autoplay-policy failure lands
    // here — reset the button rather than lying "playing".
    Promise.resolve(player.play()).catch((err) => {
      console.error(`🥁 Drum play-along failed to start: ${err.message}`);
      setPlayingBoth(false);
    });
  }, [setPlayingBoth, stop, hasMusic]);

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

  // Kit swaps affect no timing, so playback keeps running — the sync effect above
  // hands the new kit to the live player and the next scheduled hit uses it.
  const setKitId = useCallback((next) => {
    const id = resolveDrumKit(next).id;
    setKitIdState(id);
    safeWriteStorage(KIT_STORAGE_KEY, id);
  }, []);

  // Metronome level. Like the kit it changes no timing, so playback keeps
  // running and the live-settings effect above hands it to the sounding player.
  //
  // Raising it off silence UNMUTES: reaching for the level is an intent to hear
  // the click, and a slider that moves while the mute button holds it silent is
  // the "I adjusted it and nothing happened" bug. The reverse is deliberately
  // NOT wired — dragging to zero leaves the toggle alone, so unmuting later
  // can't come back silent.
  const setClickVolume = useCallback((next) => {
    const level = clampClickVolume(next);
    if (level == null) return;
    setClickVolumeState(level); // persists as a side effect
    // Guarded so a drag doesn't re-write the toggle's storage on every frame.
    if (level > 0 && !clickEnabled) setClickEnabled(true);
  }, [clickEnabled, setClickEnabled]);

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

  // The bar the `[` / `]` loop-endpoint shortcuts act on: the playhead's bar
  // while playing, else the current loop start.
  const currentBar = pulse?.bar || loopFrom;

  return {
    chart,
    barCount,
    hasMusic,
    writtenTempo,
    beatsPerBar,
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
    clickVolume,
    setClickVolume,
    kitId,
    setKitId,
    playing,
    pulse,
    currentBar,
    getPlayhead,
    toggle,
    stop,
  };
}
