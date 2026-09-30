/**
 * Music Video Routes — REST surface for the director scene board (#1760, Phase 1).
 *
 * Project CRUD + per-scene board operations + a synchronous beat/tempo/section
 * analysis endpoint that runs the offline analyzer (Phase 0) on the project's
 * audio. Per-scene reference-frame + i2v generation and the beat-snapped render
 * are filed follow-ups; this surface covers the director MVP up to "scenes
 * arranged against the beat grid".
 */

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  musicVideoProjectCreateSchema,
  musicVideoProjectCloneSchema,
  musicVideoProjectUpdateSchema,
  musicVideoSceneCreateSchema,
  musicVideoSceneUpdateSchema,
  musicVideoSceneReorderSchema,
  musicVideoSceneSplitSchema,
  musicVideoPlanRequestSchema,
  musicVideoManualAnalysisSchema,
  musicVideoTranscribeMidiRequestSchema,
  musicVideoLyricsImportSchema,
  musicVideoLyricsImportTrackSchema,
  musicVideoLyricsAlignSchema,
  musicVideoTakeInputSchema,
  musicVideoTakeReviewSchema,
  musicVideoHandoffImportSchema,
  musicVideoTreatmentUpdateSchema,
  musicVideoTreatmentCompileSchema,
  musicVideoTreatmentApplySchema,
  musicVideoTreatmentProofReviewSchema,
  musicVideoExcerptRequestSchema,
  musicVideoCodeGenerateSchema,
  musicVideoExcerptNoteSchema,
  musicVideoExcerptNoteUpdateSchema,
  musicVideoRevisionStartSchema,
  musicVideoRevisionReleaseSchema,
  musicVideoAutoReviewStartSchema,
  musicVideoAutoReviewResumeSchema,
  musicVideoProductionStartSchema,
  musicVideoProductionResumeSchema,
  musicVideoDevArtifactImportSchema,
  musicVideoDevArtifactNoteSchema,
  musicVideoDevArtifactNoteUpdateSchema,
  musicVideoDevArtifactReviewSchema,
  musicVideoDevArtifactFileQuerySchema,
  musicVideoCastAndSetsStartSchema,
  musicVideoCastAndSetsRegenerateSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import { recordRenderPinFields } from '../lib/sharedSchemas.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { resolveGalleryImage } from '../lib/pathSafety.js';
import { uploadSingle } from '../lib/multipart.js';
import { isSupportedMusicUpload, MUSIC_UPLOAD_MAX_BYTES } from '../services/pipeline/musicLibrary.js';
import { attachVocalStem, detachVocalStem } from '../services/musicVideo/vocalStem.js';
import {
  listProjects,
  getProject,
  createProject,
  cloneProject,
  updateProject,
  deleteProject,
  setProjectAnalysis,
  addProjectScene,
  updateScene,
  deleteScene,
  reorderProjectScenes,
  splitProjectScene,
  setProjectMidiTranscription,
  appendSceneTakes,
  appendTakesAcrossScenes,
  selectSceneTake,
  reviewSceneTake,
} from '../services/musicVideo/projects.js';
import { buildHandoffManifest, buildHandoffBundle, matchSceneByFileTag } from '../services/musicVideo/handoff.js';
import { getHistoryItem } from '../services/videoGen/history.js';
import {
  startMidiTranscription,
  attachMidiTranscriptionSseClient,
  cancelMidiTranscription,
} from '../services/audioMidiTranscription.js';
import { analyzeAudioFile, analyzeAudioFileManual, buildManualAnalysisFromCached } from '../services/musicVideo/audioAnalysis.js';
import { renderMusicVideo, attachRenderSseClient, cancelRender } from '../services/musicVideo/render.js';
import { prepareCodeRender } from '../services/musicVideo/codeRender.js';
import { generateMusicVideoCode, regenerateMusicVideoCodeSection } from '../services/musicVideo/codeGeneration.js';
import { startExcerptRender, attachExcerptRenderSseClient, cancelExcerptRender } from '../services/musicVideo/excerptRender.js';
import { deleteExcerpt, addReviewNote, editReviewNote, deleteReviewNote } from '../services/musicVideo/excerptService.js';
import {
  startRevision, resumeRevision, cancelRevision, releaseRevisionSection,
} from '../services/musicVideo/revisionService.js';
import {
  startAutoReview, resumeAutoReview, stopAutoReview, cancelAutoReview,
} from '../services/musicVideo/autoReviewService.js';
import {
  startProduction, resumeProduction, stopProduction, cancelProduction, getProduction,
} from '../services/musicVideo/productionService.js';
import { planProject } from '../services/musicVideo/planner.js';
import { parseLyricCues } from '../services/musicVideo/timedText.js';
import { alignProjectLyrics } from '../services/musicVideo/lyricAlign.js';
import { importTrackLyrics, MAX_LYRIC_CUES } from '../services/musicVideo/trackLyrics.js';
import { offsetLyricMarkers, relabelAnalysisSections } from '../services/musicVideo/lyricMarkers.js';
import {
  updateTreatment,
  compileTreatment,
  previewTreatmentApply,
  applyTreatment,
  reviewProof,
} from '../services/musicVideo/treatmentService.js';
import { getTrack } from '../services/tracks/index.js';
import {
  listDevArtifacts,
  getDevArtifact,
  importDevArtifact,
  resolveDevArtifactDownload,
  addNote as addDevArtifactNote,
  setNoteResolved as setDevArtifactNoteResolved,
  reviewArtifact as reviewDevArtifact,
  removeDevArtifact,
} from '../services/musicVideo/devArtifactService.js';
import { devArtifactTypeFor } from '../services/musicVideo/devArtifacts.js';
import {
  startCastAndSets,
  regenerateCastAndSets,
  resumeCastAndSets,
  approveCastAndSets,
  skipCastAndSets,
  getCastAndSets,
} from '../services/musicVideo/castAndSetsService.js';

