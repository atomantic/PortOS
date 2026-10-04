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
import { musicVideoProjectListQuerySchema, musicVideoProductionDraftSchema, musicVideoProductionApprovalSchema, musicVideoProductionProofSchema, musicVideoProductionImportSchema, musicVideoProductionFeedbackSchema, musicVideoProductionFeedbackResolutionSchema } from '../lib/musicVideoValidation.js';
import { productionReadiness } from '../services/musicVideo/productionReview.js';
import { getProductionReview, saveProductionDraft, prepareProductionReview, approveProductionReview, renderProductionProof, requireProductionReviewer, importProductionPlanning, bindProductionShot, addProductionFeedback, closeProductionFeedback } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  musicVideoAudioTimingPreviewSchema,
  musicVideoAudioTimingApplySchema,
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
  musicVideoSocialCutsQuerySchema,
  musicVideoPublishCopyPatchSchema,
  musicVideoPublishCopyDraftSchema,
  musicVideoPublishThumbnailSchema,
  musicVideoPublishTargetSchema,
  musicVideoPublishPrepareSchema,
  musicVideoPublishPlatformsPatchSchema,
  musicVideoPublishPostSchema,
  musicVideoCodeGenerateSchema,
  musicVideoExcerptNoteSchema,
  musicVideoExcerptNoteUpdateSchema,
  musicVideoDependencyRepairSchema,
  musicVideoRevisionStartSchema,
  musicVideoPerformanceRepairSchema,
  musicVideoRevisionReleaseSchema,
  musicVideoAutoReviewStartSchema,
  musicVideoAutoReviewResumeSchema,
  musicVideoProductionStartSchema,
  musicVideoProductionResumeSchema,
  musicVideoAutonomousStartSchema,
  musicVideoAutonomousResumeSchema,
  musicVideoDevArtifactImportSchema,
  musicVideoDevArtifactNoteSchema,
  musicVideoDevArtifactNoteUpdateSchema,
  musicVideoDevArtifactReviewSchema,
  musicVideoDevArtifactFileQuerySchema,
  musicVideoCastAndSetsStartSchema,
  musicVideoCastAndSetsDirectionEditSchema,
  musicVideoCastAndSetsRegenerateSchema,
  musicVideoDocumentDirectoryImportSchema,
  musicVideoDocumentFileQuerySchema,
  musicVideoDocumentTemplateSchema,
  musicVideoDocumentDraftQuerySchema,
  musicVideoDocumentCandidateSchema,
  musicVideoMixedMediaRegenerateSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import { recordRenderPinFields } from '../lib/sharedSchemas.js';
