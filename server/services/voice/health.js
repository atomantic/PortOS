// Voice stack health checks — whisper.cpp + LLM provider + (when active) Piper.
// Kokoro runs in-process; readiness is reported via the in-memory model flag.

import { existsSync } from 'fs';
import { join } from 'path';
import { getVoiceConfig, expandPath, voiceHome } from './config.js';
import { readyState as kokoroReadyState } from './tts-kokoro.js';
import { which } from './bootstrap.js';
import { resolveLlmEndpoint, authHeaders } from './llm.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 3000;
let cache = null;

const probe = async (url, headers = {}) => {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, PROBE_TIMEOUT_MS);
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, state: 'bad_status', status: res.status, latencyMs };
    return { ok: true, status: res.status, latencyMs };
  } catch (err) {
    const name = err?.name || '';
    const code = err?.cause?.code || err?.code || '';
    if (name === 'AbortError') return { ok: false, state: 'timeout', latencyMs: Date.now() - started };
    if (code === 'ECONNREFUSED') return { ok: false, state: 'down', error: code };
    return { ok: false, state: 'error', error: err?.message || String(err) };
  }
};

export const checkAll = async (cfg) => {
  const voice = cfg || await getVoiceConfig();
  const sttEngine = voice.stt?.engine || 'whisper';
  const llmProvider = voice.llm?.provider || 'lmstudio';
  // Provider is part of the cache key so switching the voice LLM provider in
  // Settings re-probes the new endpoint instead of serving the stale badge.
  const cacheKey = `${sttEngine}|${voice.tts.engine}|${voice.stt.endpoint}|${llmProvider}`;
  if (cache && cache.key === cacheKey && Date.now() - cache.ts < CACHE_TTL_MS) {
    // Refresh kokoro readiness on every call — it's a cheap in-memory check
    // and flips from lazy → loading → loaded mid-cache-window after first synthesis.
    if (voice.tts.engine === 'kokoro') {
      const state = kokoroReadyState();
      cache.value.kokoro = { ok: state === 'loaded', state };
    }
    return cache.value;
  }

  // LLM probe: hit the configured provider's OpenAI-compatible /models endpoint
  // (with apiKey when the provider needs auth) so the badge reflects whichever
  // provider drives voice, not just LM Studio.
  const { apiBase, apiKey } = await resolveLlmEndpoint(llmProvider);
  const probes = [probe(`${apiBase}/models`, authHeaders(apiKey))];
  const labels = ['llm'];
  if (sttEngine === 'whisper') {
    probes.unshift(probe(voice.stt.endpoint));
    labels.unshift('whisper');
  }

  const results = await Promise.all(probes);
  const out = Object.fromEntries(labels.map((k, i) => [k, results[i]]));

  if (voice.tts.engine === 'piper') {
    // CLI-mode piper has no server to probe — check binary + selected voice.
    const localPiper = join(voiceHome(), 'piper', 'piper');
    const [hasBin, voicePath] = [existsSync(localPiper) || !!(await which('piper')), expandPath(voice.tts.piper?.voicePath || '')];
    const hasVoice = voicePath && existsSync(voicePath);
    out.piper = hasBin && hasVoice
      ? { ok: true, state: 'ready' }
      : { ok: false, state: !hasBin ? 'no binary' : 'voice missing' };
  }

  if (sttEngine === 'web-speech') {
    out['web-speech'] = { ok: true, state: 'browser-native' };
  }
  if (voice.tts.engine === 'kokoro') {
    const state = kokoroReadyState();
    out.kokoro = { ok: state === 'loaded', state };
  }

  cache = { key: cacheKey, ts: Date.now(), value: out };
  return out;
};

export const invalidateHealthCache = () => { cache = null; };