const router = Router();

// #3231 Phase 4 — the per-record image render pin (`imageMode`/`imageModelId`,
// the shared universe/series/sprite field pair) on Music Video projects: scene
// reference-frame renders resolve through it (imageGen/prepareParams.js).
// Extended at the route layer — the same pattern as routes/universeBuilder/ —
// so the pin stays a route-level concern and musicVideoProjectCreateSchema keeps
// the shape peers sync against. (Since #3873 the fragment lives in the leaf
// sharedSchemas.js, so musicVideoValidation.js COULD import it without the
// TDZ cycle that re-exporting through validation.js used to cause — the route
// layer is now a choice, not a workaround.)
const projectCreateSchema = musicVideoProjectCreateSchema.extend(recordRenderPinFields);
const projectUpdateSchema = musicVideoProjectUpdateSchema.extend(recordRenderPinFields);

// Backward-compatible by default: returns the full projects array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const projects = await listProjects();
  if (!isPaginationRequested(req.query)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(p);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(projectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
}));

router.post('/:id/clone', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoProjectCloneSchema, req.body || {});
  res.status(201).json(await cloneProject(req.params.id, options));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(projectUpdateSchema, req.body);
  const updated = await updateProject(req.params.id, data);
  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await deleteProject(req.params.id);
  res.json({ ok: true });
}));

