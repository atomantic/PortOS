// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper').

import { getVoiceConfig, piperVoiceTildePath } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';
import { findPiperVoice } from './piper-voices.js';

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
  const engine = opts.engine || cfg.tts.engine || 'kokoro';
  const { synth } = backend(engine);
  let ttsCfg = cfg.tts;
  if (opts.voice) {
    const catalog = engine === 'piper' ? findPiperVoice(opts.voice) : null;
    ttsCfg = engine === 'kokoro'
      ? { ...cfg.tts, kokoro: { ...cfg.tts.kokoro, voice: opts.voice } }
      : {
          ...cfg.tts,
          piper: {
            ...cfg.tts.piper,
            voice: opts.voice,
            voicePath: catalog ? piperVoiceTildePath(opts.voice) : cfg.tts.piper.voicePath,
            speakerId: null,
          },
        };
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
  const engine = engineOverride || cfg.tts.engine || 'kokoro';
  const { list } = backend(engine);
  return { engine, voices: await list() };
};
