import { request } from './apiCore.js';

// Music Video production mode (#1760). Director scene-board project CRUD + the
// offline beat/tempo/section analysis. `options` lets a caller suppress
// request()'s auto-toast with `{ silent: true }` when it owns its own error UI.

// Bounded, newest-first summary page (#10169) — `{ items, total, nextCursor }`
// for the index and header picker, never the full project records.
export const listMusicVideoProjectSummaries = ({ cursor, limit } = {}, options = {}) => {
  const query = new URLSearchParams({ summary: '1' });
  if (limit != null) query.set('limit', String(limit));
  if (cursor != null) query.set('cursor', String(cursor));
  return request(`/music-video?${query}`, options);
};
// Newest MIDI transcription per track — bounded projection for the Tracks page (#10203).
export const listMusicVideoMidiSources = (options = {}) => request('/music-video/midi-sources', options);
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

// Import the linked track's lyric sheet: its lines become the project's lyric
// cues and its `[Chorus]`/`[Spoken, close]` tags become lyric markers.
// Body `{ mode?: 'replace' | 'if-empty' }` — `if-empty` never replaces lines.
// Resolves to { project, imported, markers, skipped }.
export const importMusicVideoTrackLyrics = (id, body = {}, options = {}) => request(`/music-video/${encodeURIComponent(id)}/lyrics/import-track`, {
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
// Separate the vocal out of the song with demucs and attach it as the stem.
// Kickoff resolves to { jobId }; the terminal `complete` frame carries the
// updated project. The first run installs demucs, so it can take minutes.
export const separateMusicVideoVocals = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/vocal-stem/separate`, { method: 'POST', body: '{}', ...options });
export const musicVideoVocalSeparationEventsUrl = (jobId) =>
  `/api/music-video/vocal-stem/separate/${encodeURIComponent(jobId)}/events`;
export const cancelMusicVideoVocalSeparation = (jobId, options = {}) =>
  request(`/music-video/vocal-stem/separate/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });

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
// Read-only: resolves { jobId } of the project's live final render on this
// install (null when none) so a reloaded page can re-attach to its progress
// stream. Never starts a render — only the POST above does (#9940).
export const getMusicVideoActiveRender = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/render`, options);
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
// #9280: the song windows most likely to work as a vertical social cut —
// { suggestions: [{ startSec, endSec, score, label, reasons }] }.
export const getMusicVideoSocialCuts = (id, { count, minSec, maxSec } = {}, options = {}) => {
  const params = new URLSearchParams();
  if (count != null) params.set('count', String(count));
  if (minSec != null) params.set('minSec', String(minSec));
  if (maxSec != null) params.set('maxSec', String(maxSec));
  const qs = params.toString();
  return request(`/music-video/${encodeURIComponent(id)}/social-cuts${qs ? `?${qs}` : ''}`, options);
};
// ---- Publishing kit (#9281) ----
// Build: platform encodes, thumbnails, captions and chapters from the final
// render → { jobId } (progress over its own SSE URL). Copy: one provider draft,
// then per-field edits; both resolve to { project }.
export const buildMusicVideoPublishKit = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish-kit/build`, { method: 'POST', ...options });
export const musicVideoPublishKitEventsUrl = (jobId) => `/api/music-video/publish-kit/${encodeURIComponent(jobId)}/events`;
export const cancelMusicVideoPublishKit = (jobId, options = {}) =>
  request(`/music-video/publish-kit/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });
export const draftMusicVideoPublishCopy = (id, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish-kit/copy`, { method: 'POST', body: JSON.stringify(body || {}), ...options });
export const updateMusicVideoPublishCopy = (id, patch, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish-kit/copy`, { method: 'PATCH', body: JSON.stringify(patch || {}), ...options });
export const selectMusicVideoPublishThumbnail = (id, filename, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish-kit/thumbnail`, { method: 'PUT', body: JSON.stringify({ filename }), ...options });
// ---- Posting (#9282) ----
// Prepare fills the platform's post in the PortOS Browser → { draftId, target,
// summary, screenshot }. Manual posting is handled outside this wrapper.
export const prepareMusicVideoPublishDraft = (id, target, options = {}, reqOptions = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish/${encodeURIComponent(target)}/prepare`, { method: 'POST', body: JSON.stringify(options || {}), ...reqOptions });
// A project's live drafts (state 'open' | 'closed') so a reloaded card rehydrates → { drafts }.
export const getMusicVideoPublishDrafts = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish/drafts`, options);
export const discardMusicVideoPublishDraft = (id, draftId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE', ...options });
// Where the director posts (#9287): { platforms, history } and platform toggles;
// a post's link, reception and notes → { project, post }.
export const getMusicVideoPublishPlatforms = (options = {}) => request('/music-video/publish/platforms', options);
export const updateMusicVideoPublishPlatforms = (patch, options = {}) =>
  request('/music-video/publish/platforms', { method: 'PUT', body: JSON.stringify(patch || {}), ...options });
export const recordMusicVideoPublishPost = (id, target, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/publish/posts/${encodeURIComponent(target)}`, { method: 'PUT', body: JSON.stringify(body || {}), ...options });
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

// ---- Fully-autonomous run: one prompt → lyrics → Suno song → video ----
// Start body: { prompt, tools?, models?, budgetUsd?, limits?, checkpoints?, instrumental?, guidance?,
// providerId?, model?, authoring? } → 202 { project, run }. The run advances server-side and reports
// over the `music-video:autonomous` socket event. Resume approves the checkpoint it waits on (optionally
// with edited { lyrics, style }) or retries the stage that stopped.
export const startAutonomousMusicVideo = (body, options = {}) =>
  request('/music-video/autonomous', { method: 'POST', body: JSON.stringify(body), ...options });
export const resumeAutonomousMusicVideo = (id, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/autonomous/resume`, { method: 'POST', body: JSON.stringify(body), ...options });
export const stopAutonomousMusicVideo = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/autonomous/stop`, { method: 'POST', ...options });
export const cancelAutonomousMusicVideo = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/autonomous/cancel`, { method: 'POST', ...options });

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