// Optional vocal stem (#8977): a full-length bounce of the vocal on the
// master's timebase. Performance shots are conditioned on it instead of the
// mix; the master stays the project's audio. Same audio formats and size cap
// as a track upload.
const vocalStemUpload = uploadSingle('stem', {
  limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMusicUpload(file)) cb(null, true);
    else cb(new ServerError('Unsupported audio format — accepted: MP3, WAV, M4A, OGG, FLAC', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

router.post('/:id/vocal-stem', vocalStemUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No vocal stem file uploaded', { status: 400, code: 'VALIDATION_ERROR' });
  res.json(await attachVocalStem(req.params.id, { tempPath: req.file.path, originalName: req.file.originalname }));
}));

router.delete('/:id/vocal-stem', asyncHandler(async (req, res) => {
  res.json(await detachVocalStem(req.params.id));
}));

// Separate the vocal from the song with demucs and attach it as the stem.
// Kickoff returns 202 + a jobId (a running separation for the project is
// re-attached, not doubled); progress streams over SSE. The first run
// installs demucs into its own venv — only ever from this explicit request.
// Lazy import: the demucs runner pulls the spawn/venv helpers only this needs.
router.post('/:id/vocal-stem/separate', asyncHandler(async (req, res) => {
  const { startVocalSeparation } = await import('../services/musicVideo/vocalSeparation.js');
  res.status(202).json(await startVocalSeparation(req.params.id));
}));

router.get('/vocal-stem/separate/:jobId/events', asyncHandler(async (req, res) => {
  const { attachVocalSeparationSseClient } = await import('../services/musicVideo/vocalSeparation.js');
  if (!attachVocalSeparationSseClient(req.params.jobId, res)) {
    throw new ServerError('Vocal separation job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
}));

router.post('/vocal-stem/separate/:jobId/cancel', asyncHandler(async (req, res) => {
  const { cancelVocalSeparation } = await import('../services/musicVideo/vocalSeparation.js');
  res.json({ ok: cancelVocalSeparation(req.params.jobId) });
}));

// Resolve a project's source audio to an absolute path under data/music/. The
// filename comes from the linked track or the uploaded-audio field; both are
// validated as safe basenames so a tampered record can't escape the directory.
async function resolveAudioPath(project) {
  let filename = null;
  if (project.trackId) {
    const track = await getTrack(project.trackId);
    if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
    filename = track.audioFilename;
  } else if (project.uploadedAudioFilename) {
    filename = project.uploadedAudioFilename;
  }
  if (!filename) {
    throw new ServerError('Project has no audio to analyze — set a track or upload audio first', { status: 400, code: 'NO_AUDIO' });
  }
  const safe = safeUnder(PATHS.music, filename);
  if (!safe) throw new ServerError('Invalid audio filename', { status: 400, code: 'VALIDATION_ERROR' });
  return safe;
}

// Run the offline beat/tempo/section analysis and cache it on the project.
// Synchronous: the DSP pass over a song-length track is a couple of seconds, so
// it returns the updated project directly (the SSE-streamed render lands later).
router.post('/:id/analyze', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const audioPath = await resolveAudioPath(project);
  const analysis = await analyzeAudioFile(audioPath);
  if (!analysis) {
    throw new ServerError('Could not analyze audio (decode failed or ffmpeg unavailable)', { status: 422, code: 'ANALYZE_FAILED' });
  }
  // Timed lyrics with sheet headers name the fresh sections too (a no-op
  // until the lines are aligned).
  const updated = await setProjectAnalysis(project.id, relabelAnalysisSections(analysis, project.lyricCues, project.lyricMarkers));
  res.json(updated);
}));

// Manual-tempo fallback: lets a director supply a known BPM + first-downbeat
// offset by ear when the auto-detector caches `bpm: null` (see
// services/musicVideo/audioAnalysis.js `estimateTempo` for why). Reuses the
// prior analysis's cached `sections`/`durationSec` when present — the UI only
// offers this after a prior `/analyze` call has cached them, so this is pure
// arithmetic in the common case rather than a second ffmpeg decode; it only
// falls back to decoding when no usable prior analysis exists.
router.post('/:id/analyze/manual', asyncHandler(async (req, res) => {
  const { bpm, offsetSec } = validateRequest(musicVideoManualAnalysisSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const cached = project.audioAnalysis;
  const analysis = cached && Array.isArray(cached.sections) && typeof cached.durationSec === 'number'
    ? buildManualAnalysisFromCached(cached, { bpm, offsetSec })
    : await analyzeAudioFileManual(await resolveAudioPath(project), { bpm, offsetSec });
  if (!analysis) {
    throw new ServerError('Could not analyze audio (decode failed or ffmpeg unavailable)', { status: 422, code: 'ANALYZE_FAILED' });
  }
  const updated = await setProjectAnalysis(project.id, analysis);
  res.json(updated);
}));

// Autonomous shot planner (#1855, the secondary "autonomous mode" path):
// propose one scene per analyzed audio section (energy-aware durations fall
// out of the cached section boundaries) and seed them onto the director
// scene board. Director-first — this only seeds editable scenes, same as a
// hand-added one. `seedPrompts` (default true) additionally best-effort asks
// the active/given AI provider for a first-pass framePrompt/prompt per scene;
// a missing provider or parse failure degrades to plain scenes rather than
// failing the request (see `promptsSeeded`/`promptsSkippedReason` in the body).
router.post('/:id/plan', asyncHandler(async (req, res) => {
  const { seedPrompts, providerId, model } = validateRequest(musicVideoPlanRequestSchema, req.body || {});
  const result = await planProject(req.params.id, { seedPrompts, providerId, model });
  res.json(result);
}));

// --- Pre-production treatment (#8980) ---
// A structured brief, a compiled whole-song arc, per-shot direction keyed to
// the board's scene ids and a proof checklist (services/musicVideo/treatment.js).
// Every write names the revision it was made against; a stale one is a 409.
router.patch('/:id/treatment', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoTreatmentUpdateSchema, req.body);
  res.json(await updateTreatment(req.params.id, patch));
}));

