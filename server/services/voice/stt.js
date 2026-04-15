// Speech-to-text via whisper.cpp's built-in HTTP server (POST /inference).
// Docs: https://github.com/ggerganov/whisper.cpp/tree/master/examples/server

import { getVoiceConfig } from './config.js';

const STT_TIMEOUT_MS = 30_000;

// Vocabulary bias: whisper.cpp's `prompt` field seeds the decoder with context
// so proper nouns and PortOS-specific terms are transcribed correctly instead
// of being mapped to common English homophones ("brain inbox" → "green inbox").
const DEFAULT_STT_PROMPT = 'PortOS, Chief of Staff, brain inbox, brain capture, task, agent, TASKS.md, Tailscale, Socket.IO, LM Studio, Whisper, Kokoro, Piper.';

/**
 * Transcribe a Buffer/Uint8Array of audio bytes.
 * @param {Buffer|Uint8Array} audio - audio payload (wav/webm/mp3)
 * @param {object} [opts]
 * @param {string} [opts.language='en']
 * @param {string} [opts.mimeType='audio/wav']
 * @param {string} [opts.endpoint]      override default endpoint
 * @returns {Promise<{ text: string, latencyMs: number }>}
 */
export const transcribe = async (audio, opts = {}) => {
  const cfg = await getVoiceConfig();
  const endpoint = opts.endpoint || cfg.stt.endpoint;
  const language = opts.language || 'en';
  const mimeType = opts.mimeType || 'audio/wav';
  const filename = opts.filename || 'audio.wav';

  const blob = new Blob([audio], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('response_format', 'json');
  form.append('language', language);
  form.append('temperature', '0');
  form.append('prompt', cfg.stt.vocabularyPrompt || DEFAULT_STT_PROMPT);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  const res = await fetch(`${endpoint}/inference`, {
    method: 'POST',
    body: form,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whisper inference failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return { text: (data.text || '').trim(), latencyMs: Date.now() - started };
};
