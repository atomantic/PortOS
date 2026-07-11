import { request } from './apiCore.js';

// Rounds workbench API surface (a cappella round writing + learning). Every
// helper takes an optional `options` arg so callers with their own `.catch`
// toast can pass `{ silent: true }` to avoid a double-toast (project
// convention). The id path param is URL-encoded.

const enc = encodeURIComponent;

export const listRounds = (options) => request('/rounds', options);

export const getRound = (id, options) => request(`/rounds/${enc(id)}`, options);

export const createRound = (body = {}, options) =>
  request('/rounds', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateRound = (id, patch, options) =>
  request(`/rounds/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch), ...options });

export const deleteRound = (id, options) =>
  request(`/rounds/${enc(id)}`, { method: 'DELETE', ...options });

// Reset a built-in default song's shipped content (metadata/lyrics/layers/
// references) to the current bundled template → { song }. Preserves the user's
// recordings + learned progress. 400 if the song isn't a built-in default.
export const refreshRoundTemplate = (id, options) =>
  request(`/rounds/${enc(id)}/refresh-template`, { method: 'POST', ...options });

// AI: draft a brand-new arrangement from a brief (no id, not persisted) →
// { song, llm }. body: { title?, artist?, brief?, mood?, providerId?, model? }.
export const generateRound = (body = {}, options) =>
  request('/rounds/generate', { method: 'POST', body: JSON.stringify(body), ...options });

// AI: expand/redraft an existing song → { song, llm }. Pass expandExisting:true
// to fold the stored draft into the prompt. Client merges the result; no save.
export const generateRoundFor = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/generate`, { method: 'POST', body: JSON.stringify(body), ...options });

// AI: critique a stored arrangement → { evaluation, llm }. Read-only server-side.
export const evaluateRound = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/evaluate`, { method: 'POST', body: JSON.stringify(body), ...options });

// AI: derive harmony parts (bass, mid/high harmonies) from the song's base
// melody → { scoreParts, llm }. Not persisted server-side; the client merges the
// returned parts into the editor draft and the user Saves. body: { partIds?,
// providerId?, model? } — partIds optionally restricts which harmony parts.
export const deriveRoundParts = (id, body = {}, options) =>
  request(`/rounds/${enc(id)}/derive-parts`, { method: 'POST', body: JSON.stringify(body), ...options });

// --- Reference-audio import (#2120) — download + extract a reference's audio
// from a URL via yt-dlp into the uploads dir. Kickoff returns { jobId }; progress
// streams over SSE (subscribe with useSseProgress); the terminal `complete` frame
// carries the { filename } the caller persists on the reference. Upload/mic
// capture remain the primary attach paths.
export const importReferenceAudio = (url, options = {}) =>
  request('/rounds/reference-audio/import', { method: 'POST', body: JSON.stringify({ url }), ...options });

export const referenceAudioImportEventsUrl = (jobId) =>
  `/api/rounds/reference-audio/import/${enc(jobId)}/events`;

export const cancelReferenceAudioImport = (jobId, options = {}) =>
  request(`/rounds/reference-audio/import/${enc(jobId)}/cancel`, { method: 'POST', ...options });

// --- Reference-audio → MIDI transcription (MuScriptor) — transcribe an attached
// reference audio file (an uploads basename) into a .mid via the local
// MuScriptor sidecar. Kickoff returns { jobId, model } (503 with an install
// hint when the runtime isn't provisioned); progress streams over SSE; the
// terminal `complete` frame carries the { filename } the caller persists on the
// reference (via the normal PUT on Save, same as the audio import above).
export const transcribeReferenceMidi = (filename, model, options = {}) =>
  request('/rounds/reference-audio/transcribe-midi', {
    method: 'POST', body: JSON.stringify(model ? { filename, model } : { filename }), ...options,
  });

export const referenceMidiTranscriptionEventsUrl = (jobId) =>
  `/api/rounds/reference-audio/transcribe-midi/${enc(jobId)}/events`;

export const cancelReferenceMidiTranscription = (jobId, options = {}) =>
  request(`/rounds/reference-audio/transcribe-midi/${enc(jobId)}/cancel`, { method: 'POST', ...options });