// Compile is an explicit user action. `useAi: false` drafts deterministically
// with no provider call; otherwise the chosen (or active) provider refines the
// draft, and any failure degrades to the deterministic draft with a reason.
router.post('/:id/treatment/compile', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoTreatmentCompileSchema, req.body);
  res.json(await compileTreatment(req.params.id, options));
}));

// Read-only: which scenes Apply would change, which hand-edited prompts it
// keeps, and whether a stale input blocks it.
router.get('/:id/treatment/apply-preview', asyncHandler(async (req, res) => {
  res.json(await previewTreatmentApply(req.params.id));
}));

router.post('/:id/treatment/apply', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoTreatmentApplySchema, req.body);
  res.json(await applyTreatment(req.params.id, options));
}));

router.post('/:id/treatment/proofs/:proofId/review', asyncHandler(async (req, res) => {
  const review = validateRequest(musicVideoTreatmentProofReviewSchema, req.body);
  res.json(await reviewProof(req.params.id, req.params.proofId, review));
}));

// Import timed lyric cues (#8964) from pasted LRC, SRT/WebVTT, or plain lines
// (plain lines arrive untimed, ready to be timed by hand). `replace` swaps the
// project's cue list; `append` adds after it. The cues persist through the
// ordinary project PATCH path, so ids/normalization match hand edits.
// Plain lines keep their section headers and stage directions as lyric
// markers anchored to the imported lines (lyricMarkers.js).
router.post('/:id/lyrics/import', asyncHandler(async (req, res) => {
  const { format = 'auto', text, mode = 'replace' } = validateRequest(musicVideoLyricsImportSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { format: detected, cues, markers } = parseLyricCues(text, format);
  if (cues.length === 0) {
    throw new ServerError(`No lyric lines found in the ${detected} text`, { status: 422, code: 'NO_LYRICS' });
  }
  const existing = project.lyricCues || [];
  const append = mode === 'append';
  const lyricCues = append ? [...existing, ...cues] : cues;
  if (lyricCues.length > MAX_LYRIC_CUES) {
    throw new ServerError(`A project holds at most ${MAX_LYRIC_CUES} lyric cues`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const lyricMarkers = append
    ? [...(project.lyricMarkers || []), ...offsetLyricMarkers(markers, existing.length)]
    : markers;
  const updated = await updateProject(project.id, { lyricCues, lyricMarkers });
  res.json({ project: updated, imported: cues.length, format: detected });
}));

// Import the linked track's lyric sheet ("Use track lyrics", and the
// autopilot kickoff with `mode: 'if-empty'`, which never replaces lines).
router.post('/:id/lyrics/import-track', asyncHandler(async (req, res) => {
  const { mode = 'replace' } = validateRequest(musicVideoLyricsImportTrackSchema, req.body || {});
  res.json(await importTrackLyrics(req.params.id, { mode }));
}));

// Word-level alignment (#9074). Nothing here runs until the director clicks
// Align words or a line's Re-align (or starts an autopilot run). The first
// alignment downloads the music-grade whisper model; no whisper.cpp at all is
// a 503 with install steps, not an empty timing list.
router.post('/:id/lyrics/align', asyncHandler(async (req, res) => {
  const { cueId } = validateRequest(musicVideoLyricsAlignSchema, req.body || {});
  res.json(await alignProjectLyrics(req.params.id, { cueId }));
}));

// --- Audio → MIDI transcription (MuScriptor) ---
// Transcribe the project's source audio into a .mid via the local MuScriptor
// sidecar. Kickoff returns 202 + a jobId (503 with the install hint when the
// venv isn't provisioned); progress streams over SSE. Unlike the rounds path
// (where the client persists on Save), the terminal `complete` frame here
// carries the server-persisted pointer — the project record isn't an editor
// draft, so the server lands `midiTranscription` on completion and the frame
// includes it for the client to merge.
router.post('/:id/transcribe-midi', asyncHandler(async (req, res) => {
  const { model } = validateRequest(musicVideoTranscribeMidiRequestSchema, req.body || {});
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const audioPath = await resolveAudioPath(project);
  const projectId = project.id;
  // Audio-source identity at kickoff — the completion callback re-checks it so
  // a transcription of the OLD track can't land on a project whose audio was
  // swapped mid-run (another client / peer sync). applyProjectPatch clears
  // midiTranscription on the swap; without this guard the in-flight job would
  // reintroduce the stale pointer right after.
  const sourceTrackId = project.trackId ?? null;
  const sourceUpload = project.uploadedAudioFilename ?? null;
  res.status(202).json(await startMidiTranscription({
    audioPath,
    outputName: `${project.name || 'music-video'}-midi`,
    model,
    // Land the .mid in the music dir (not uploads) so the peer-sync asset
    // manifest federates it with the project's other audio — the manifest
    // only ships known asset kinds/directories, and `music` is one.
    destDir: PATHS.music,
    onComplete: async ({ filename, model: usedModel }) => {
      const current = await getProject(projectId);
      if (!current) throw new Error('Project was deleted during transcription');
      if ((current.trackId ?? null) !== sourceTrackId || (current.uploadedAudioFilename ?? null) !== sourceUpload) {
        // The service deletes the orphaned .mid and reports a discarded (not
        // "ready") completion to the client.
        return { discarded: true, reason: `audio source of ${projectId} changed mid-transcription` };
      }
      const midiTranscription = { filename, model: usedModel, createdAt: new Date().toISOString() };
      await setProjectMidiTranscription(projectId, midiTranscription);
      return { midiTranscription };
    },
  }));
}));

// Two-segment paths — distinct from the one-segment GET /:id project read.
router.get('/transcribe-midi/:jobId/events', (req, res) => {
  if (!attachMidiTranscriptionSseClient(req.params.jobId, res)) {
    throw new ServerError('Transcription job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/transcribe-midi/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelMidiTranscription(req.params.jobId) });
});

// --- Render (#1760, Phase 2) ---
// Assemble the scenes' i2v clips into one MP4 over the track as the master audio
// bed. Kickoff returns { jobId }; progress streams over SSE (mirrors
// videoTimeline). Per-project mutex returns 409 with the live jobId for re-attach.
router.post('/:id/render', asyncHandler(async (req, res) => {
  res.json(await renderMusicVideo(req.params.id));
}));

// SSE progress stream for a render job. Two-segment path — distinct from the
// one-segment GET /:id project read, so it can't shadow it.
router.get('/render/:jobId/events', (req, res) => {
  const ok = attachRenderSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Render job not found or expired', { status: 404, code: 'NOT_FOUND' });
});

router.post('/render/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelRender(req.params.jobId) });
});

// Code-rendered style (#9076). Document reads build the page from stored
// section functions and never call a provider. Generate / regenerate are the
// only provider calls, and both require this click.
router.get('/:id/code/document', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (project.composition?.mode !== 'code') {
    throw new ServerError('Switch the render style to Code-rendered first', { status: 409, code: 'NOT_CODE_MODE' });
  }
  res.json(prepareCodeRender(project));
}));

router.post('/:id/code/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.json(await generateMusicVideoCode(req.params.id, body));
}));

