// Speech-to-text via whisper.cpp's built-in HTTP server (POST /inference).
// Docs: https://github.com/ggerganov/whisper.cpp/tree/master/examples/server

import { getVoiceConfig } from './config.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

export const STT_TIMEOUT_MS = 30_000;

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
 * @param {AbortSignal} [opts.signal]   upstream abort (barge-in) — cancels STT mid-flight
 * @param {boolean} [opts.verbose]      word timestamps via verbose_json (lyric alignment)
 * @param {string} [opts.prompt]        decoder prompt; empty string disables the vocabulary bias
 * @returns {Promise<{ text: string, latencyMs: number, words?: Array<{ text: string, startSec: number, endSec: number }> }>}
 */
export const transcribe = async (audio, opts = {}) => {
  const cfg = await getVoiceConfig();
  const endpoint = opts.endpoint || cfg.stt.endpoint;
  // Honor the configured STT language (opts override > settings > 'en').
  // Without this, changing voice.stt.language in Settings had no effect because
  // the pipeline calls transcribe(audio, { mimeType }) with no language arg.
  const language = opts.language || cfg.stt.language || 'en';
  const mimeType = opts.mimeType || 'audio/wav';
  const filename = opts.filename || 'audio.wav';
  const verbose = opts.verbose === true;
  // Lyric alignment passes the director's line. An absent prompt keeps the
  // voice vocabulary; a present string, including '', replaces it.
  const prompt = opts.prompt != null ? String(opts.prompt) : (cfg.stt.vocabularyPrompt || DEFAULT_STT_PROMPT);

  const blob = new Blob([audio], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  if (verbose) {
    // whisper.cpp splits the verbose_json `words` array on word boundaries
    // only when this flag is set; otherwise tokens break mid-word.
    form.append('split_on_word', 'true');
    form.append('token_timestamps', 'true');
  }
  form.append('language', language);
  form.append('temperature', '0');
  form.append('prompt', prompt);

  const started = Date.now();
  // fetchWithTimeout composes our timeout with the caller's abort signal so
  // barge-in can tear down an in-flight whisper request. If the caller's
  // signal is already aborted, short-circuit without hitting the network.
  if (opts.signal?.aborted) throw new Error('transcribe aborted');

  const res = await fetchWithTimeout(`${endpoint}/inference`, {
    method: 'POST',
    body: form,
    signal: opts.signal,
  }, STT_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whisper inference failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.text || '').trim();
  const latencyMs = Date.now() - started;
  if (!verbose) return { text, latencyMs };
  return { text, latencyMs, words: extractVerboseWords(data) };
};

const SPECIAL_TOKEN = /^(?:\[.*?\]|<\|.*?\|>)$/;

/** Parse a whisper timestamp: seconds, or `hh:mm:ss,mmm` / `mm:ss.mmm`. */
export function asSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const hms = text.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) + Number(hms[4]) / 10 ** hms[4].length;
  }
  const ms = text.match(/^(\d+):(\d{2})[.,](\d{1,3})$/);
  if (ms) return Number(ms[1]) * 60 + Number(ms[2]) + Number(ms[3]) / 10 ** ms[3].length;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function pushWord(out, text, start, end) {
  const trimmed = String(text || '').trim();
  if (!trimmed || SPECIAL_TOKEN.test(trimmed) || start == null || end == null || end < start) return;
  out.push({ text: trimmed, startSec: start, endSec: end });
}

function wordsFromList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const start = asSeconds(item.start ?? item.startSec ?? item.timestamps?.from);
    const end = asSeconds(item.end ?? item.endSec ?? item.timestamps?.to);
    pushWord(out, item.word ?? item.text, start, end);
  }
  return out;
}

// Subword tokens (" Hel" + "lo") become one word. A leading space, which is
// how whisper marks a word boundary, starts a new word.
function wordsFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0 || typeof tokens[0] === 'number') return [];
  const out = [];
  let current = null;
  for (const token of tokens) {
    const raw = typeof token === 'string' ? token : String(token?.text ?? token?.word ?? '');
    if (!raw || SPECIAL_TOKEN.test(raw.trim())) continue;
    const start = asSeconds(token?.timestamps?.from ?? token?.start ?? token?.startSec);
    const end = asSeconds(token?.timestamps?.to ?? token?.end ?? token?.endSec);
    if (start == null || end == null) continue;
    const text = raw.trim();
    if (!text) continue;
    if (!current || /^\s/.test(raw)) {
      current = { text, startSec: start, endSec: end };
      out.push(current);
    } else {
      current.text += text;
      current.endSec = end;
    }
  }
  return out;
}

/**
 * Word timings from a whisper.cpp `verbose_json` body. Prefers the `words`
 * array (word-split tokens) and falls back to grouping subword tokens.
 * @returns {Array<{ text: string, startSec: number, endSec: number }>}
 */
export function extractVerboseWords(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const segmented = segments.some((segment) => Array.isArray(segment?.words) && segment.words.length);
  if (segmented) return segments.flatMap((segment) => wordsFromList(segment.words));
  const top = wordsFromList(data?.words);
  if (top.length) return top;
  return segments.flatMap((segment) => wordsFromTokens(segment?.tokens));
}
