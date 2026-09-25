// One-shot WebAudio preview for the Music Designer's LLM-made wave sketches
// (#8376): v1 drawings (mono) and v2 painted canvases (stereo, #8464). The PCM
// comes from `synthesizeSketchChannels` in server/lib/waveSketch.js — the same
// deterministic synth the server renders a saved take with — so what plays
// here is exactly what gets saved.
//
// No React: `WaveformPanel` drives it, whichever host mounts the panel (the
// Music Designer's drawn engine or the Tracks editor's "Drawn waveform" mode).
// The host owns the iOS audio-session claim (`useAudioSessionClaim`).

import { getAudioContext, resumeAudioContext } from './audioContext.js';
import { WAVE_SKETCH_SAMPLE_RATE } from '../../../server/lib/waveSketch.js';

/**
 * A single-source player for synthesized sketch PCM.
 *
 * - `play(pcm)` → Promise<boolean>: `pcm` is one mono Float32Array or an array
 *   of channels (`[left, right]`). Stops any current playback, resumes the
 *   shared context, and starts the buffer. Resolves false when a `stop()` (or
 *   a newer `play`) landed while the context was resuming, so a stale start
 *   never sounds. Rejects when the context cannot resume.
 * - `stop()` silences and releases the current source (idempotent).
 * - `position()` → seconds since the current playback started (0 when idle).
 * - `onEnded` fires when a buffer plays through to its end (not on `stop()`).
 */
export function createWaveSketchPlayer({ onEnded } = {}) {
  let source = null;
  let startedAt = 0;
  let generation = 0;

  const stop = () => {
    generation += 1;
    const current = source;
    source = null;
    if (!current) return;
    current.onended = null;
    try { current.stop(); } catch { /* already ended */ }
    current.disconnect();
  };

  const play = async (pcm) => {
    stop();
    const token = generation;
    const ctx = getAudioContext();
    await resumeAudioContext(ctx);
    if (token !== generation) return false;
    const channels = Array.isArray(pcm) ? pcm : [pcm];
    const buffer = ctx.createBuffer(channels.length, channels[0].length, WAVE_SKETCH_SAMPLE_RATE);
    channels.forEach((data, c) => buffer.getChannelData(c).set(data));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.onended = () => {
      if (source !== node) return;
      stop();
      onEnded?.();
    };
    source = node;
    startedAt = ctx.currentTime;
    node.start();
    return true;
  };

  const position = () => (source ? Math.max(0, getAudioContext().currentTime - startedAt) : 0);

  return { play, stop, position };
}