router.post('/:id/code/sections/:sectionId/regenerate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.json(await regenerateMusicVideoCodeSection(req.params.id, req.params.sectionId, body));
}));

// --- Draft excerpt render (#8986) ---
// A director-chosen [startSec, endSec) window re-rendered through the same
// composed pipeline, plus a cut/cue contact sheet and timecoded review notes.
// Kickoff returns { jobId, excerptId }; progress streams over SSE (mirrors the
// full render above) on its OWN job map, so an excerpt draft and a full render
// can run at once without contending for the same mutex.
router.post('/:id/excerpt', asyncHandler(async (req, res) => {
  const { startSec, endSec } = validateRequest(musicVideoExcerptRequestSchema, req.body);
  res.json(await startExcerptRender(req.params.id, { startSec, endSec }));
}));

router.get('/excerpt/:jobId/events', (req, res) => {
  const ok = attachExcerptRenderSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Excerpt render job not found or expired', { status: 404, code: 'NOT_FOUND' });
});

router.post('/excerpt/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelExcerptRender(req.params.jobId) });
});

router.delete('/:id/excerpt/:excerptId', asyncHandler(async (req, res) => {
  res.json(await deleteExcerpt(req.params.id, req.params.excerptId));
}));

router.post('/:id/excerpt/:excerptId/notes', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoExcerptNoteSchema, req.body);
  const { project, note } = await addReviewNote(req.params.id, req.params.excerptId, input);
  res.status(201).json({ project, note });
}));

router.patch('/:id/excerpt/:excerptId/notes/:noteId', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoExcerptNoteUpdateSchema, req.body);
  const { project, note } = await editReviewNote(req.params.id, req.params.excerptId, req.params.noteId, patch);
  res.json({ project, note });
}));

router.delete('/:id/excerpt/:excerptId/notes/:noteId', asyncHandler(async (req, res) => {
  res.json(await deleteReviewNote(req.params.id, req.params.excerptId, req.params.noteId));
}));