// ---- Development artifacts ("ingredients") ----
// Reviewable development files attached to a project: a Cast & Sets sheet, an
// animatic, a treatment, a storyboard. Every write resolves to `{ project, artifact }`.
const devArtifactsPath = (id) => `/music-video/${encodeURIComponent(id)}/dev-artifacts`;
// The served file (sandboxed HTML, Markdown as text, media). `version` null = current.
export const musicVideoDevArtifactFileUrl = (id, artifactId, version = null) =>
  `/api/music-video/${encodeURIComponent(id)}/dev-artifacts/${encodeURIComponent(artifactId)}/file${version ? `?version=${encodeURIComponent(version)}` : ''}`;
// `fields`: { kind, title } for a new artifact, or { artifactId } for a new version.
export const uploadMusicVideoDevArtifact = (id, file, fields = {}, options = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== '') body.append(key, value);
  }
  body.append('file', file, file.name || 'artifact');
  return request(devArtifactsPath(id), { method: 'POST', body, ...options });
};
export const addMusicVideoDevArtifactNote = (id, artifactId, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dev-artifacts/${encodeURIComponent(artifactId)}/notes`, { method: 'POST', body: JSON.stringify(body), ...options });
export const resolveMusicVideoDevArtifactNote = (id, artifactId, noteId, resolved, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dev-artifacts/${encodeURIComponent(artifactId)}/notes/${encodeURIComponent(noteId)}`, { method: 'PATCH', body: JSON.stringify({ resolved }), ...options });
// Body: { status: 'approved' | 'changes-requested' | 'pending', note? }.
export const reviewMusicVideoDevArtifact = (id, artifactId, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dev-artifacts/${encodeURIComponent(artifactId)}/review`, { method: 'POST', body: JSON.stringify(body), ...options });
export const deleteMusicVideoDevArtifact = (id, artifactId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dev-artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE', ...options });

// ---- Cast & Sets check-in (before the shot plan) ----
// Start / regenerate / resume return at once (`{ project, stage }`); the stage
// advances server-side and reports over the `music-video:cast-and-sets` socket event.
export const startMusicVideoCastAndSets = (id, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets`, { method: 'POST', body: JSON.stringify(body), ...options });
// Body: { notes?: [{ text, target? }] } — omitted notes = the sheet's open notes.
export const regenerateMusicVideoCastAndSets = (id, body = {}, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets/regenerate`, { method: 'POST', body: JSON.stringify(body), ...options });
// Body: { protagonist?, world?, sets?: [{ id, imageRole }] } — the director's direct edits to a procedural direction.
export const editMusicVideoCastAndSetsDirection = (id, body, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets/direction`, { method: 'PATCH', body: JSON.stringify(body), ...options });
export const resumeMusicVideoCastAndSets = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets/resume`, { method: 'POST', body: '{}', ...options });
export const approveMusicVideoCastAndSets = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets/approve`, { method: 'POST', ...options });
export const skipMusicVideoCastAndSets = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/cast-and-sets/skip`, { method: 'POST', ...options });

// ---- Composition document (render style `document`) ----
// A project-owned HTML composition document rendered over the song. Imports
// resolve to `{ project, document }`; the manifest to `{ document, available,
// files, totalBytes }`; the preview to `{ html, assets, width, height, fps, durationSec }`.
const compositionDocumentPath = (id) => `/music-video/${encodeURIComponent(id)}/composition/document`;
export const getMusicVideoCompositionDocument = (id, options = {}) => request(compositionDocumentPath(id), options);
export const importMusicVideoCompositionZip = (id, file, options = {}) => {
  const body = new FormData();
  body.append('file', file, file.name || 'composition.zip');
  return request(`${compositionDocumentPath(id)}/zip`, { method: 'POST', body, ...options });
};
export const importMusicVideoCompositionDirectory = (id, directory, options = {}) =>
  request(`${compositionDocumentPath(id)}/directory`, { method: 'POST', body: JSON.stringify({ directory }), ...options });
export const startMusicVideoCompositionTemplate = (id, template = 'layered', options = {}) =>
  request(`${compositionDocumentPath(id)}/template`, { method: 'POST', body: JSON.stringify({ template }), ...options });
export const getMusicVideoCompositionExport = (id, options = {}) =>
  request(`${compositionDocumentPath(id)}/export`, { responseType: 'arraybuffer', ...options });
export const getMusicVideoCompositionPreview = (id, { draft = false, ...options } = {}) => request(`${compositionDocumentPath(id)}/preview${draft ? '?draft=1' : ''}`, options);
export const generateMusicVideoMixedMediaDocument = (id, body, options = {}) =>
  request(`${compositionDocumentPath(id)}/generate`, { method: 'POST', body: JSON.stringify(body || {}), ...options });
export const getMusicVideoMixedMediaCandidate = (id, options = {}) => request(`${compositionDocumentPath(id)}/candidate`, options);
export const reviseMusicVideoMixedMediaEvents = (id, body, options = {}) =>
  request(`${compositionDocumentPath(id)}/events/revise`, { method: 'POST', body: JSON.stringify(body), ...options });
export const regenerateMusicVideoMixedMediaSection = (id, sectionId, body, options = {}) =>
  request(`${compositionDocumentPath(id)}/sections/${encodeURIComponent(sectionId)}/regenerate`, { method: 'POST', body: JSON.stringify(body), ...options });
export const acceptMusicVideoMixedMediaDocument = (id, directory, options = {}) =>
  request(`${compositionDocumentPath(id)}/accept`, { method: 'POST', body: JSON.stringify({ directory }), ...options });
export const discardMusicVideoMixedMediaDocument = (id, directory, options = {}) =>
  request(`${compositionDocumentPath(id)}/candidate`, { method: 'DELETE', body: JSON.stringify({ directory }), ...options });
export const detachMusicVideoCompositionDocument = (id, options = {}) =>
  request(compositionDocumentPath(id), { method: 'DELETE', ...options });
// One preview asset (a scene take under /data, or a document file) as a Blob the
// page posts into the sandboxed preview, which cannot fetch anything itself.
export async function fetchMusicVideoPreviewAsset(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load preview media (${response.status})`);
  return response.blob();
}


export const getMusicVideoDependencyImpact = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dependency-impact`, options);
export const startMusicVideoDependencyRepair = (id, basis, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/dependency-repairs`, { method: 'POST', body: JSON.stringify({ basis }), ...options });

export const repairMusicVideoPerformance = (id, sceneId, input, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}/performance-repair`, {
    method: 'POST', body: JSON.stringify(input), ...options,
  });

export const previewMusicVideoAudioTiming = (id, data, options = {}) => request(`/music-video/${encodeURIComponent(id)}/audio-timing/preview`, {
  method: 'POST', body: JSON.stringify(data), ...options,
});
export const applyMusicVideoAudioTiming = (id, data, options = {}) => request(`/music-video/${encodeURIComponent(id)}/audio-timing/apply`, {
  method: 'POST', body: JSON.stringify(data), ...options,
});

// Human-reviewed production planning and proof. These never accept approval state in a project PATCH.
export const getMusicVideoProductionReview = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review`, options);
export const reverifyMusicVideoAlignment = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/alignment`, { method: 'POST', body: JSON.stringify(body), ...options });
export const saveMusicVideoProductionDraft = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review`, { method: 'PUT', body: JSON.stringify(body), ...options });
export const prepareMusicVideoProductionReview = (id, body = {}, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/prepare`, { method: 'POST', body: JSON.stringify(body), ...options });
export const approveMusicVideoProductionReview = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/approve`, { method: 'POST', body: JSON.stringify(body), ...options });
export const renderMusicVideoProductionProof = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/proof`, { method: 'POST', body: JSON.stringify(body), ...options });
export const importMusicVideoProductionPlanning = (id, source, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/import`, { method: 'POST', body: JSON.stringify({ source }), ...options });
export const bindMusicVideoProductionShot = (id, shotId, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/shots/${encodeURIComponent(shotId)}/bind`, { method: 'POST', ...options });