import { PATHS } from '../lib/fileUtils.js';
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
import { analyzeAudioFileManual, buildManualAnalysisFromCached } from '../services/musicVideo/audioAnalysis.js';
import { analyzeProjectSong, resolveProjectAudioPath } from '../services/musicVideo/projectAudio.js';
import { renderMusicVideo, attachRenderSseClient, cancelRender, getActiveRenderJobId } from '../services/musicVideo/render.js';
import { prepareCodeRender } from '../services/musicVideo/codeRender.js';
import { generateMusicVideoCode, regenerateMusicVideoCodeSection } from '../services/musicVideo/codeGeneration.js';
import { startExcerptRender, attachExcerptRenderSseClient, cancelExcerptRender } from '../services/musicVideo/excerptRender.js';
import { deleteExcerpt, addReviewNote, editReviewNote, deleteReviewNote } from '../services/musicVideo/excerptService.js';
import { suggestSocialCuts } from '../services/musicVideo/socialCuts.js';
import { getActivePublishKitBuild, startPublishKitBuild, attachPublishKitSseClient, cancelPublishKitBuild, draftPublishKitCopy, updatePublishKitCopy, selectPublishKitThumbnail } from '../services/musicVideo/publishKit.js';
import { preparePublishDraft, discardPublishDraft, listPublishDrafts, recordPublishPost } from '../services/musicVideo/publish/index.js';
import { getPublishPlatforms, updatePublishPlatforms, publishHistory } from '../services/musicVideo/publish/platforms.js';
import {
  getDependencyImpact,
  startDependencyRepair,
  startRevision, resumeRevision, cancelRevision, releaseRevisionSection,
} from '../services/musicVideo/revisionService.js';
import {
  startAutoReview, resumeAutoReview, stopAutoReview, cancelAutoReview,
} from '../services/musicVideo/autoReviewService.js';
import {
  startProduction, resumeProduction, stopProduction, cancelProduction, getProduction,
} from '../services/musicVideo/productionService.js';
import {
  startAutonomousVideo, getAutonomousRun, presentProjectAutonomousRun, resumeAutonomousVideo, stopAutonomousVideo, cancelAutonomousVideo,
} from '../services/musicVideo/autonomousService.js';
import { planProject } from '../services/musicVideo/planner.js';
import {
  DOCUMENT_ZIP_MAX_BYTES,
  detachDocument,
  discardGeneratedDocument,
  documentMimeType,
  exportDocumentZip,
  importDocumentDirectory,
  importDocumentTemplate,
  importDocumentZip,
  readDocumentManifest,
  resolveDocumentFile,
} from '../services/musicVideo/compositionDocument.js';
import { buildDocumentPreview } from '../services/musicVideo/documentPreview.js';
import { acceptMixedMediaDocument, generateMixedMediaDocument, readMixedMediaCandidate, regenerateMixedMediaSection, reviseMixedMediaEvents } from '../services/musicVideo/documentGeneration.js';
import { isZipUpload } from '../lib/zipStream.js';
import { parseLyricCues } from '../services/musicVideo/timedText.js';
import { alignProjectLyrics } from '../services/musicVideo/lyricAlign.js';
import { importTrackLyrics, MAX_LYRIC_CUES } from '../services/musicVideo/trackLyrics.js';
import { offsetLyricMarkers } from '../services/musicVideo/lyricMarkers.js';
import {
  updateTreatment,
  compileTreatment,
  previewTreatmentApply,
  applyTreatment,
  reviewProof,
} from '../services/musicVideo/treatmentService.js';
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
  editCastAndSetsDirection,
  regenerateCastAndSets,
  resumeCastAndSets,
  approveCastAndSets,
  skipCastAndSets,
  getCastAndSets,
  presentProjectCastAndSets,
} from '../services/musicVideo/castAndSetsService.js';
import {
  summarizeMusicVideoProject,
  compareMusicVideoProjectsNewestFirst,
} from '../lib/musicVideoSummary.js';

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
// `summary=1` (#10169) swaps each record for its bounded summary projection —
// newest first, with a `nextCursor` — for the project index and header picker, so
// they never load every project's scenes, runs and reviews.
// Both pins are process-local, so only the server can say which stages a restart orphaned.
const presentProjectForRead = (project) => presentProjectAutonomousRun(presentProjectCastAndSets(project));

router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(musicVideoProjectListQuerySchema, req.query);
  const projects = (await listProjects()).map(presentProjectForRead);
  if (query.summary === '1' || query.summary === 'true') {
    const summaries = projects.sort(compareMusicVideoProjectsNewestFirst)
      .map((project) => summarizeMusicVideoProject(project, productionReadiness(project)));
    // The cursor is the next page's offset; `cursor` wins over `offset`.
    const cursor = parseInt(query.cursor, 10);
    const page = paginateArray(summaries, Number.isInteger(cursor) && cursor >= 0 ? { ...query, offset: String(cursor) } : query,
      { defaultLimit: 50, maxLimit: 500 });
    const next = page.offset + page.items.length;
    return res.json({ ...page, nextCursor: next < page.total ? String(next) : null });
  }
  if (!isPaginationRequested(query)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, query, { defaultLimit: 50, maxLimit: 500 }));
}));

