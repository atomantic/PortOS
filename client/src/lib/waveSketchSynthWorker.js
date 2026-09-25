/**
 * Web Worker entry for the drawn-waveform preview (#8470). Renders a
 * normalized sketch with the same deterministic synth the server saves the
 * take with (`synthesizeSketchChannels`, server/lib/waveSketch.js) so a
 * max-work painting — seconds of synthesis — never blocks the main thread.
 * The math is untouched; only the thread changes, so the PCM is
 * sample-identical to a main-thread render.
 *
 * `renderSketchPreview` is also the main-thread fallback used by
 * `waveSketchSynth.js` when workers are unavailable. The message handler is
 * installed only inside a worker scope, so importing this module elsewhere
 * (the lib barrel, tests) has no side effect.
 */

import { pcmPeaks, synthesizeSketchChannels } from '../../../server/lib/waveSketch.js';

/**
 * Render a sketch to its PCM channels plus `columns` [min, max] peaks of the
 * mono mix, which is computed here too — for a 600 s stereo painting that
 * mix is tens of millions of samples, too many for the main thread.
 */
export function renderSketchPreview(sketch, columns) {
  const channels = synthesizeSketchChannels(sketch);
  let mono = channels[0];
  if (channels.length > 1) {
    const [left, right] = channels;
    mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + right[i]) / 2;
  }
  return { channels, peaks: pcmPeaks(mono, columns) };
}

const inWorker = typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function';
if (inWorker) {
  self.onmessage = ({ data }) => {
    const { id, sketch, columns } = data;
    let result;
    try {
      result = renderSketchPreview(sketch, columns);
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err) });
      return;
    }
    // Hand the sample buffers back without copying them.
    self.postMessage({ id, ...result }, result.channels.map((channel) => channel.buffer));
  };
}
