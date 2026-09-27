import { request } from './apiCore.js';

// Music Video production mode (#1760). Director scene-board project CRUD + the
// offline beat/tempo/section analysis. `options` lets a caller suppress
// request()'s auto-toast with `{ silent: true }` when it owns its own error UI.

export const listMusicVideoProjects = (options = {}) => request('/music-video', options);
export const createMusicVideoProject = (data, options = {}) => request('/music-video', {
  method: 'POST', body: JSON.stringify(data), ...options,
});
export const cloneMusicVideoProject = (id, data = {}, options = {}) => request(`/music-video/${encodeURIComponent(id)}/clone`, {
  method: 'POST', body: JSON.stringify(data), ...options,
});
export const updateMusicVideoProject = (id, patch, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, {
  method: 'DELETE', ...options,
});

// Run the offline analyzer on the project's audio and cache the result. Returns
// the updated project (with `audioAnalysis` populated).
export const analyzeMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/analyze`, {
  method: 'POST', ...options,
});

// Manual-tempo fallback: supply a known BPM + first-downbeat offset by ear
// when auto-detect caches `audioAnalysis.bpm === null` (see
// server/services/musicVideo/audioAnalysis.js for why). Returns the updated
// project with the same audioAnalysis shape the auto path produces.
export const setMusicVideoManualTempo = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/analyze/manual`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Autonomous shot planner (#1855, multi-shot #8964): tile each analyzed
// section with bounded shots (cut on lyric lines / phrases / beats) and seed
// them onto the board. `seedPrompts` (default true) also
// best-effort asks the active provider for a first-pass framePrompt/prompt
// per scene. Returns `{ project, scenesAdded, promptsSeeded, promptsSkippedReason, pacing }`.
export const planMusicVideoProject = (id, body = {}, options = {}) => request(`/music-video/${encodeURIComponent(id)}/plan`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Import timed lyric cues (#8964) from pasted LRC / SRT / WebVTT / plain lines.
// Body: { text, format?: 'auto'|'lrc'|'srt'|'text', mode?: 'replace'|'append' }.
// Resolves to { project, imported, format }.
export const importMusicVideoLyrics = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/lyrics/import`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// ---- Director scene board ----
export const addMusicVideoScene = (id, scene, options = {}) => request(`/music-video/${encodeURIComponent(id)}/scenes`, {
  method: 'POST', body: JSON.stringify(scene), ...options,
});
export const updateMusicVideoScene = (id, sceneId, patch, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH', body: JSON.stringify(patch), ...options,
  });
export const deleteMusicVideoScene = (id, sceneId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'DELETE', ...options,
  });
export const reorderMusicVideoScenes = (id, sceneIds, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/reorder`, {
    method: 'POST', body: JSON.stringify({ sceneIds }), ...options,
  });

// ---- Scene takes (#8965) ----
// Every render/import for a scene slot is an immutable take; the scene's
// referenceImageId / videoHistoryId is the explicit selection among them.
// addMusicVideoSceneTake body: { kind: 'image'|'video', assetId, source?, provider?, originalName? }
// → { scene, take }. select / review resolve to the updated scene.
const takesPath = (id, sceneId) => `/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}/takes`;
export const addMusicVideoSceneTake = (id, sceneId, body, options = {}) => request(takesPath(id, sceneId), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const selectMusicVideoSceneTake = (id, sceneId, takeId, options = {}) =>
  request(`${takesPath(id, sceneId)}/${encodeURIComponent(takeId)}/select`, { method: 'POST', ...options });
export const reviewMusicVideoSceneTake = (id, sceneId, takeId, review, options = {}) =>
  request(`${takesPath(id, sceneId)}/${encodeURIComponent(takeId)}`, {
    method: 'PATCH', body: JSON.stringify(review), ...options,
  });

// ---- External-asset handoff (#8965) ----
// Export the per-scene prompt/reference manifest for a tool PortOS doesn't
// drive (e.g. Midjourney), and import what was generated there. Import body:
// { provider, items: [{ kind, assetId, sceneId?, originalName? }] } where each
// asset was already stored through the gallery upload routes; resolves to
// { project, imported, skipped }.
export const getMusicVideoHandoff = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/handoff`, options);
// The downloadable ZIP counterpart (#8978) — manifest.json plus reference
// images and each scene's selected frame. Resolves to an ArrayBuffer; wrap it
// in downloadBlob(..., 'application/zip') to trigger the save.
export const getMusicVideoHandoffBundle = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/handoff/bundle`, {
  responseType: 'arraybuffer', ...options,
});
export const importMusicVideoHandoff = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/handoff/import`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// ---- Audio → MIDI transcription (MuScriptor) ----
// Transcribe the project's source audio into a .mid via the local MuScriptor
// sidecar. Kickoff resolves to { jobId, model } (503 with an install hint when
// the runtime isn't provisioned). Progress streams over SSE; the terminal
// `complete` frame carries the server-persisted `midiTranscription` pointer.
export const transcribeMusicVideoMidi = (id, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/transcribe-midi`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

export const musicVideoMidiEventsUrl = (jobId) =>
  `/api/music-video/transcribe-midi/${encodeURIComponent(jobId)}/events`;

export const cancelMusicVideoMidiTranscription = (jobId, options = {}) =>
  request(`/music-video/transcribe-midi/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });

// ---- Render (#1760, Phase 2) ----
// Kick off the master-bed render; resolves to { jobId }. Progress streams over
// the SSE URL below (subscribe with useSseProgress). cancel stops an in-flight job.
export const renderMusicVideoProject = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/render`, { method: 'POST', ...options });

// EventSource URL for a render job's progress stream (consumed by useSseProgress).
export const musicVideoRenderEventsUrl = (jobId) =>
  `/api/music-video/render/${encodeURIComponent(jobId)}/events`;

export const cancelMusicVideoRender = (jobId, options = {}) =>
  request(`/music-video/render/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });
