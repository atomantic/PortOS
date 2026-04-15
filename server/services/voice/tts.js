// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper').

import { getVoiceConfig } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';

const backend = (engine) => {
  if (engine === 'piper') return { synth: synthesizePiper, list: listPiperVoices };
  return { synth: synthesizeKokoro, list: listKokoroVoices };
};

/**
 * Synthesize text with the active TTS engine. `opts.voice` overrides the
 * configured voice just for this call — used by the voice-picker preview
 * without having to save settings first.
 * @param {string} text
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.voice] transient voice override
 * @returns {Promise<{ wav: Buffer, latencyMs: number, engine: string }>}
 */
export const synthesize = async (text, opts = {}) => {
  const cfg = await getVoiceConfig();
  const engine = cfg.tts.engine || 'kokoro';
  const { synth } = backend(engine);
  let ttsCfg = cfg.tts;
  if (opts.voice) {
    ttsCfg = engine === 'kokoro'
      ? { ...cfg.tts, kokoro: { ...cfg.tts.kokoro, voice: opts.voice } }
      : { ...cfg.tts, piper: { ...cfg.tts.piper, voice: opts.voice } };
  }
  const result = await synth(text, ttsCfg, opts.signal);
  return { ...result, engine };
};

/**
 * Enumerate voices available for the active engine.
 * @returns {Promise<{ engine: string, voices: Array }>}
 */
export const listVoices = async () => {
  const cfg = await getVoiceConfig();
  const engine = cfg.tts.engine || 'kokoro';
  const { list } = backend(engine);
  return { engine, voices: await list(cfg.tts) };
};