// --- Selective section revision (#8987) ---
// Reject the flagged sections of a reviewed draft (their selected takes clear)
// while every other section keeps its selection. Resume continues from the
// persisted checkpoint: sections still without a take come back as
// `needsGeneration` for the board to generate; once all hold one, the draft
// window re-renders. A section holding a take is never asked to generate again,
// so a render retry never re-submits paid generation.
router.post('/:id/excerpt/:excerptId/revisions', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoRevisionStartSchema, req.body || {});
  res.status(201).json(await startRevision(req.params.id, req.params.excerptId, input));
}));

router.post('/:id/revisions/:revisionId/resume', asyncHandler(async (req, res) => {
  res.json(await resumeRevision(req.params.id, req.params.revisionId));
}));

router.post('/:id/revisions/:revisionId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelRevision(req.params.id, req.params.revisionId));
}));

// A generation kickoff that failed client-side before reaching the queue
// (network error, a refused request) leaves its section claimed for the
// full lease with nothing running — clear the claim so the very next resume
// hands the section out again immediately (#9011).
router.post('/:id/revisions/:revisionId/release', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoRevisionReleaseSchema, req.body || {});
  res.json(await releaseRevisionSection(req.params.id, req.params.revisionId, input.sceneId));
}));

// --- Opt-in automatic review/retries (#8988) ---
// Start/resume write the checkpoint and return at once; the run advances in
// the background (render → review → revise → generate → re-render) and
// reports over the `music-video:auto-review` socket event. Only these
// explicit requests start or resume a run — nothing at boot does.
router.post('/:id/auto-reviews', asyncHandler(async (req, res) => {
  const { providerId, model, ...input } = validateRequest(musicVideoAutoReviewStartSchema, req.body || {});
  res.status(201).json(await startAutoReview(req.params.id, { ...input, reviewer: { providerId, model } }));
}));

router.post('/:id/auto-reviews/:runId/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoAutoReviewResumeSchema, req.body || {});
  res.json(await resumeAutoReview(req.params.id, req.params.runId, input));
}));

router.post('/:id/auto-reviews/:runId/stop', asyncHandler(async (req, res) => {
  res.json(await stopAutoReview(req.params.id, req.params.runId));
}));

router.post('/:id/auto-reviews/:runId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelAutoReview(req.params.id, req.params.runId));
}));

// --- Server-owned production run (#9066) ---
// Start/resume write the checkpoint and return at once; the run advances in
// the background (plan → frames → clips → reviewed draft → revisions) from
// queue completion events and reports over `music-video:production`. Only
// these explicit requests start or resume a run — nothing at boot does.
router.post('/:id/production-runs', asyncHandler(async (req, res) => {
  const { providerId, model, ...input } = validateRequest(musicVideoProductionStartSchema, req.body || {});
  res.status(201).json(await startProduction(req.params.id, { ...input, reviewer: { providerId, model } }));
}));

router.get('/:id/production-runs/:runId', asyncHandler(async (req, res) => {
  res.json(await getProduction(req.params.id, req.params.runId));
}));

router.post('/:id/production-runs/:runId/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionResumeSchema, req.body || {});
  res.json(await resumeProduction(req.params.id, req.params.runId, input));
}));

router.post('/:id/production-runs/:runId/stop', asyncHandler(async (req, res) => {
  res.json(await stopProduction(req.params.id, req.params.runId));
}));

router.post('/:id/production-runs/:runId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelProduction(req.params.id, req.params.runId));
}));

