import { request, maybeRedirectToLogin } from './apiCore.js';

// ---- Music generation (on-device) ----
// The Music studio's generator surface over server/services/pipeline/musicGen.js
// (MusicGen / AudioLDM2 / ACE-Step behind one contract). `options` lets a caller
// suppress request()'s auto-toast with `{ silent: true }`.

// List selectable engines with their models, duration window, lyric capability,
// and a `ready` flag (the opt-in venv is provisioned) → { engines, defaultEngine }.
export const listMusicEngines = (options = {}) => request('/music/engines', options);

// Generate a track. body: { prompt, lyrics?, engine?, modelId?, durationSec?,
// trackId? (update) | title?/artistId?/artist?/albumId? (create) }. Resolves to
// { track, filename, durationSec, engine, modelId }. Long renders hold the
// request open — callers should own their loading UI and pass `{ silent: true }`.
export const generateMusic = (body, requestOptions = {}) => request('/music/generate', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// The merged shipped+user model list for one engine → { models }.
export const listEngineModels = (engine, options = {}) => request(`/music/models/${encodeURIComponent(engine)}`, options);

// De-register a user-installed model (id is the HF repo id) → { removed }.
export const removeAudioModel = (engine, id, requestOptions = {}) =>
  request(`/music/models/${encodeURIComponent(engine)}/${id.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
    ...requestOptions,
  });

// Install an additional audio model from HuggingFace into an engine. The server
// streams the download as Server-Sent Events; this helper drives an EventSource
// and invokes `onEvent({ type, progress, message, ... })` per frame, resolving
// when the stream ends. (POST-with-SSE: we use fetch + a manual reader since
// EventSource is GET-only.) Returns a Promise<void>.
export async function installAudioModel({ engine, repo, name }, onEvent) {
  const res = await fetch('/api/music/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, repo, name }),
  });
  if (!res.ok || !res.body) {
    // This streaming fetch bypasses request(), so it must honor session expiry
    // itself (apiCore contract): on a 401 AUTH_REQUIRED, redirect to /login like
    // request() does instead of surfacing raw error text in the panel.
    const raw = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    // Match request()'s convention: the parsed body IS the error object (code at
    // top level). maybeRedirectToLogin bounces to /login on 401 AUTH_REQUIRED.
    maybeRedirectToLogin(res, parsed || {});
    throw new Error((typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message) || raw || `Install failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { onEvent?.(JSON.parse(line.slice('data:'.length).trim())); } catch { /* ignore malformed frame */ }
    }
  }
}
