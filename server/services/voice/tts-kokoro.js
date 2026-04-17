// Kokoro TTS backend — in-process ONNX inference via kokoro-js + transformers.js.
// Model loads lazily on first synthesis (~2–3s) and stays resident.

import { KokoroTTS } from 'kokoro-js';
import { KOKORO_VOICES } from './kokoro-voices.js';

let modelPromise = null;
let loadedKey = null;
// `loaded` only flips once from_pretrained() resolves, so health reporting
// can distinguish "loading" (2-3s cold start in progress) from "loaded".
let loaded = false;

const ensureModel = async ({ modelId, dtype }) => {
  const key = `${modelId}|${dtype}`;
  if (modelPromise && loadedKey === key) return modelPromise;
  loadedKey = key;
  loaded = false;
  console.log(`🗣  kokoro: loading ${modelId} (dtype=${dtype})`);
  const started = Date.now();
  // Capture the in-flight promise so the then/catch handlers only mutate
  // shared state when they're still the active load. Without this, a second
  // load (different modelId/dtype) could race the first to completion and
  // corrupt `loaded`/`modelPromise`.
  const current = KokoroTTS.from_pretrained(modelId, { dtype, device: 'cpu' })
    .then((tts) => {
      if (modelPromise === current && loadedKey === key) {
        loaded = true;
        console.log(`🗣  kokoro: ready in ${Date.now() - started}ms`);
      }
      return tts;
    })
    .catch((err) => {
      if (modelPromise === current && loadedKey === key) {
        modelPromise = null;
        loadedKey = null;
        loaded = false;
      }
      throw err;
    });
  modelPromise = current;
  return modelPromise;
};

/**
 * @param {string} text
 * @param {object} cfg                   — full voice.tts config
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ wav: Buffer, latencyMs: number }>}
 */
export const synthesizeKokoro = async (text, cfg, signal) => {
  if (signal?.aborted) throw new Error('aborted');
  const { modelId, dtype, voice } = cfg.kokoro;
  const tts = await ensureModel({ modelId, dtype });
  if (signal?.aborted) throw new Error('aborted');

  const started = Date.now();
  const speed = Math.max(0.5, Math.min(2.0, cfg.rate ?? 1.0));
  const audio = await tts.generate(text, { voice, speed });
  if (signal?.aborted) throw new Error('aborted');

  return { wav: Buffer.from(audio.toWav()), latencyMs: Date.now() - started };
};

export const listKokoroVoices = async () =>
  Object.entries(KOKORO_VOICES)
    .map(([name, meta]) => ({ name, ...meta }))
    .sort((a, b) => a.name.localeCompare(b.name));

// 'lazy' = never touched; 'loading' = from_pretrained in flight; 'loaded' = usable.
export const readyState = () => {
  if (!modelPromise) return 'lazy';
  return loaded ? 'loaded' : 'loading';
};
export const isReady = () => loaded;