// Bounded projection for the Tracks page MIDI read-through (#10203): the newest
// MIDI transcription per linked track, without shipping every full project record.
router.get('/midi-sources', asyncHandler(async (req, res) => {
  const newest = new Map();
  for (const p of await listProjects()) {
    const midi = p.midiTranscription;
    if (!p.trackId || !midi?.filename) continue;
    const prev = newest.get(p.trackId);
    if (!prev || (midi.createdAt || '') > (prev.midiTranscription.createdAt || '')) {
      newest.set(p.trackId, {
        trackId: p.trackId,
        id: p.id,
        name: p.name,
        midiTranscription: { filename: midi.filename, model: midi.model, createdAt: midi.createdAt },
      });
    }
  }
  res.json([...newest.values()]);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  // Transient (never persisted): lets a reloaded page reattach to a running publishing-kit build.
  const activePublishKitBuild = getActivePublishKitBuild(p.id);
  const presented = presentProjectForRead(p);
  res.json(activePublishKitBuild ? { ...presented, activePublishKitBuild } : presented);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(projectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
}));

router.post('/:id/song-revision', asyncHandler(async (req, res) => {
  const { musicVideoSongDraftSchema } = await import('../lib/musicVideoValidation.js');
  const fields = validateRequest(musicVideoSongDraftSchema, req.body);
  const { saveSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await saveSongRevision(req.params.id, fields));
}));
router.post('/:id/song-revision/generate', asyncHandler(async (req, res) => {
  const { musicVideoSongActionSchema } = await import('../lib/musicVideoValidation.js');
  const { revisionId } = validateRequest(musicVideoSongActionSchema, req.body);
  const { generateSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.status(202).json(await generateSongRevision(req.params.id, revisionId));
}));
router.post('/:id/song-revision/cancel', asyncHandler(async (req, res) => {
  const { musicVideoSongActionSchema } = await import('../lib/musicVideoValidation.js');
  const { revisionId } = validateRequest(musicVideoSongActionSchema, req.body);
  const { cancelSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await cancelSongRevision(req.params.id, revisionId));
}));
router.post('/:id/song-revision/select', asyncHandler(async (req, res) => {
  const { musicVideoSongSelectSchema } = await import('../lib/musicVideoValidation.js');
  const { revisionId, songId } = validateRequest(musicVideoSongSelectSchema, req.body);
  const { selectSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await selectSongRevision(req.params.id, revisionId, songId));
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

// Preview is read-only; Apply rechecks audio and the serialized project basis.
router.post('/:id/audio-timing/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoAudioTimingPreviewSchema, req.body);
  const { previewAudioTiming } = await import('../services/musicVideo/audioTiming.js');
  res.json(await previewAudioTiming(req.params.id, input));
}));
router.post('/:id/audio-timing/apply', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoAudioTimingApplySchema, req.body);
  const { applyAudioTiming } = await import('../services/musicVideo/audioTiming.js');
  res.json(await applyAudioTiming(req.params.id, input));
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

// Run the offline beat/tempo/section analysis and cache it on the project.
// Synchronous: the DSP pass over a song-length track is a couple of seconds, so
// it returns the updated project directly (the SSE-streamed render lands later).
router.post('/:id/analyze', asyncHandler(async (req, res) => {
  res.json(await analyzeProjectSong(req.params.id));
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
    : await analyzeAudioFileManual(await resolveProjectAudioPath(project), { bpm, offsetSec });
  if (!analysis) {
    throw new ServerError('Could not analyze audio (decode failed or ffmpeg unavailable)', { status: 422, code: 'ANALYZE_FAILED' });
  }
  const updated = await setProjectAnalysis(project.id, analysis, project);
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
  const { seedPrompts, providerId, model, effort, mode } = validateRequest(musicVideoPlanRequestSchema, req.body || {});
  const result = await planProject(req.params.id, { seedPrompts, providerId, model, effort, mode: mode ?? 'require' });
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
  const audioPath = await resolveProjectAudioPath(project);
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

// Read-only: the live final-render job for a project (null when none runs on
// this instance), so a reloaded page re-attaches without POSTing a new render.
router.get('/:id/render', (req, res) => {
  res.json({ jobId: getActiveRenderJobId(req.params.id) });
});

router.post('/:id/production-review/feedback', asyncHandler(async (req, res) => {
  res.json(await addProductionFeedback(req.params.id, validateRequest(musicVideoProductionFeedbackSchema, req.body)));
}));
router.post('/:id/production-review/feedback/resolve', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionFeedbackResolutionSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  res.json(await closeProductionFeedback(req.params.id, { feedbackId: input.feedbackId, resolution: input.resolution, reviewer }));
}));
router.get('/:id/production-review', asyncHandler(async (req, res) => {
  res.json(await getProductionReview(req.params.id));
}));
router.post('/:id/production-review/document-shots', asyncHandler(async (req, res) => {
  const { musicVideoDocumentShotsSchema } = await import('../lib/musicVideoValidation.js');
  const input = validateRequest(musicVideoDocumentShotsSchema, req.body);
  const { importDocumentShots } = await import('../services/musicVideo/productionReviewService.js');
  res.json(await importDocumentShots(req.params.id, input));
}));

router.post('/:id/production-review/import', asyncHandler(async (req, res) => {
  const { source } = validateRequest(musicVideoProductionImportSchema, req.body);
  res.json(await importProductionPlanning(req.params.id, source));
}));
router.post('/:id/production-review/shots/:shotId/bind', asyncHandler(async (req, res) => {
  res.json(await bindProductionShot(req.params.id, req.params.shotId));
}));
router.put('/:id/production-review', asyncHandler(async (req, res) => {
  res.json(await saveProductionDraft(req.params.id, validateRequest(musicVideoProductionDraftSchema, req.body)));
}));
router.post('/:id/production-review/prepare', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.json(await prepareProductionReview(req.params.id, input));
}));
router.post('/:id/production-review/alignment', asyncHandler(async (req, res) => {
  const { musicVideoAlignmentReviewSchema } = await import('../lib/musicVideoValidation.js');
  const input = validateRequest(musicVideoAlignmentReviewSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  const { reverifyProductionAlignment } = await import('../services/musicVideo/productionReviewService.js');
  res.json(await reverifyProductionAlignment(req.params.id, { ...input, reviewer }));
}));
router.post('/:id/production-review/approve', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionApprovalSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  res.json(await approveProductionReview(req.params.id, { stage: input.stage, basis: input.basis, proofReview: input.proofReview, reviewer }));
}));
router.post('/:id/production-review/proof', asyncHandler(async (req, res) => {
  res.status(202).json(await renderProductionProof(req.params.id, validateRequest(musicVideoProductionProofSchema, req.body)));
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

// --- Composition document (render style `document`) ---
// A project-owned HTML composition document (services/musicVideo/
// compositionDocument.js): import a zip, a folder inside data/, or the shipped
// template; export it; read its manifest; preview it. Files stay on this
// install; the record keeps a pointer to the current immutable version.
const requireProject = async (id) => {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
};

const documentZipUpload = uploadSingle('file', {
  limits: { fileSize: DOCUMENT_ZIP_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isZipUpload(file)) cb(null, true);
    else cb(new ServerError('Upload a .zip of the composition document', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

router.get('/:id/composition/document', asyncHandler(async (req, res) => {
  res.json(await readDocumentManifest(await requireProject(req.params.id)));
}));

router.post('/:id/composition/document/zip', documentZipUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No file uploaded (multipart field "file")', { status: 400, code: 'VALIDATION_ERROR' });
  try {
    res.status(201).json(await importDocumentZip(req.params.id, req.file.path, req.file.originalname));
  } finally {
    await unlink(req.file.path).catch(() => {});
  }
}));

router.post('/:id/composition/document/directory', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentDirectoryImportSchema, req.body || {});
  res.status(201).json(await importDocumentDirectory(req.params.id, directory));
}));

router.post('/:id/composition/document/template', asyncHandler(async (req, res) => {
  const { template } = validateRequest(musicVideoDocumentTemplateSchema, req.body || {});
  res.status(201).json(await importDocumentTemplate(req.params.id, template));
}));

router.post('/:id/composition/document/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.status(201).json(await generateMixedMediaDocument(req.params.id, body));
}));

router.get('/:id/composition/document/candidate', asyncHandler(async (req, res) => {
  res.json(await readMixedMediaCandidate(req.params.id));
}));

router.post('/:id/composition/document/events/revise', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoMixedMediaRegenerateSchema, req.body || {});
  res.status(201).json(await reviseMixedMediaEvents(req.params.id, body));
}));

