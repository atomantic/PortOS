/**
 * Playback reference for Realtime Voice: what the speaker is playing, timed against microphone capture, so the voice's
 * speech detector can tell what is left of its own reply's echo from the user talking (#20512).
 *
 * The reference is the post-volume signal the output AudioContext renders (tapped after its gain node). Reply audio that is
 * only queued, audio held back while the avatar renders it, and muted output never count as playback. Output blocks are
 * stamped with the time they reach the output device (getOutputTimestamp, so output device delay is included); microphone
 * blocks with the time they were captured. Both are performance.now() milliseconds. Alignment is good to about one render
 * quantum, which is fine for the detector: it looks at the loudest 20 ms of the last 200 ms of playback.
 */

// Long enough to cover the input and output device delays plus jitter in getOutputTimestamp.
const KEEP_MS = 1500;

/**
 * A short timeline of rendered output samples keyed by the time each block reaches the speaker.
 * @param {{ outRate: number, micRate: number, keepMs?: number }} options
 */
export const createPlaybackReference = ({ outRate, micRate, keepMs = KEEP_MS }) => {
  let blocks = []; // { startMs, endMs, samples }, in arrival order (output order)
  return {
    /** Add one block of rendered output whose first sample reaches the speaker at `startMs`. */
    push(samples, startMs) {
      if (!samples?.length || !Number.isFinite(startMs)) return;
      const endMs = startMs + (samples.length * 1000) / outRate;
      blocks.push({ startMs, endMs, samples });
      let drop = 0;
      while (drop < blocks.length && blocks[drop].endMs < endMs - keepMs) drop += 1;
      if (drop) blocks = blocks.slice(drop);
    },
    /**
     * The `n` reference samples at the microphone rate for a mic window starting at `startMs`: what the speaker played
     * then, or silence where nothing played. Nearest-sample resampling: only its loudness is used.
     */
    frame(startMs, n) {
      const out = new Float32Array(n);
      if (!Number.isFinite(startMs)) return out;
      const step = 1000 / micRate;
      let b = 0;
      for (let i = 0; i < n; i += 1) {
        const t = startMs + i * step;
        while (b < blocks.length && blocks[b].endMs <= t) b += 1;
        if (b >= blocks.length) break;
        const block = blocks[b];
        if (t < block.startMs) continue;
        const j = Math.floor(((t - block.startMs) * outRate) / 1000);
        out[i] = block.samples[Math.min(j, block.samples.length - 1)];
      }
      return out;
    },
  };
};

/** True when both contexts can place their samples on the wall clock, which the reference needs. */
export const supportsPlaybackReference = (micCtx, outCtx) =>
  typeof micCtx?.getOutputTimestamp === 'function' && typeof outCtx?.getOutputTimestamp === 'function';

/** performance.now() at which output rendered at context time `t` reaches the device, or null while the context cannot say. */
export const deviceTimeMs = (ctx, t) => {
  const ts = ctx?.getOutputTimestamp?.();
  if (!ts || !(ts.performanceTime > 0) || !Number.isFinite(ts.contextTime)) return null;
  return ts.performanceTime + (t - ts.contextTime) * 1000;
};

/**
 * performance.now() at which microphone input processed at context time `t` was captured: the render quantum at `t` is
 * (currentTime - t) behind the context's render position now, and its input is `inputLatencyS` older than its rendering.
 */
export const captureTimeMs = (ctx, t, inputLatencyS = 0, now = performance.now()) => {
  if (!Number.isFinite(t) || !Number.isFinite(ctx?.currentTime)) return null;
  return now - (ctx.currentTime - t) * 1000 - inputLatencyS * 1000;
};

/** The microphone's reported input latency in seconds (Chromium reports it in track settings), else 0. */
export const inputLatencyOf = (stream) => {
  const latency = stream?.getAudioTracks?.()[0]?.getSettings?.().latency;
  return Number.isFinite(latency) && latency > 0 ? latency : 0;
};