// --- Development artifacts ("ingredients") ---
// Reviewable development files attached to the project: list, import/upload
// (HTML, Markdown, MP4, PNG, JPG — a new artifact, or a new version of one),
// serve, notes, review and soft delete. See services/musicVideo/devArtifacts.js.
const DEV_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const devArtifactUpload = uploadSingle('file', {
  limits: { fileSize: DEV_ARTIFACT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop();
    if (String(file.originalname || '').includes('.') && devArtifactTypeFor(ext)) cb(null, true);
    else cb(new ServerError('Unsupported file type — accepted: HTML, Markdown, MP4, PNG, JPG', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

// A served artifact never runs with the PortOS origin: HTML is sandboxed by
// its CSP even when opened directly (an opaque origin, no same-origin access),
// may run its own inline script inside that sandbox, and can load nothing
// from the network — images, media and fonts only as data:/blob: URLs.
const DEV_ARTIFACT_HTML_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";
const DEV_ARTIFACT_MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

router.get('/:id/dev-artifacts', asyncHandler(async (req, res) => {
  res.json(await listDevArtifacts(req.params.id));
}));

router.post('/:id/dev-artifacts', devArtifactUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No file uploaded (multipart field "file")', { status: 400, code: 'VALIDATION_ERROR' });
  const input = (() => {
    try {
      return validateRequest(musicVideoDevArtifactImportSchema, req.body || {});
    } catch (err) {
      unlink(req.file.path).catch(() => {});
      throw err;
    }
  })();
  const out = await importDevArtifact(req.params.id, { ...input, tempPath: req.file.path, originalName: req.file.originalname });
  res.status(201).json(out);
}));

router.get('/:id/dev-artifacts/:artifactId', asyncHandler(async (req, res) => {
  res.json(await getDevArtifact(req.params.id, req.params.artifactId));
}));

router.get('/:id/dev-artifacts/:artifactId/file', asyncHandler(async (req, res) => {
  const { version } = validateRequest(musicVideoDevArtifactFileQuerySchema, req.query || {});
  const { path, mimeType } = await resolveDevArtifactDownload(req.params.id, req.params.artifactId, version ?? null);
  if (!existsSync(path)) throw new ServerError('The artifact file is not on this machine', { status: 404, code: 'DEV_ARTIFACT_FILE_MISSING' });
  const isHtml = mimeType === 'text/html';
  res.setHeader('Content-Security-Policy', isHtml ? DEV_ARTIFACT_HTML_CSP : DEV_ARTIFACT_MEDIA_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  // Markdown is shown as text (a browser would otherwise download it).
  res.type(mimeType === 'text/markdown' ? 'text/plain; charset=utf-8' : (isHtml ? 'text/html; charset=utf-8' : mimeType));
  res.sendFile(path, { dotfiles: 'deny' });
}));

router.post('/:id/dev-artifacts/:artifactId/notes', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDevArtifactNoteSchema, req.body || {});
  res.status(201).json(await addDevArtifactNote(req.params.id, req.params.artifactId, input));
}));

router.patch('/:id/dev-artifacts/:artifactId/notes/:noteId', asyncHandler(async (req, res) => {
  const { resolved } = validateRequest(musicVideoDevArtifactNoteUpdateSchema, req.body || {});
  res.json(await setDevArtifactNoteResolved(req.params.id, req.params.artifactId, req.params.noteId, resolved));
}));

router.post('/:id/dev-artifacts/:artifactId/review', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDevArtifactReviewSchema, req.body || {});
  res.json(await reviewDevArtifact(req.params.id, req.params.artifactId, input));
}));

router.delete('/:id/dev-artifacts/:artifactId', asyncHandler(async (req, res) => {
  res.json(await removeDevArtifact(req.params.id, req.params.artifactId));
}));

// --- Cast & Sets check-in (runs before the shot plan) ---
// Start / regenerate / resume write the checkpoint and return at once; the
// direction call and the reference images advance in the background and
// report over `music-video:cast-and-sets`. Only these requests (or a
// production run the director started) begin work — nothing at boot does.
router.get('/:id/cast-and-sets', asyncHandler(async (req, res) => {
  res.json(await getCastAndSets(req.params.id));
}));

router.post('/:id/cast-and-sets', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.status(202).json(await startCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/regenerate', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsRegenerateSchema, req.body || {});
  res.status(202).json(await regenerateCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.status(202).json(await resumeCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/approve', asyncHandler(async (req, res) => {
  res.json(await approveCastAndSets(req.params.id));
}));

router.post('/:id/cast-and-sets/skip', asyncHandler(async (req, res) => {
  res.json(await skipCastAndSets(req.params.id));
}));

// --- Director scene board ---

router.post('/:id/scenes', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoSceneCreateSchema, req.body);
  const scene = await addProjectScene(req.params.id, data);
  res.status(201).json(scene);
}));

router.patch('/:id/scenes/:sceneId', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoSceneUpdateSchema, req.body);
  const updated = await updateScene(req.params.id, req.params.sceneId, data);
  res.json(updated);
}));

router.delete('/:id/scenes/:sceneId', asyncHandler(async (req, res) => {
  const updated = await deleteScene(req.params.id, req.params.sceneId);
  res.json(updated);
}));

router.post('/:id/scenes/reorder', asyncHandler(async (req, res) => {
  const { sceneIds } = validateRequest(musicVideoSceneReorderSchema, req.body);
  const updated = await reorderProjectScenes(req.params.id, sceneIds);
  res.json(updated);
}));