router.post('/:id/composition/document/sections/:sectionId/regenerate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoMixedMediaRegenerateSchema, req.body || {});
  res.status(201).json(await regenerateMixedMediaSection(req.params.id, req.params.sectionId, body));
}));

router.post('/:id/composition/document/accept', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentCandidateSchema, req.body || {});
  res.json(await acceptMixedMediaDocument(req.params.id, directory));
}));

router.delete('/:id/composition/document/candidate', asyncHandler(async (req, res) => {
  const { directory } = validateRequest(musicVideoDocumentCandidateSchema, req.body || {});
  res.json(await discardGeneratedDocument(req.params.id, directory));
}));

router.get('/:id/composition/document/export', asyncHandler(async (req, res) => {
  const { zip, filename } = await exportDocumentZip(await requireProject(req.params.id));
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(zip);
}));

router.get('/:id/composition/document/preview', asyncHandler(async (req, res) => {
  const { draft } = validateRequest(musicVideoDocumentDraftQuerySchema, req.query || {});
  const project = await requireProject(req.params.id);
  const pointer = draft ? project.composition?.documentDraft : project.composition?.document;
  if (draft && !pointer) throw new ServerError('No composition candidate to preview', { status: 404, code: 'NOT_FOUND' });
  res.json(await buildDocumentPreview(draft ? { ...project, composition: { ...project.composition, document: pointer } } : project, { draft: Boolean(draft) }));
}));

