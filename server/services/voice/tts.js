// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper').

import { getVoiceConfig } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';

const backend = (engine) => {
  if (engine === 'piper') return { synth: synthesizePiper, list: listPiperVoices };
  return { synth: synthesizeKokoro, list: listKokoroVoices };
};

/**
 * Synthesize text with the active TTS engine.
 * @param {string} text
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ wav: Buffer, latencyMs: number, engine: string }>}
 */
export const synthesize = async (text, opts = {}) => {
  const cfg = await getVoiceConfig();
  const engine = cfg.tts.engine || 'kokoro';
  const { synth } = backend(engine);
  const result = await synth(text, cfg.tts, opts.signal);
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
