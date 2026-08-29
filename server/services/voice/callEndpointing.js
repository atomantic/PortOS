/**
 * Turn a continuous PCM stream from the call host into discrete utterances.
 *
 * A browser microphone turn is bounded by the user releasing push-to-talk. A
 * phone call has no such signal, so the server has to decide where one turn
 * ends: energy-based voice activity detection plus a trailing-silence timeout.
 *
 * Time is derived from the SAMPLE COUNT, never a wall clock — a stream that
 * arrives in bursts (a delayed socket flush) must endpoint exactly where a
 * smoothly-paced one would, and it makes the whole contract testable with
 * synthetic PCM and no sleeping.
 */

export const CALL_AUDIO_SAMPLE_RATE = 16_000;

export const ENDPOINTING_DEFAULTS = Object.freeze({
  sampleRate: CALL_AUDIO_SAMPLE_RATE,
  // Trailing silence that ends a turn. Long enough to survive a mid-sentence
  // breath, short enough that the reply does not feel late.
  silenceMs: 700,
  // Hard ceiling on one utterance, so a held-open line or a noisy room cannot
  // buffer without bound.
  maxUtteranceMs: 20_000,
  // Below this RMS (0..1) a frame is silence. Call audio arrives through a
  // virtual device with no gain staging, so this is deliberately low.
  rmsThreshold: 0.015,
  // Utterances shorter than this are a cough or a line click, not speech.
  minUtteranceMs: 250,
  // Audio kept from just BEFORE speech was detected, so the first consonant
  // is not clipped off the front of the transcript.
  preRollMs: 200,
});

const msToSamples = (ms, sampleRate) => Math.max(1, Math.round((ms / 1000) * sampleRate));
const samplesToMs = (samples, sampleRate) => Math.round((samples / sampleRate) * 1000);

/** Root-mean-square level of Int16 PCM, normalized to 0..1. */
export function pcmRms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** Int16 PCM → Float32 in -1..1, the shape `pcmToWavBuffer` expects. */
export function pcmToFloat(samples) {
  const floats = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) floats[index] = samples[index] / 32768;
  return floats;
}

const concat = (chunks, length) => {
  const merged = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

/**
 * Create a stateful endpointer.
 *
 * `push(chunk)` returns a completed utterance or `null`. Every chunk is
 * classified whole, so the caller controls the resolution by choosing its
 * chunk size (the call host sends ~20 ms frames).
 */
export function createCallEndpointer(options = {}) {
  const config = { ...ENDPOINTING_DEFAULTS, ...options };
  const silenceSamples = msToSamples(config.silenceMs, config.sampleRate);
  const maxSamples = msToSamples(config.maxUtteranceMs, config.sampleRate);
  const minSamples = msToSamples(config.minUtteranceMs, config.sampleRate);
  const preRollSamples = msToSamples(config.preRollMs, config.sampleRate);

  let speaking = false;
  let voiced = [];
  let voicedLength = 0;
  let trailingSilence = 0;
  // Rolling pre-roll buffer, only kept while NOT speaking.
  let preRoll = [];
  let preRollLength = 0;

  const reset = () => {
    speaking = false;
    voiced = [];
    voicedLength = 0;
    trailingSilence = 0;
    preRoll = [];
    preRollLength = 0;
  };

  const finish = (reason) => {
    // Trailing silence is dropped from the audio but not from the decision —
    // it is what ended the turn, and shipping it to STT only adds latency.
    const keep = reason === 'silence' ? Math.max(0, voicedLength - trailingSilence) : voicedLength;
    const merged = concat(voiced, voicedLength).subarray(0, keep);
    reset();
    if (merged.length < minSamples) return null;
    return { pcm: merged, durationMs: samplesToMs(merged.length, config.sampleRate), reason };
  };

  return {
    get speaking() { return speaking; },

    push(chunk) {
      if (!chunk?.length) return null;
      const loud = pcmRms(chunk) >= config.rmsThreshold;

      if (!speaking) {
        if (!loud) {
          // Keep only the tail: an idle line must not grow a buffer.
          preRoll.push(chunk);
          preRollLength += chunk.length;
          while (preRollLength - preRoll[0].length >= preRollSamples) {
            preRollLength -= preRoll.shift().length;
          }
          return null;
        }
        speaking = true;
        voiced = preRoll;
        voicedLength = preRollLength;
        preRoll = [];
        preRollLength = 0;
      }

      voiced.push(chunk);
      voicedLength += chunk.length;
      trailingSilence = loud ? 0 : trailingSilence + chunk.length;

      if (trailingSilence >= silenceSamples) return finish('silence');
      // The ceiling is checked last so a turn that both fell silent and hit the
      // cap on the same chunk is reported as the ordinary silence endpoint.
      if (voicedLength >= maxSamples) return finish('max-duration');
      return null;
    },

    /** End whatever is buffered — the call dropped or the host detached. */
    flush() {
      return speaking ? finish('flush') : null;
    },

    reset,
  };
}
