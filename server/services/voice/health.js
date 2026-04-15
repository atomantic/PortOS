// Voice stack health checks — whisper.cpp + LM Studio + (when active) Piper.
// Kokoro runs in-process; readiness is reported via the in-memory model flag.

import { getVoiceConfig } from './config.js';
import { isReady as kokoroReady } from './tts-kokoro.js';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 3000;
let cache = null;

const probe = async (url) => {
  const started = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return { ok: true, status: res.status, latencyMs: Date.now() - started };
  } catch (err) {
    const name = err?.name || '';
    const code = err?.cause?.code || err?.code || '';
    if (name === 'AbortError') return { ok: false, state: 'timeout', latencyMs: Date.now() - started };
    if (code === 'ECONNREFUSED') return { ok: false, state: 'down', error: code };
    return { ok: false, state: 'error', error: err?.message || String(err) };
  } finally {
    clearTimeout(t);
  }
};

const lmStudioBaseUrl = () => (process.env.LM_STUDIO_URL || 'http://localhost:1234').replace(/\/+$/, '').replace(/\/v1$/, '');

export const checkAll = async (cfg) => {
  const voice = cfg || await getVoiceConfig();
  const cacheKey = `${voice.tts.engine}|${voice.stt.endpoint}`;
  if (cache && cache.key === cacheKey && Date.now() - cache.ts < CACHE_TTL_MS) {
    // Refresh kokoro readiness on every call — it's a cheap in-memory check
    // and flips from lazy → loaded mid-cache-window after first synthesis.
    if (voice.tts.engine === 'kokoro') {
      cache.value.kokoro = { ok: kokoroReady(), state: kokoroReady() ? 'loaded' : 'lazy' };
    }
    return cache.value;
  }

  const probes = [probe(voice.stt.endpoint), probe(`${lmStudioBaseUrl()}/v1/models`)];
  const labels = ['whisper', 'lmstudio'];

  if (voice.tts.engine === 'piper') {
    probes.push(probe(voice.tts.piper?.endpoint || 'http://127.0.0.1:5002'));
    labels.push('piper');
  }

  const results = await Promise.all(probes);
  const out = Object.fromEntries(labels.map((k, i) => [k, results[i]]));

  if (voice.tts.engine === 'kokoro') {
    out.kokoro = { ok: kokoroReady(), state: kokoroReady() ? 'loaded' : 'lazy' };
  }

  cache = { key: cacheKey, ts: Date.now(), value: out };
  return out;
};

export const invalidateHealthCache = () => { cache = null; };