export const addMusicVideoProductionFeedback = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/feedback`, { method: 'POST', body: JSON.stringify(body), ...options });
export const reviseMusicVideoProductionFromFeedback = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/revise`, { method: 'POST', body: JSON.stringify(body), ...options });
export const resolveMusicVideoProductionFeedback = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/feedback/resolve`, { method: 'POST', body: JSON.stringify(body), ...options });
// Drafting is free; generation and candidate selection are separate explicit actions.
export const saveMusicVideoSongRevision = (id, fields, options = {}) => request(`/music-video/${encodeURIComponent(id)}/song-revision`, { method: 'POST', body: JSON.stringify(fields), ...options });
export const actOnMusicVideoSongRevision = (id, action, data, options = {}) => {
  const config = { method: 'POST', body: JSON.stringify(data), ...options };
  if (action === 'generate') return request(`/music-video/${encodeURIComponent(id)}/song-revision/generate`, config);
  if (action === 'cancel') return request(`/music-video/${encodeURIComponent(id)}/song-revision/cancel`, config);
  if (action === 'select') return request(`/music-video/${encodeURIComponent(id)}/song-revision/select`, config);
  return Promise.reject(new Error('Unknown song revision action'));
};

export const importMusicVideoDocumentShots = (id, body, options = {}) => request(`/music-video/${encodeURIComponent(id)}/production-review/document-shots`, { method: 'POST', body: JSON.stringify(body), ...options });
