// Voice stack health checks — whisper.cpp + LM Studio + (when active) Piper.
// Kokoro runs in-process; readiness is reported via the in-memory model flag.

import { existsSync } from 'fs';
import { join } from 'path';
import { getVoiceConfig, expandPath, voiceHome } from './config.js';
import { readyState as kokoroReadyState } from './tts-kokoro.js';
import { which } from './bootstrap.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 3000;
let cache = null;

const probe = async (url) => {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, PROBE_TIMEOUT_MS);
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

const lmStudioBaseUrl = () => (process.env.LM_STUDIO_URL || 'http://localhost:1234').replace(/\/+$/, '').replace(/\/v1$/, '');

export const checkAll = async (cfg) => {
  const voice = cfg || await getVoiceConfig();
  const sttEngine = voice.stt?.engine || 'whisper';
  const cacheKey = `${sttEngine}|${voice.tts.engine}|${voice.stt.endpoint}`;
  if (cache && cache.key === cacheKey && Date.now() - cache.ts < CACHE_TTL_MS) {
    // Refresh kokoro readiness on every call — it's a cheap in-memory check
    // and flips from lazy → loading → loaded mid-cache-window after first synthesis.
    if (voice.tts.engine === 'kokoro') {
      const state = kokoroReadyState();
      cache.value.kokoro = { ok: state === 'loaded', state };
    }
    return cache.value;
  }

  // STT probes: whisper.cpp needs an HTTP health check; web-speech runs in
  // the browser so just report it as available.
  const probes = [probe(`${lmStudioBaseUrl()}/v1/models`)];
  const labels = ['lmstudio'];
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
