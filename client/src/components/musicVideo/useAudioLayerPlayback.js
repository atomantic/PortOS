import { useEffect, useRef } from 'react';
import { trackAudioUrl } from '../../services/apiTracks.js';

// How far a layer may drift from the song before it is re-cued: tight on a
// play or seek, looser on the player's periodic time updates so a layer is not
// re-cued (an audible skip) for ordinary clock jitter.
const CUE_TOLERANCE_SEC = 0.05;
const DRIFT_TOLERANCE_SEC = 0.25;
const SONG_EVENTS = ['play', 'playing', 'pause', 'seeked', 'ended', 'ratechange', 'timeupdate'];

/**
 * The timeline's audio layers heard over the preview's song, live: each layer
 * starts when the song's clock reaches its `startSec`, plays its file from
 * the start at its level and stops with the song. Nothing is rendered, so a
 * moved or re-levelled layer is heard on the next play.
 *
 * The song's clock is the media element under `rootRef` that carries
 * `data-song-clock` (its offset on the song), the same one the timeline's
 * playhead reads; the layers follow its play, pause, seek and rate events.
 * `enabled` is false while the preview plays a render, which already has the
 * layers mixed in. A level above 100% needs Web Audio's gain; without it a
 * layer plays at most at full volume.
 */
export default function useAudioLayerPlayback(rootRef, layers, enabled) {
  const players = useRef(new Map());
  const audioContext = useRef(null);
  const cueTimers = useRef([]);
  const syncRef = useRef(() => {});

  syncRef.current = (tolerance = CUE_TOLERANCE_SEC) => {
    for (const id of cueTimers.current) clearTimeout(id);
    cueTimers.current = [];
    const clock = rootRef.current?.querySelector('[data-song-clock]');
    const playing = !!clock && !clock.paused && !clock.ended;
    const t = clock ? clock.currentTime + (Number(clock.dataset.songClock) || 0) : 0;
    const rate = clock?.playbackRate || 1;
    for (const player of players.current.values()) {
      const { audio, layer } = player;
      const rel = t - layer.startSec;
      const length = Number.isFinite(audio.duration) ? audio.duration : layer.durationSec || 0;
      if (!playing || rel >= length) {
        if (!audio.paused) audio.pause();
        continue;
      }
      if (rel < 0) {
        if (!audio.paused) audio.pause();
        // Cue it to start on time; the song's own events re-schedule this on any change.
        cueTimers.current.push(setTimeout(() => syncRef.current(), (-rel / rate) * 1000));
        continue;
      }
      audio.playbackRate = rate;
      if (audio.paused || Math.abs(audio.currentTime - rel) > tolerance) audio.currentTime = rel;
      if (audio.paused) {
        if (!player.gain) routeThroughGain(player, audioContext);
        audioContext.current?.resume?.().catch(() => {});
        audio.play().catch(() => {});
      }
    }
  };

  // Keep one element per audible layer, matching the saved layers.
  useEffect(() => {
    const map = players.current;
    const wanted = new Set();
    for (const layer of enabled ? layers || [] : []) {
      if (layer.muted || !(layer.volume > 0) || !layer.filename) continue;
      wanted.add(layer.id);
      let player = map.get(layer.id);
      if (!player || player.filename !== layer.filename) {
        if (player) disposePlayer(player);
        const audio = new Audio(trackAudioUrl(layer.filename));
        audio.preload = 'auto';
        player = { audio, filename: layer.filename, gain: null };
        map.set(layer.id, player);
      }
      player.layer = layer;
      applyLevel(player);
    }
    for (const [id, player] of map) {
      if (!wanted.has(id)) { disposePlayer(player); map.delete(id); }
    }
    syncRef.current();
  }, [layers, enabled]);

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
    for (const player of players.current.values()) disposePlayer(player);
    players.current.clear();
    audioContext.current?.close?.().catch(() => {});
    audioContext.current = null;
  }, []);
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
    applyLevel(player);
  } catch {
    // No Web Audio routing: the element's own volume still applies, capped at 100%.
  }
}

function applyLevel(player) {
  const volume = player.layer?.volume ?? 1;
  if (player.gain) {
    player.audio.volume = 1;
    player.gain.gain.value = volume;
  } else {
    player.audio.volume = Math.min(1, Math.max(0, volume));
  }
}

function disposePlayer(player) {
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load?.();
  player.gain?.disconnect?.();
}
