/**
 * API client for on-device music generation: engines and readiness, designer AI describe/lyrics steps,
 * Strudel and waveform LLM calls, and previews.
 *
 * On-device music generation (MusicGen / AudioLDM2 / ACE-Step): list engines (+ readiness), the
 * stepped designer's AI describe/lyrics steps, the drawn-waveform and Strudel-code engines' LLM calls,
 * preview the local caption and labeled additions, generate a track from a prompt/lyrics, and the
 * SuperCollider runtime (status, setup, render, cancel).
 */

import { request } from './apiCore.js';
import { openStreamResponse, readStreamFrames } from './streamResponse.js';

// ---- Music generation (on-device) ----
// The Music studio's generator surface over server/services/pipeline/musicGen.js
// (MusicGen / AudioLDM2 / ACE-Step behind one contract). `options` lets a caller
// suppress request()'s auto-toast with `{ silent: true }`.

// List selectable engines with their models, duration window, lyric capability,
// and a `ready` flag (the opt-in venv is provisioned) → { engines, defaultEngine }.
export const listMusicEngines = (options = {}) => request('/music/engines', options);

// Generate a queued track job. body: { prompt, lyrics?, instrumentalOnly?, engine?, modelId?,
// durationSec?, durationMode?: 'auto'|'manual', mediaProviderPeerId?,
// remoteMusicProfile?: { style, mood, tempo?, energy?, instruments? },
// trackId? (update) | title?/artistId?/artist?/albumId? (create) }. Resolves to
// { jobId, position, status }; callers watch the shared media-job SSE lifecycle.
// A remote peer id requires an explicit engine, model, and fixed-vocabulary
// instrumental profile. The free-form prompt remains local; non-empty remote
// lyrics are rejected.
export const generateMusic = (body, requestOptions = {}) => request('/music/generate', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// Preview the local audio caption without starting a render.
export const previewMusicPrompt = (body, options = {}) => request('/music/prompt-preview', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// ---- Stepped music designer (#4305) ----
// Both fire one LLM call each and are only ever invoked from an explicit button
// press in the designer wizard. Callers own their loading/error UI, so pass
// `{ silent: true }`.

// Expand a short reference/vibe into a rich musical description.
// body: { concept, guidance?, template?, providerId?, model?, effort? }
// → { description, llm: { provider, model } }
export const describeMusic = (body, requestOptions = {}) => request('/music/describe', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// Write original lyrics from an enriched description (+ optional guidance).
// body: { description, guidance?, template?, providerId?, model?, effort? }
// → { lyrics, llm: { provider, model } }
export const generateLyrics = (body, requestOptions = {}) => request('/music/lyrics', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// Have the LLM write the piece as Strudel code (the Music Designer's code
// engine). Nothing runs server-side; the browser plays it in a sandboxed frame.
// body: { description, lyrics?, scene? (animation script), durationSec?,
// guidance?, current? (code to revise), language?, providerId?, model?, effort? }
// → { language, code, llm }
export const writeMusicCode = (body, requestOptions = {}) => request('/music/code', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});
// The prompt writeMusicCode would send; no provider call.
export const previewMusicCode = (body, options = {}) => request('/music/code/preview', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// De-register a user-installed model (id is the HF repo id) → { removed }.
export const removeAudioModel = (engine, id, requestOptions = {}) =>
  request(`/music/models/${encodeURIComponent(engine)}/${id.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
    ...requestOptions,
  });

// Install an additional audio model from HuggingFace into an engine. The server
// streams the download as Server-Sent Events and invokes
// `onEvent({ type, progress, message, ... })` per frame, resolving only after a
// complete frame. Error frames or interrupted streams reject.
export const installAudioModel = ({ engine, repo, name }, onEvent) => postForSseFrames('/api/music/models', { engine, repo, name }, onEvent);

async function postForSseFrames(url, payload, onEvent) {
  const response = await openStreamResponse(fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  const completed = await readStreamFrames(response, {
    format: 'sse',
    fatal: true,
    onFrame: ({ data }) => {
      if (!data) return false;
      const event = JSON.parse(data);
      if (!event || typeof event !== 'object') return false;
      onEvent?.(event);
      if (event.type === 'error') throw new Error(event.message || event.error || 'Installation failed');
      return event.type === 'complete';
    },
  }).catch((cause) => {
    if (cause?.code !== 'INVALID_STREAM_UTF8') throw cause;
    throw new Error('Installation stream contained invalid UTF-8. Check installation status before retrying.', { cause });
  });
  if (!completed) throw new Error('Installation connection ended before completion. Check installation status before retrying.');
}

// ---- SuperCollider (contained offline renders for the Code engine, #9414) ----
// Readiness is read-only: status never builds or renders. → { state, ready, message, action, ... }.
export const getSuperColliderStatus = (requestOptions = {}) => request('/music/supercollider/status', requestOptions);

// Explicit setup (builds the managed image, 10–30 min first time). Streams
// { type: 'log' | 'complete' | 'error', ... } frames to `onEvent`.
export const setupSuperCollider = ({ rebuild = false } = {}, onEvent) => postForSseFrames('/api/music/supercollider/setup', { rebuild }, onEvent);

// Queue a render of the editor's source → { jobId, position, status, seed, sourceHash }.
// body: { code, durationSec, seed? }. 409 SUPERCOLLIDER_UNAVAILABLE when not ready.
export const renderSuperCollider = (body, requestOptions = {}) => request('/music/supercollider/render', {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// SSE path for a render's progress (feed it to useSseProgress); cancel stops the container.
export const superColliderRenderEventsUrl = (jobId) => `/api/music/supercollider/renders/${encodeURIComponent(jobId)}/events`;
export const cancelSuperColliderRender = (jobId, requestOptions = {}) => request(`/music/supercollider/renders/${encodeURIComponent(jobId)}/cancel`, {
  method: 'POST',
  ...requestOptions,
});