// Split a shot its backend cannot render in one take (#8977): a performance
// longer than the lip-sync window, a Grok cutaway longer than its longest clip.
router.post('/:id/scenes/:sceneId/split', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(musicVideoSceneSplitSchema, req.body ?? {});
  res.json(await splitProjectScene(req.params.id, req.params.sceneId, { backend }));
}));

// --- Scene takes (#8965) ---
// Every render or import for a scene slot is kept as an immutable take; the
// slot field is the director's explicit selection among them. A take's asset
// must already exist in this install's media stores — an image in the gallery,
// a clip in the video history (both reached through the existing upload
// routes) — so a take can never point at an arbitrary file.
async function takeAssetExists(kind, assetId) {
  if (kind === 'image') return Boolean(resolveGalleryImage(assetId));
  return Boolean(await getHistoryItem(assetId));
}

// Add one candidate take to a scene: the synchronous image lane's inline
// render, or an asset the director imports from the gallery.
router.post('/:id/scenes/:sceneId/takes', asyncHandler(async (req, res) => {
  const { kind, assetId, source = 'imported', provider, originalName, use } = validateRequest(musicVideoTakeInputSchema, req.body);
  if (!(await takeAssetExists(kind, assetId))) {
    throw new ServerError(`${kind === 'image' ? 'Image' : 'Video'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  const { scene, appended } = await appendSceneTakes(req.params.id, req.params.sceneId, [{
    kind, assetId, source, provider: provider ?? (source === 'generated' ? 'portos' : null), originalName, use,
  }]);
  res.status(201).json({ scene, take: appended[0] });
}));

router.post('/:id/scenes/:sceneId/takes/:takeId/select', asyncHandler(async (req, res) => {
  res.json(await selectSceneTake(req.params.id, req.params.sceneId, req.params.takeId));
}));

router.patch('/:id/scenes/:sceneId/takes/:takeId', asyncHandler(async (req, res) => {
  const review = validateRequest(musicVideoTakeReviewSchema, req.body);
  res.json(await reviewSceneTake(req.params.id, req.params.sceneId, req.params.takeId, review));
}));

// --- External-asset handoff (#8965) ---
// Export per-scene prompts + reference files for a tool PortOS does not drive
// (e.g. Midjourney), and import what the director generated there. Nothing
// here contacts the external service.
router.get('/:id/handoff', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(buildHandoffManifest(project));
}));

// Downloadable ZIP counterpart (#8978): the manifest plus every reference
// image and each scene's selected frame, so nothing has to be saved out of
// the gallery by hand before attaching it in the external tool.
router.get('/:id/handoff/bundle', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { zip } = await buildHandoffBundle(project);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="music-video-${project.id}-handoff.zip"`);
  res.send(zip);
}));

// Associate already-uploaded assets with scenes. An item names its scene
// explicitly or carries the manifest's file tag in `originalName`; an item that
// resolves to no scene, or whose asset isn't in this install's media stores, is
// reported in `skipped` rather than guessed. All matched items land in one
// record write with `imported` source + provider provenance.
router.post('/:id/handoff/import', asyncHandler(async (req, res) => {
  const { provider, items } = validateRequest(musicVideoHandoffImportSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const sceneIds = new Set((project.scenes || []).map((scene) => scene.sceneId));
  const accepted = [];
  const skipped = [];
  for (const item of items) {
    const sceneId = item.sceneId || matchSceneByFileTag(project.scenes, item.originalName);
    const skip = (reason) => skipped.push({ assetId: item.assetId, originalName: item.originalName ?? null, reason });
    if (!sceneId || !sceneIds.has(sceneId)) { skip('no-matching-scene'); continue; }
    if (!musicVideoTakeInputSchema.safeParse({ kind: item.kind, assetId: item.assetId }).success
      || !(await takeAssetExists(item.kind, item.assetId))) { skip('asset-not-found'); continue; }
    accepted.push({ sceneId, kind: item.kind, assetId: item.assetId, source: 'imported', provider, originalName: item.originalName, use: item.use });
  }
  if (accepted.length === 0) {
    return res.json({ project, imported: [], skipped });
  }
  const { project: next, appended } = await appendTakesAcrossScenes(project.id, accepted);
  res.json({
    project: next,
    imported: appended.map(({ sceneId, take }) => ({ sceneId, takeId: take.takeId, kind: take.kind, assetId: take.assetId, originalName: take.originalName })),
    skipped,
  });
}));

export default router;
