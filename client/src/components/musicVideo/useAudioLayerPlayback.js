import { useEffect, useRef } from 'react';

// How far a sound may drift from the song before it is re-cued: tight on a
// play or seek, looser on the player's periodic time updates so a sound is not
// re-cued (an audible skip) for ordinary clock jitter.
const CUE_TOLERANCE_SEC = 0.05;
const DRIFT_TOLERANCE_SEC = 0.25;
const SONG_EVENTS = ['play', 'playing', 'pause', 'seeked', 'ended', 'ratechange', 'timeupdate'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** How far into its fades a sound is at `rel` seconds in: 0 (silent) to 1 (full), as the render's ramps. */
export function fadeEnvelope(rel, durationSec, fadeInSec = 0, fadeOutSec = 0) {
  if (!(rel >= 0) || !(rel <= durationSec)) return 0;
  const rise = fadeInSec > 0 ? rel / fadeInSec : 1;
  const fall = fadeOutSec > 0 ? (durationSec - rel) / fadeOutSec : 1;
  return clamp01(Math.min(rise, fall));
}

/**
 * Sounds heard over the preview's song, live: the timeline's audio layers and
 * the shots whose clip sound plays over the music. Each entry is
 * `{ id, src, startSec, durationSec, volume, fadeInSec?, fadeOutSec?,
 * musicLevel?, sourceAt? }` on song time: it starts when the song's clock
 * reaches `startSec`, plays from `sourceAt(t, fileSec)` in its file (default:
 * from the file's start), rises and falls over its fades, and dips the song to
 * `musicLevel` while it plays (ramping with the fades), as the render mixes it.
 * Nothing is rendered, so a moved or re-levelled sound is heard on the next play.
 *
 * The song's clock is the media element under `rootRef` that carries
 * `data-song-clock` (its offset on the song), the same one the timeline's
 * playhead reads; the sounds follow its play, pause, seek and rate events,
 * and a frame loop runs only while a fade or a dip is moving. `enabled` is
 * false while the preview plays a render, which already has them mixed in.
 * A level above 100% needs Web Audio's gain; without it a sound plays at most
 * at full volume.
 */
export default function useAudioLayerPlayback(rootRef, entries, enabled) {
  const players = useRef(new Map());
  const audioContext = useRef(null);
  const cueTimers = useRef([]);
  const frame = useRef(0);
  // The song's own volume before a dip, restored once no sound dips it.
  const songVolume = useRef(null);
  const syncRef = useRef(() => {});

  syncRef.current = (tolerance = CUE_TOLERANCE_SEC) => {
    for (const id of cueTimers.current) clearTimeout(id);
    cueTimers.current = [];
    const clock = rootRef.current?.querySelector('[data-song-clock]');
    const playing = !!clock && !clock.paused && !clock.ended;
    const t = clock ? clock.currentTime + (Number(clock.dataset.songClock) || 0) : 0;
    const rate = clock?.playbackRate || 1;
    let duck = 1;
    let moving = false;
    for (const player of players.current.values()) {
      const { audio, entry } = player;
      const rel = t - entry.startSec;
      const fileSec = Number.isFinite(audio.duration) ? audio.duration : null;
      const source = entry.sourceAt ? entry.sourceAt(t, fileSec) : rel;
      const ends = Math.min(entry.durationSec || Infinity, fileSec != null && !entry.sourceAt ? fileSec : Infinity);
      if (playing && rel < 0) {
        if (!audio.paused) audio.pause();
        // Cue it to start on time; the song's own events re-schedule this on any change.
        cueTimers.current.push(setTimeout(() => syncRef.current(), (-rel / rate) * 1000));
        continue;
      }
      if (!playing || rel >= ends || !(source >= 0) || (fileSec != null && source >= fileSec)) {
        if (!audio.paused) audio.pause();
        continue;
      }
      const envelope = fadeEnvelope(rel, ends, entry.fadeInSec, entry.fadeOutSec);
      if (entry.musicLevel != null && entry.musicLevel < 1) duck *= 1 - (1 - entry.musicLevel) * envelope;
      if (envelope < 1 || (entry.musicLevel != null && entry.musicLevel < 1)) moving = true;
      audio.playbackRate = rate;
      if (audio.paused || Math.abs(audio.currentTime - source) > tolerance) audio.currentTime = source;
      if (audio.paused) {
        if (!player.gain) routeThroughGain(player, audioContext);
        audioContext.current?.resume?.().catch(() => {});
        audio.play().catch(() => {});
      }
      applyLevel(player, envelope);
    }
    if (clock) dipSong(clock, duck, songVolume);
    cancelAnimationFrame(frame.current);
    frame.current = playing && moving ? requestAnimationFrame(() => syncRef.current(DRIFT_TOLERANCE_SEC)) : 0;
  };

  // Keep one element per audible entry, matching the saved settings.
  useEffect(() => {
    const map = players.current;
    const wanted = new Set();
    for (const entry of enabled ? entries || [] : []) {
      if (!entry?.src || !(entry.volume > 0)) continue;
      wanted.add(entry.id);
      let player = map.get(entry.id);
      if (!player || player.src !== entry.src) {
        if (player) disposePlayer(player);
        const audio = new Audio(entry.src);
        audio.preload = 'auto';
        player = { audio, src: entry.src, gain: null };
        map.set(entry.id, player);
      }
      player.entry = entry;
    }
    for (const [id, player] of map) {
      if (!wanted.has(id)) { disposePlayer(player); map.delete(id); }
    }
    syncRef.current();
  }, [entries, enabled]);

  // Follow the song's clock through its media events (capture: they do not bubble).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onEvent = (event) => {
      if (!event.target?.hasAttribute?.('data-song-clock')) return;
      syncRef.current(event.type === 'timeupdate' ? DRIFT_TOLERANCE_SEC : CUE_TOLERANCE_SEC);
    };
    for (const type of SONG_EVENTS) root.addEventListener(type, onEvent, true);
    return () => { for (const type of SONG_EVENTS) root.removeEventListener(type, onEvent, true); };
  }, [rootRef]);

  useEffect(() => () => {
    for (const id of cueTimers.current) clearTimeout(id);
    cancelAnimationFrame(frame.current);
    for (const player of players.current.values()) disposePlayer(player);
    players.current.clear();
    const clock = rootRef.current?.querySelector('[data-song-clock]');
    if (clock) dipSong(clock, 1, songVolume);
    audioContext.current?.close?.().catch(() => {});
    audioContext.current = null;
  }, [rootRef]);
}

// The song dipped to `duck` of its own volume, or back to it at 1.
function dipSong(clock, duck, saved) {
  if (duck < 1) {
    if (saved.current == null) saved.current = clock.volume;
    clock.volume = clamp01(saved.current * duck);
  } else if (saved.current != null) {
    clock.volume = saved.current;
    saved.current = null;
  }
}

// Web Audio is set up on the first play, which follows the director's press of play.
function routeThroughGain(player, contextRef) {
  const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  if (!Ctx) return;
  try {
    if (!contextRef.current) contextRef.current = new Ctx();
    const ctx = contextRef.current;
    const gain = ctx.createGain();
    ctx.createMediaElementSource(player.audio).connect(gain).connect(ctx.destination);
    player.gain = gain;
  } catch {
    // No Web Audio routing: the element's own volume still applies, capped at 100%.
  }
}

function applyLevel(player, envelope = 1) {
  const level = (player.entry?.volume ?? 1) * envelope;
  if (player.gain) {
    player.audio.volume = 1;
    player.gain.gain.value = level;
  } else {
    player.audio.volume = clamp01(level);
  }
}

function disposePlayer(player) {
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load?.();
  player.gain?.disconnect?.();
}