// One document file, for the preview's asset bridge (fetched by the PortOS
// page, never loaded by the sandboxed preview itself). Served inert: a
// sandbox CSP, no sniffing, same-origin only.
router.get('/:id/composition/document/file', asyncHandler(async (req, res) => {
  const { path, draft } = validateRequest(musicVideoDocumentFileQuerySchema, req.query || {});
  const project = await requireProject(req.params.id);
  const pointer = draft ? project.composition?.documentDraft : project.composition?.document;
  if (draft && !pointer) throw new ServerError('No composition candidate to preview', { status: 404, code: 'NOT_FOUND' });
  const abs = await resolveDocumentFile(draft ? { ...project, composition: { ...project.composition, document: pointer } } : project, path);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(documentMimeType(path));
  res.sendFile(abs, { dotfiles: 'allow' });
}));

router.delete('/:id/composition/document', asyncHandler(async (req, res) => {
  await requireProject(req.params.id);
  res.json(await detachDocument(req.params.id));
}));

// --- Draft excerpt render (#8986) ---
// A director-chosen [startSec, endSec) window re-rendered through the same
// composed pipeline, plus a cut/cue contact sheet and timecoded review notes.
// Kickoff returns { jobId, excerptId }; progress streams over SSE (mirrors the
// full render above) on its OWN job map, so an excerpt draft and a full render
// can run at once without contending for the same mutex.
router.post('/:id/excerpt', asyncHandler(async (req, res) => {
  const { startSec, endSec, aspect, fade } = validateRequest(musicVideoExcerptRequestSchema, req.body);
  res.json(await startExcerptRender(req.params.id, { startSec, endSec, aspect, fade }));
}));

// --- Publishing kit (#9281) ---
// Platform encodes, thumbnails, captions and chapters from the final render
// (an SSE job), plus per-platform copy: one user-triggered draft, then edits.
router.post('/:id/publish-kit/build', asyncHandler(async (req, res) => {
  res.json(await startPublishKitBuild(req.params.id));
}));

router.get('/publish-kit/:jobId/events', (req, res) => {
  const ok = attachPublishKitSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Publishing kit job not found or expired', { status: 404, code: 'NOT_FOUND' });
});

router.post('/publish-kit/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelPublishKitBuild(req.params.jobId) });
});

router.post('/:id/publish-kit/copy', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPublishCopyDraftSchema, req.body || {});
  const { project } = await draftPublishKitCopy(req.params.id, input);
  res.json({ project });
}));

router.patch('/:id/publish-kit/copy', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoPublishCopyPatchSchema, req.body || {});
  const { project } = await updatePublishKitCopy(req.params.id, patch);
  res.json({ project });
}));

router.put('/:id/publish-kit/thumbnail', asyncHandler(async (req, res) => {
  const { filename } = validateRequest(musicVideoPublishThumbnailSchema, req.body || {});
  const { project } = await selectPublishKitThumbnail(req.params.id, filename);
  res.json({ project });
}));

// --- Posting (#9282) ---
// Fill a platform's post in the PortOS Browser and return a screenshot; post
// only on a second, explicit request naming that live draft.
// #9287: where the director posts (opt-in, optional account per platform),
// with every platform's post history and ratings across projects.
router.get('/publish/platforms', asyncHandler(async (req, res) => {
  const [platforms, history] = await Promise.all([getPublishPlatforms(), publishHistory()]);
  res.json({ platforms, history });
}));

router.put('/publish/platforms', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoPublishPlatformsPatchSchema, req.body || {});
  res.json({ platforms: await updatePublishPlatforms(patch) });
}));

// Record a post made by hand, or rate one: its link, reception and notes.
router.put('/:id/publish/posts/:target', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  const input = validateRequest(musicVideoPublishPostSchema, req.body || {});
  res.json(await recordPublishPost(req.params.id, target, input));
}));

router.post('/:id/publish/:target/prepare', asyncHandler(async (req, res) => {
  const target = validateRequest(musicVideoPublishTargetSchema, req.params.target);
  await requireProductionReviewer(req);
  const { password: _password, ...body } = req.body || {};
  const options = validateRequest(musicVideoPublishPrepareSchema, body);
  res.json(await preparePublishDraft(req.params.id, target, options));
}));

