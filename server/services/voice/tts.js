// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper').

import { getVoiceConfig, piperVoiceTildePath } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';
import { findPiperVoice } from './piper-voices.js';

const VALID_ENGINES = new Set(['kokoro', 'piper']);

// Normalize `engine` against the allowlist so an invalid value can't silently
// produce Kokoro audio while the response reports `engine: 'elevenlabs'`.
const resolveEngine = (engine) => VALID_ENGINES.has(engine) ? engine : 'kokoro';

const backend = (engine) => {
  if (engine === 'piper') return { synth: synthesizePiper, list: listPiperVoices };
  return { synth: synthesizeKokoro, list: listKokoroVoices };
};

/**
 * Synthesize text with the active TTS engine. `opts.voice` and `opts.engine`
 * override the configured voice/engine just for this call — used by the
 * voice-picker preview so users can audition before saving.
 * @param {string} text
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.voice]  transient voice override
 * @param {string} [opts.engine] transient engine override ('kokoro'|'piper')
 * @returns {Promise<{ wav: Buffer, latencyMs: number, engine: string }>}
 */
export const synthesize = async (text, opts = {}) => {
  const cfg = await getVoiceConfig();
  const engine = resolveEngine(opts.engine || cfg.tts.engine);
  const { synth } = backend(engine);
  let ttsCfg = cfg.tts;
  if (opts.voice) {
    if (engine === 'kokoro') {
      ttsCfg = { ...cfg.tts, kokoro: { ...cfg.tts.kokoro, voice: opts.voice } };
    } else {
      // Reject Piper voice overrides that aren't in the curated catalog —
      // otherwise `voice` would change but `voicePath` would remain the
      // previous config value, silently synthesizing the wrong voice.
      const catalog = findPiperVoice(opts.voice);
      if (!catalog) throw new Error(`unknown piper voice: ${opts.voice}`);
      ttsCfg = {
        ...cfg.tts,
        piper: {
          ...cfg.tts.piper,
          voice: opts.voice,
          voicePath: piperVoiceTildePath(opts.voice),
          speakerId: null,
        },
      };
    }
  }
  const result = await synth(text, ttsCfg, opts.signal);
  return { ...result, engine };
};

/**
 * Enumerate voices available for the given engine (or the configured one).
 * @param {string} [engineOverride] 'kokoro' | 'piper' to preview voices for
 *   an engine without saving it as active.
 * @returns {Promise<{ engine: string, voices: Array }>}
 */
export const listVoices = async (engineOverride) => {
  const cfg = await getVoiceConfig();
  const engine = resolveEngine(engineOverride || cfg.tts.engine);
  const { list } = backend(engine);
  return { engine, voices: await list() };
};
