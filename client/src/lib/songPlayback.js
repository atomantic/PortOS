// Layered a cappella playback — decode N recorded vocal takes and start them
// together on one AudioContext so they stack into a multi-part performance.
//
// Web Audio (not N <audio> elements) because only a shared AudioContext clock
// lets us start every buffer on the same `when` timestamp — <audio> elements
// drift by tens of ms, which is audible on a tight harmony. Each take gets its
// own GainNode so a layer can be muted live without restarting the mix.
//
// Pure-ish: no React. The Song editor wraps this in a small hook for UI state.
// decodeAudioData is the only async dependency; callers handle rejection.

// The app-wide shared AudioContext (see audioContext.js) — reusing one keeps
// every layer on the same clock. Resumed on demand because autoplay policies
// start it suspended until a user gesture.
import { getAudioContext as ctx } from './audioContext.js';

// Decode one recording URL into an AudioBuffer. Cached per-URL on the returned
// mixer (not globally) so a re-open re-fetches at most once per session.
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load recording (${res.status})`);
  const bytes = await res.arrayBuffer();
  // decodeAudioData detaches the ArrayBuffer; pass it directly (we don't reuse).
  return ctx().decodeAudioData(bytes);
}

/**
 * Build a layered-playback mixer over a list of takes.
 *
 * @param {Array<{ id, url, muted? }>} takes — each take's audio URL + initial mute.
 * @returns a mixer: { play(), stop(), setMuted(id, bool), isPlaying(),
 *   onEnded(cb), duration() }. `play()` decodes (once) then starts every
 *   unmuted take in lockstep; resolves when playback has STARTED (not ended).
 */
export function createLayeredPlayer(takes = []) {
  const layers = new Map(); // id -> { url, buffer, gain, source, muted }
  for (const t of takes) {
    if (t && t.id && t.url) layers.set(t.id, { url: t.url, buffer: null, gain: null, source: null, muted: t.muted === true });
  }

  let playing = false;
  let endedCb = null;
  let liveCount = 0; // sources still playing; fire onEnded when it hits 0

  const stopSources = () => {
    for (const l of layers.values()) {
      if (l.source) {
        l.source.onended = null;
        try { l.source.stop(); } catch { /* already stopped */ }
        l.source = null;
      }
    }
    liveCount = 0;
  };

  const stop = () => {
    if (!playing) return;
    playing = false;
    stopSources();
  };

  const play = async () => {
    stop();
    const c = ctx();
    if (c.state === 'suspended') await c.resume();

    // Decode any not-yet-decoded buffers (parallel). Muted layers are skipped —
    // no point paying decode cost for something we won't hear this round.
    const active = [...layers.values()].filter((l) => !l.muted);
    await Promise.all(active.map(async (l) => {
      if (!l.buffer) l.buffer = await fetchBuffer(l.url);
    }));

    // Start every active layer at the same future timestamp so they're sample-
    // aligned. A small lead time absorbs decode/scheduling jitter.
    const startAt = c.currentTime + 0.06;
    playing = true;
    liveCount = 0;
    for (const l of active) {
      if (!l.buffer) continue;
      const gain = c.createGain();
      gain.gain.value = 1;
      const source = c.createBufferSource();
      source.buffer = l.buffer;
      source.connect(gain).connect(c.destination);
      source.onended = () => {
        if (l.source === source) l.source = null;
        liveCount = Math.max(0, liveCount - 1);
        if (liveCount === 0 && playing) {
          playing = false;
          if (endedCb) endedCb();
        }
      };
      source.start(startAt);
      l.gain = gain;
      l.source = source;
      liveCount += 1;
    }
    // Nothing to play (all muted / no buffers) — report ended immediately.
    if (liveCount === 0) {
      playing = false;
      if (endedCb) endedCb();
    }
  };

  // Toggle a layer's mute. Takes effect on the NEXT play() (we don't hot-swap a
  // running source — restarting keeps the stack sample-aligned, which matters
  // more for a harmony than gapless mute).
  const setMuted = (id, muted) => {
    const l = layers.get(id);
    if (l) l.muted = muted === true;
  };

  // Longest take's duration in seconds (0 until at least one buffer decoded).
  const duration = () => {
    let max = 0;
    for (const l of layers.values()) {
      if (l.buffer && l.buffer.duration > max) max = l.buffer.duration;
    }
    return max;
  };

  return {
    play,
    stop,
    setMuted,
    isPlaying: () => playing,
    onEnded: (cb) => { endedCb = cb; },
    duration,
  };
}