router.get('/:id/publish/drafts', asyncHandler(async (req, res) => {
  res.json({ drafts: await listPublishDrafts(req.params.id) });
}));

router.delete('/:id/publish/drafts/:draftId', asyncHandler(async (req, res) => {
  res.json({ ok: await discardPublishDraft(req.params.id, req.params.draftId) });
}));

// #9280: the song windows most likely to work as a vertical social cut.
router.get('/:id/social-cuts', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoSocialCutsQuerySchema, req.query);
  res.json({ suggestions: suggestSocialCuts(await requireProject(req.params.id), options) });
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

router.post('/:id/scenes/:sceneId/performance-repair', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPerformanceRepairSchema, req.body || {});
  const { startPerformanceRepair } = await import('../services/musicVideo/performanceRepair.js');
  res.status(201).json(await startPerformanceRepair(req.params.id, req.params.sceneId, input));
}));

// --- Selective section revision (#8987) ---
// Reject the flagged sections of a reviewed draft (their selected takes clear)
// while every other section keeps its selection. Resume continues from the
// persisted checkpoint: sections still without a take come back as
// `needsGeneration` for the board to generate; once all hold one, the draft
// window re-renders. A section holding a take is never asked to generate again,
// so a render retry never re-submits paid generation.
router.get('/:id/dependency-impact', asyncHandler(async (req, res) => {
  res.json(await getDependencyImpact(req.params.id));
}));

router.post('/:id/dependency-repairs', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDependencyRepairSchema, req.body || {});
  res.status(201).json(await startDependencyRepair(req.params.id, input));
}));

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

// --- Fully-autonomous run (one prompt → lyrics → Suno song → video) ---
// The alternate entry point: no track, style or board is picked up front. Start
// creates the project and returns at once; the run advances in the background
// (brief → lyrics → mood board → Suno → analysis → production) and reports over
// `music-video:autonomous`. Optional checkpoints park it for approval. Only these
// explicit requests (or the scheduled task) begin work — nothing at boot does.
// A non-empty `autoApprove` lets the run approve those Production review stages
// itself. Bind the grant to the authenticated session; proof still needs review evidence.
const authorizeAutoApprove = async (req, autoApprove) => {
  if (autoApprove === undefined) return false;
  return requireProductionReviewer(req);
};
router.post('/autonomous', asyncHandler(async (req, res) => {
  const { password: _password, ...input } = validateRequest(musicVideoAutonomousStartSchema, req.body || {});
  const autoApproveAuthorized = await authorizeAutoApprove(req, input.autoApprove);
  res.status(202).json(await startAutonomousVideo(input, { autoApproveAuthorized }));
}));

router.get('/:id/autonomous', asyncHandler(async (req, res) => {
  res.json(await getAutonomousRun(req.params.id));
}));

// Resume a parked/failed/interrupted run, or approve the checkpoint it waits on.
router.post('/:id/autonomous/resume', asyncHandler(async (req, res) => {
  const { password: _password, ...edits } = validateRequest(musicVideoAutonomousResumeSchema, req.body || {});
  const autoApproveAuthorized = await authorizeAutoApprove(req, edits.autoApprove);
  res.json(await resumeAutonomousVideo(req.params.id, edits, { autoApproveAuthorized }));
}));

router.post('/:id/autonomous/stop', asyncHandler(async (req, res) => {
  res.json(await stopAutonomousVideo(req.params.id));
}));

router.post('/:id/autonomous/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelAutonomousVideo(req.params.id));
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

router.patch('/:id/cast-and-sets/direction', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsDirectionEditSchema, req.body || {});
  res.status(202).json(await editCastAndSetsDirection(req.params.id, input));
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
  const { kind, assetId, source = 'imported', provider, originalName, use, sourceImageId, inputAssets } = validateRequest(musicVideoTakeInputSchema, req.body);
  if (!(await takeAssetExists(kind, assetId))) {
    throw new ServerError(`${kind === 'image' ? 'Image' : 'Video'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  for (const imageId of [sourceImageId, ...(inputAssets || []).map((input) => input.assetId)].filter(Boolean)) {
    if (!(await takeAssetExists('image', imageId))) throw new ServerError('Dependency image not found', { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  const { scene, appended } = await appendSceneTakes(req.params.id, req.params.sceneId, [{
    kind, assetId, source, provider: provider ?? (source === 'generated' ? 'portos' : null), originalName, use, sourceImageId, inputAssets,
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
