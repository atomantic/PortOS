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

// Align director lyric lines to the vocal (#9074). Body `{}` aligns every line;
// `{ cueId }` re-aligns one line. Resolves to the updated project. Runs only
// when the caller invokes it — there is no boot or import hook.
export const alignMusicVideoLyrics = (id, body = {}, options = {}) => request(`/music-video/${encodeURIComponent(id)}/lyrics/align`, {
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
// Split a shot its backend cannot render in one take on lyric/phrase
// boundaries (#8977) → { project, scenes }. `backend` omitted = project pin.
export const splitMusicVideoScene = (id, sceneId, backend, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}/split`, {
    method: 'POST', body: JSON.stringify(backend ? { backend } : {}), ...options,
  });
// Optional vocal stem (#8977): a full-length vocal bounce on the master's
// timebase that performance shots are conditioned on. Both → the project.
export const uploadMusicVideoVocalStem = (id, file, options = {}) => {
  const body = new FormData();
  body.append('stem', file, file.name || 'vocal-stem');
  return request(`/music-video/${encodeURIComponent(id)}/vocal-stem`, { method: 'POST', body, ...options });
};
export const removeMusicVideoVocalStem = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/vocal-stem`, { method: 'DELETE', ...options });

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
export const getMusicVideoCodeDocument = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/code/document`, options);
export const generateMusicVideoCode = (id, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/code/generate`, { method: 'POST', body: JSON.stringify(body), ...options });
export const regenerateMusicVideoCodeSection = (id, sectionId, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/code/sections/${encodeURIComponent(sectionId)}/regenerate`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

// EventSource URL for a render job's progress stream (consumed by useSseProgress).
export const musicVideoRenderEventsUrl = (jobId) =>
  `/api/music-video/render/${encodeURIComponent(jobId)}/events`;

export const cancelMusicVideoRender = (jobId, options = {}) =>
  request(`/music-video/render/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });

// ---- Draft excerpt render (#8986) ----
// A director-chosen [startSec, endSec) window re-rendered through the same
// composed pipeline, plus a cut/cue contact sheet and timecoded review notes.
// Kickoff resolves to { jobId, excerptId }; progress streams over its OWN SSE
// URL (subscribe with useSseProgress / useSseJobSlot).
export const renderMusicVideoExcerpt = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/excerpt`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const musicVideoExcerptRenderEventsUrl = (jobId) =>
  `/api/music-video/excerpt/${encodeURIComponent(jobId)}/events`;
export const cancelMusicVideoExcerptRender = (jobId, options = {}) =>
  request(`/music-video/excerpt/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });
export const deleteMusicVideoExcerpt = (id, excerptId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/excerpt/${encodeURIComponent(excerptId)}`, { method: 'DELETE', ...options });
// Body: { atSec, note, verdict? } → { project, note }.
export const addMusicVideoExcerptNote = (id, excerptId, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/excerpt/${encodeURIComponent(excerptId)}/notes`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
// Body: any of { atSec, note, verdict } → { project, note }.
export const updateMusicVideoExcerptNote = (id, excerptId, noteId, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/excerpt/${encodeURIComponent(excerptId)}/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH', body: JSON.stringify(body), ...options,
  });
export const deleteMusicVideoExcerptNote = (id, excerptId, noteId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/excerpt/${encodeURIComponent(excerptId)}/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE', ...options,
  });

// ---- Selective section revision (#8987) ----
// Reject a reviewed draft's flagged sections and regenerate only those.
// Start body: { sceneIds? } → { project, revision, skippedSceneIds }.
export const startMusicVideoRevision = (id, excerptId, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/excerpt/${encodeURIComponent(excerptId)}/revisions`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
// → { project, revision, needsGeneration, generating, render: { jobId, excerptId } | null }.
export const resumeMusicVideoRevision = (id, revisionId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/resume`, { method: 'POST', ...options });
export const cancelMusicVideoRevision = (id, revisionId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/cancel`, { method: 'POST', ...options });
// A generation kickoff that failed before reaching the queue (#9011): clears
// the section's claim so the next resume hands it out again immediately
// instead of waiting out the lease. Body: { sceneId } → { project, revision }.
export const releaseMusicVideoRevisionSection = (id, revisionId, sceneId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/release`, {
    method: 'POST', body: JSON.stringify({ sceneId }), ...options,
  });

// ---- Opt-in automatic review/retries (#8988) ----
// Start body: { startSec, endSec, limits: { maxAttempts, maxGenerations }, providerId?, model? }
// → { project, run }. The run then advances server-side and reports over the
// `music-video:auto-review` socket event.
export const startMusicVideoAutoReview = (id, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/auto-reviews`, { method: 'POST', body: JSON.stringify(body), ...options });
// Body: { limits?: { maxAttempts?, maxGenerations? } } — optionally RAISES the limits.
export const resumeMusicVideoAutoReview = (id, runId, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/auto-reviews/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: JSON.stringify(body), ...options });
export const stopMusicVideoAutoReview = (id, runId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/auto-reviews/${encodeURIComponent(runId)}/stop`, { method: 'POST', ...options });
export const cancelMusicVideoAutoReview = (id, runId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/auto-reviews/${encodeURIComponent(runId)}/cancel`, { method: 'POST', ...options });

// ---- Server-owned production run (#9066) ----
// Start body: { directive?, pool: [{ kind: 'image'|'video', mode, model? }], limits: { maxGenerations,
// maxReviewAttempts, spendCapUsd? }, providerId?, model? } → { project, run }. The run advances
// server-side and reports over the `music-video:production` socket event.
export const startMusicVideoProduction = (id, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/production-runs`, { method: 'POST', body: JSON.stringify(body), ...options });
// Body: { limits?: partial limits (may only RAISE), acceptBasis?: true } — acceptBasis continues a run halted `needs-replan`.
export const resumeMusicVideoProduction = (id, runId, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/production-runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: JSON.stringify(body), ...options });
export const stopMusicVideoProduction = (id, runId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/production-runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', ...options });
export const cancelMusicVideoProduction = (id, runId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/production-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', ...options });

// ---- Pre-production treatment (#8980) ----
// A structured brief, a compiled whole-song arc, per-shot direction keyed to the
// board's scene ids and a proof checklist. Every write names the treatment
// revision it was made against; a stale one is a 409 (`TREATMENT_REVISION_CONFLICT`).
export const getMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, options);
// Body: { baseRevision, brief?, beats?, motifs?, shotDirections?, rebase? } → { project, treatment }.
export const updateMusicVideoTreatment = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/treatment`, {
  method: 'PATCH', body: JSON.stringify(body), ...options,
});
// Explicit user action. Body: { baseRevision, useAi?, providerId?, model? }
// → { project, treatment, aiUsed, aiSkippedReason }.
export const compileMusicVideoTreatment = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/treatment/compile`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});
// Read-only → { revision, stale, blocked, scenes, missingSceneIds, unmappedSceneIds, textCueCandidates }.
export const previewMusicVideoTreatmentApply = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/treatment/apply-preview`, options);
// Body: { revision, overwrite?: [{ sceneId, promptFingerprint }], addTextCues? } → { project, result }.
export const applyMusicVideoTreatment = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/treatment/apply`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});
// Body: { baseRevision, status, evidence?: { videoHistoryId?, imageId?, note } } → { project, treatment }.
export const reviewMusicVideoTreatmentProof = (id, proofId, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/treatment/proofs/${encodeURIComponent(proofId)}/review`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
