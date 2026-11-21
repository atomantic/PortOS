/**
 * Music Video Routes — REST surface for the director scene board (#1760, Phase 1).
 *
 * Project CRUD + per-scene board operations + a synchronous beat/tempo/section
 * analysis endpoint that runs the offline analyzer (Phase 0) on the project's
 * audio. Per-scene reference-frame + i2v generation and the beat-snapped render
 * are filed follow-ups; this surface covers the director MVP up to "scenes
 * arranged against the beat grid".
 */

import { musicVideoColorMatchMeasureSchema, musicVideoColorMatchReferenceUpdateSchema, musicVideoSongDraftSchema, musicVideoSongActionSchema, musicVideoSongSelectSchema, musicVideoSongFromTrackSchema, musicVideoSongSceneActionSchema, musicVideoMakingOfSelectionSchema, musicVideoAudioLayerUploadQuerySchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { activeDcp } from '../services/musicVideo/dcp.js';
import { pipeline } from 'stream/promises';
import { basename } from 'path';
import { Router } from 'express';
import storyRoutes from './musicVideoStory.js';
import festivalPacketRoutes from './musicVideoFestivalPacket.js';
import researchSeedRoutes from './musicVideoResearchSeed.js';
import blenderRoutes from './musicVideoBlender.js';
import spendRoutes from './musicVideoSpend.js';
import { musicVideoColdOpenAudioSchema, musicVideoRenderCleanupSchema, musicVideoRenderPreviewSchema, musicVideoSongStyleSunoSchema, musicVideoProjectListQuerySchema, musicVideoFinishedOutsideSchema, musicVideoPoolMarkSchema, musicVideoPoolSearchQuerySchema, musicVideoProjectPatchQuerySchema, musicVideoPoolDeleteSchema, musicVideoPoolImportSchema, musicVideoLibrarySearchQuerySchema, musicVideoPoolAddSchema, musicVideoCatalogCompletionSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { finishedOutsideBlocker } from '../lib/musicVideo/musicVideoFinishedOutside.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoAudioTimingPreviewSchema, musicVideoAudioTimingApplySchema, musicVideoProjectCreateSchema, musicVideoProjectCloneSchema, musicVideoProjectUpdateSchema, musicVideoPacingRecutSchema, musicVideoPlanRequestSchema, musicVideoManualAnalysisSchema, musicVideoSectionsEditSchema, musicVideoTranscribeMidiRequestSchema, musicVideoLyricsImportSchema, musicVideoLyricsImportTrackSchema, musicVideoLyricsAlignSchema, musicVideoLyricsVerifySchema, musicVideoSongPrepareSchema, musicVideoTakeInputSchema, musicVideoHandoffImportSchema, musicVideoTreatmentUpdateSchema, musicVideoTreatmentCompileSchema, musicVideoTreatmentApplySchema, musicVideoTreatmentSyncShotSheetSchema, musicVideoSequenceRenderSchema, musicVideoSequenceTakeSchema, musicVideoTreatmentProofReviewSchema, musicVideoCodeGenerateSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { recordRenderPinFields } from '../lib/sharedSchemas.js';
import { uploadSingle } from '../lib/multipart.js';
import { isSupportedMusicUpload, MUSIC_UPLOAD_MAX_BYTES } from '../services/pipeline/musicLibrary.js';
import { attachVocalStem, detachVocalStem } from '../services/musicVideo/vocalStem.js';
import { addAudioLayer } from '../services/musicVideo/audioLayerUpload.js';
import { listProjects, listProjectNames, listProjectPage, listProjectCompletion, getProject, createProject, cloneProject, updateProject, deleteProject, setProjectAnalysis, setProjectSections, previewProjectPacingRecut, recutProjectToPacing, appendTakesAcrossScenes, markMediaPoolAssets, refreshSongStyleFromSuno } from '../services/musicVideo/projects.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { resolveRenderVideoFile } from '../services/musicVideo/finalRenderFile.js';
import { labelProjectReferences } from '../services/musicVideo/referenceLabels.js';
import { buildHandoffManifest, buildHandoffBundle, matchSceneByFileTag } from '../services/musicVideo/handoff.js';
import { attachMidiTranscriptionSseClient, getActiveMidiTranscriptionJobId, cancelMidiTranscription } from '../services/audioMidiTranscription.js';
import { projectMidiPlanningFacts } from '../services/musicVideo/songMidiDigest.js';
import { startProjectMidiTranscription } from '../services/musicVideo/projectMidi.js';
import { analyzeAudioFileManual, buildManualAnalysisFromCached } from '../services/musicVideo/audioAnalysis.js';
import { analyzeProjectSong, resolveProjectAudioPath, setSectionsFromLyrics } from '../services/musicVideo/projectAudio.js';
import { listInFlightSceneJobs } from '../services/musicVideo/sceneJobs.js';
import { getSharingCopy, prepareSharingCopy, sharingCopyDownload } from '../services/musicVideo/sharingCopy.js';
import { renderMusicVideo, attachRenderSseClient, cancelRender, getActiveRenderJobId } from '../services/musicVideo/render.js';
import { prepareCodeRender } from '../services/musicVideo/codeRender.js';
import { DIRECTOR_STARTED } from '../services/musicVideo/productionReview.js';
import { generateMusicVideoCode, regenerateMusicVideoCodeSection } from '../services/musicVideo/codeGeneration.js';
import { getActivePublishKitBuild } from '../services/musicVideo/publishKit.js';
import { planProject } from '../services/musicVideo/planner.js';
import { parseLyricCues } from '../services/musicVideo/timedText.js';
import { attachLyricAlignSseClient, cancelLyricAlign, getActiveLyricAlignJobId, startLyricAlign } from '../services/musicVideo/lyricAlignJob.js';
import { startLyricVerify, attachLyricVerifySseClient, cancelLyricVerify } from '../services/musicVideo/lyricVerifyJob.js';
import { importTrackLyrics, MAX_LYRIC_CUES } from '../services/musicVideo/trackLyrics.js';
import { offsetLyricMarkers } from '../lib/lyricMarkers.js';
import { updateTreatment, compileTreatment, previewTreatmentApply, applyTreatment, syncTreatmentFromShotSheet, reviewProof } from '../services/musicVideo/treatmentService.js';
import { writeOriginScope } from '../lib/writeOrigin.js';
import { presentProjectForRead } from '../services/musicVideo/projectPresentation.js';
import { summarizeMusicVideoProject, compareMusicVideoProjectsNewestFirst } from '../lib/musicVideo/musicVideoSummary.js';
import { takeAssetExists } from '../services/musicVideo/takeAsset.js';
import sceneRoutes from './musicVideoScenes.js';
import castAndSetsRoutes from './musicVideoCastAndSets.js';
import publishRoutes from './musicVideoPublish.js';
import productionReviewRoutes from './musicVideoProductionReview.js';
import devArtifactRoutes from './musicVideoDevArtifacts.js';
import runRoutes from './musicVideoRuns.js';
import deliveryRoutes from './musicVideoDelivery.js';
import compositionRoutes from './musicVideoComposition.js';
import { getMusicVideoMediaPool, searchMusicVideoMediaPool, importMusicVideoPool, searchMediaLibraryForPool, addLibraryMediaToPool, deleteMusicVideoPoolAssets } from '../services/musicVideo/mediaPool.js';
import { getMusicVideoOutroStats } from '../services/musicVideo/statsOutro.js';
import { isPaginationRequested, parsePagination } from '../lib/queryValidation.js';

const router = Router();
// A take decision's reply carries the change, so its own tab can skip the refetch its broadcast asks for.
router.use(writeOriginScope);

// #3231 Phase 4 — the per-record image render pin (`imageMode`/`imageModelId`,
// the shared universe/series/sprite field pair) on Music Video projects: scene
// reference-frame renders resolve through it (imageGen/prepareParams.js).
// Extended at the route layer — the same pattern as routes/universeBuilder/ —
// so the pin stays a route-level concern and musicVideoProjectCreateSchema keeps
// the shape peers sync against. (Since #3873 the fragment lives in the leaf
// sharedSchemas.js, so musicVideoValidation.js COULD import it without the
// TDZ cycle that re-exporting through the old catch-all validation module used to cause — the route
// layer is now a choice, not a workaround.)
const projectCreateSchema = musicVideoProjectCreateSchema.extend(recordRenderPinFields);
const projectUpdateSchema = musicVideoProjectUpdateSchema.extend(recordRenderPinFields);

// Unpaged, the list is every project's summary projection (#16210): full records of every
// project ran past 100 MB, and nothing reads them; a full record is GET /:id. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares, of full records.
// `summary=1` (#10169) swaps each record for its bounded summary projection —
// newest first, with a `nextCursor` — for the project index and header picker, so
// they never load every project's scenes, runs and reviews.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(musicVideoProjectListQuerySchema, req.query);
  const summary = query.summary === '1' || query.summary === 'true';
  if (summary || isPaginationRequested(query)) {
    // The cursor is the next page's offset; `cursor` wins over `offset`.
    const cursor = parseInt(query.cursor, 10);
    const paging = parsePagination(summary && Number.isInteger(cursor) && cursor >= 0 ? { ...query, offset: String(cursor) } : query,
      { defaultLimit: 50, maxLimit: 500 });
    const needle = (query.q || '').trim().toLowerCase();
    const matchesName = needle ? (project) => String(project.name || '').toLowerCase().includes(needle) : null;
    const stale = summary && query.statusFilter
      ? new Set((await listProjectCompletion({ matchesName })).filter(({ isCompleted }) => !isCompleted).map(({ id }) => id))
      : null;
    const matchesStatus = query.statusFilter
      ? (project) => (project.status === 'complete' && !stale?.has(project.id)) === (query.statusFilter === 'completed')
      : null;
    const filter = matchesStatus || matchesName ? (project) => (!matchesStatus || matchesStatus(project)) && (!matchesName || matchesName(project)) : undefined;
    const page = await listProjectPage({ ...paging, ...(summary ? { compare: compareMusicVideoProjectsNewestFirst, filter } : {}) });
    const presented = await Promise.all(page.items.map((project) => presentProjectForRead(project)));
    const items = summary ? presented.map(project => summarizeMusicVideoProject(project, project.productionReadiness)) : presented;
    // A deletion between header selection and hydration still consumes its slot.
    const next = Math.min(page.offset + page.limit, page.total);
    return res.json({ ...page, items, ...(summary ? { nextCursor: next < page.total ? String(next) : null } : {}) });
  }
  const presented = await Promise.all((await listProjects()).map((project) => presentProjectForRead(project)));
  res.json(presented.map((project) => summarizeMusicVideoProject(project, project.productionReadiness)));
}));

router.get('/catalog-completion', asyncHandler(async (req, res) => {
  const { ingredientId } = validateRequest(musicVideoCatalogCompletionSchema, req.query);
  res.json(await listProjectCompletion({ ingredientIds: [...new Set(ingredientId)] }));
}));

// Sidebar sub-nav rows; registered before /:id so "names" is not read as an id.
router.get('/names', asyncHandler(async (_req, res) => {
  res.json(await listProjectNames());
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
  const p = await requireProject(req.params.id);
  // Transient (never persisted): lets a reloaded page reattach to a running publishing-kit build.
  const activePublishKitBuild = getActivePublishKitBuild(p.id);
  const presented = await presentProjectForRead(p, { catalogCheckinResolved: true });
  const activeDcpBuild = activeDcp(p.id);
  const activeMidiJob = getActiveMidiTranscriptionJobId(p.id);
  res.json({ ...presented, ...(activePublishKitBuild ? { activePublishKitBuild } : {}), ...(activeDcpBuild ? { activeDcpBuild } : {}), ...(activeMidiJob ? { activeMidiJob } : {}) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(projectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
}));

router.post('/:id/song-revision', asyncHandler(async (req, res) => {
  const fields = validateRequest(musicVideoSongDraftSchema, req.body);
  const { saveSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await saveSongRevision(req.params.id, fields));
}));
router.post('/:id/song-revision/generate', asyncHandler(async (req, res) => {
  const { revisionId } = validateRequest(musicVideoSongActionSchema, req.body);
  const { generateSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.status(202).json(await generateSongRevision(req.params.id, revisionId));
}));
router.post('/:id/song-revision/cancel', asyncHandler(async (req, res) => {
  const { revisionId } = validateRequest(musicVideoSongActionSchema, req.body);
  const { cancelSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await cancelSongRevision(req.params.id, revisionId));
}));
router.post('/:id/song-revision/select', asyncHandler(async (req, res) => {
  const { revisionId, songId } = validateRequest(musicVideoSongSelectSchema, req.body);
  const { selectSongRevision } = await import('../services/musicVideo/songRevision.js');
  res.json(await selectSongRevision(req.params.id, revisionId, songId));
}));

router.post('/:id/song-revision/track', asyncHandler(async (req, res) => {
  const { trackId } = validateRequest(musicVideoSongFromTrackSchema, req.body);
  const { reviseSongFromTrack } = await import('../services/musicVideo/songRevision.js');
  res.status(201).json(await reviseSongFromTrack(req.params.id, { trackId }));
}));
router.post('/:id/song-revision/scenes', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoSongSceneActionSchema, req.body);
  const { resolveSongRevisionScenes } = await import('../services/musicVideo/songRevision.js');
  res.json(await resolveSongRevisionScenes(req.params.id, body));
}));

router.post('/:id/clone', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoProjectCloneSchema, req.body || {});
  res.status(201).json(await cloneProject(req.params.id, options));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(projectUpdateSchema, req.body);
  if (data.renderHistoryId !== undefined && data.renderHistoryId !== null) {
    const current = await requireProject(req.params.id);
    if (data.renderHistoryId !== current.renderHistoryId) {
      const resolved = await resolveRenderVideoFile(data.renderHistoryId);
      if (!resolved) {
        throw new ServerError("That render is not in this machine's video history.", {
          status: 422,
          code: 'MUSIC_VIDEO_RENDER_NOT_FOUND',
        });
      }
    }
  }
  // `?edit=1`: a tab that applies board edits answers `{ edit }` where the patch allows it.
  const answerEdit = validateRequest(musicVideoProjectPatchQuerySchema, req.query).edit === '1';
  res.json(await (answerEdit ? updateProject(req.params.id, data, { edit: true }) : updateProject(req.params.id, data)));
}));

// Names references saved before catalog naming existed; answers only the labels it filled.
router.post('/:id/references/catalog-labels', asyncHandler(async (req, res) => {
  await requireProject(req.params.id);
  res.json({ labels: (await labelProjectReferences(req.params.id, { backfill: true }))?.labels || {} });
}));

// Finished outside PortOS: the earlier steps count as done without forging approvals.
router.put('/:id/finished-outside', asyncHandler(async (req, res) => {
  const { finished, note } = validateRequest(musicVideoFinishedOutsideSchema, req.body);
  if (finished) {
    const blocker = finishedOutsideBlocker(await getProject(req.params.id));
    if (blocker) throw new ServerError(blocker, { status: 409, code: 'MUSIC_VIDEO_NO_FINAL_RENDER' });
  }
  const finishedOutside = finished ? { markedAt: new Date().toISOString(), ...(note ? { note } : {}) } : null;
  await updateProject(req.params.id, { finishedOutside });
  res.json(await presentProjectForRead(await getProject(req.params.id)));
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

// Timeline audio layers (services/musicVideo/audioLayers.js): an audio file
// placed over the song at `?startSec=` (default 0:00) and mixed into the
// preview and the render. Moving, re-levelling, muting and removing a layer
// is a PATCH of `audioLayers`. The query is checked before the upload is
// written, so a refused request leaves no temp file behind.
const audioLayerUpload = uploadSingle('file', {
  limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMusicUpload(file)) cb(null, true);
    else cb(new ServerError('Unsupported audio format — accepted: MP3, WAV, M4A, OGG, FLAC', { status: 400, code: 'VALIDATION_ERROR' }));
  },
});

router.post('/:id/audio-layers', (req, res, next) => {
  res.locals.audioLayerQuery = validateRequest(musicVideoAudioLayerUploadQuerySchema, req.query);
  next();
}, audioLayerUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No audio file uploaded', { status: 400, code: 'VALIDATION_ERROR' });
  const { project, layer } = await addAudioLayer(req.params.id, {
    tempPath: req.file.path, originalName: req.file.originalname, startSec: res.locals.audioLayerQuery.startSec ?? 0,
  });
  res.json({ project: await presentProjectForRead(project), layer });
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
  const project = await requireProject(req.params.id);
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

// Director's edit of the song map: a gapless {label,startSec,endSec}[] that
// tiles the song. Energy carries over by overlap; scene section labels follow.
router.patch('/:id/analyze/sections', asyncHandler(async (req, res) => {
  const { sections } = validateRequest(musicVideoSectionsEditSchema, req.body);
  res.json(await setProjectSections(req.params.id, sections));
}));

// "Use lyric sections": take the boundaries from the aligned lyric sheet.
router.post('/:id/analyze/sections/lyrics', asyncHandler(async (req, res) => {
  res.json(await setSectionsFromLyrics(req.params.id));
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

router.use('/', storyRoutes);
router.use('/', festivalPacketRoutes);
router.use('/', researchSeedRoutes);
router.use('/', blenderRoutes);
router.use('/', spendRoutes);

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

// Read-only (#14241): which cutaway runs a `coverage: 'sequence'` scene set would
// generate in one timed request, with the exact prompt and request fields.
router.get('/:id/sequence-coverage', asyncHandler(async (req, res) => {
  const { previewSequenceCoverage } = await import('../services/musicVideo/sequenceCoverage.js');
  res.json(previewSequenceCoverage(await requireProject(req.params.id)));
}));

// Queue one planned run as a single fal request; the clip is cut onto its scenes on completion.
router.post('/:id/sequence-coverage/render', asyncHandler(async (req, res) => {
  const { sceneIds } = validateRequest(musicVideoSequenceRenderSchema, req.body ?? {});
  const { submitSequenceCoverage } = await import('../services/musicVideo/sequenceCoverage.js');
  res.status(202).json(await submitSequenceCoverage(req.params.id, { sceneIds }));
}));

// #16128: plan (`dryRun`) or queue one hosted take across a run of consecutive shots.
// The finished clip is filed whole on each shot with its own in-point; no selection changes.
router.post('/:id/sequence-takes', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoSequenceTakeSchema, req.body ?? {});
  const { sequenceTake } = await import('../services/musicVideo/sequenceTakes.js');
  const result = await sequenceTake(req.params.id, body);
  res.status(result.dryRun ? 200 : 202).json(result);
}));

router.post('/:id/treatment/apply', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoTreatmentApplySchema, req.body);
  res.json(await applyTreatment(req.params.id, options));
}));

// Deterministic: copy focal subject, camera medium and type-region rules from
// the shot sheet onto the compiled directions. No provider call.
router.post('/:id/treatment/sync-shot-sheet', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoTreatmentSyncShotSheetSchema, req.body);
  res.json(await syncTreatmentFromShotSheet(req.params.id, options));
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
  const project = await requireProject(req.params.id);
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
  // `?edit=1`: the tab applies the edit result itself, so the reply carries it instead of the project.
  const answerEdit = validateRequest(musicVideoProjectPatchQuerySchema, req.query).edit === '1';
  const updated = await updateProject(project.id, { lyricCues, lyricMarkers }, { edit: answerEdit });
  res.json(answerEdit ? { ...updated, imported: cues.length, format: detected } : { project: updated, imported: cues.length, format: detected });
}));

// Import the linked track's lyric sheet ("Use track lyrics", and the
// autopilot kickoff with `mode: 'if-empty'`, which never replaces lines).
router.post('/:id/lyrics/import-track', asyncHandler(async (req, res) => {
  const { mode = 'replace' } = validateRequest(musicVideoLyricsImportTrackSchema, req.body || {});
  const answerEdit = validateRequest(musicVideoProjectPatchQuerySchema, req.query).edit === '1';
  res.json(await importTrackLyrics(req.params.id, { mode, edit: answerEdit }));
}));

// Word-level alignment (#9074) as a job (#10155). It runs when the director
// clicks Align words or a line's Re-align, when an autopilot run starts, and
// when the song is prepared after a track or lyrics arrive (song/prepare below). Kickoff returns 202 + a jobId; stages (model download %, decoding,
// transcribing window n/m) stream over SSE with cancel, and the terminal
// `complete` frame carries the updated project. One job per project: a second
// request returns the running job (`reused: true`). The first alignment
// provisions MMS_FA only on demand. Explicit separateVocals consent creates
// a missing stem with Demucs first; older master-only callers retain Whisper.
router.post('/:id/lyrics/align', asyncHandler(async (req, res) => {
  const { cueId, separateVocals, retimeSong } = validateRequest(musicVideoLyricsAlignSchema, req.body || {});
  res.status(202).json(await startLyricAlign(req.params.id, { cueId, separateVocals, retimeSong }));
}));

router.post('/:id/lyrics/verify', asyncHandler(async (req, res) => {
  validateRequest(musicVideoLyricsVerifySchema, req.body ?? {});
  res.status(202).json(await startLyricVerify(req.params.id));
}));
router.get('/lyrics/verify/:jobId/events', (req, res) => {
  if (!attachLyricVerifySseClient(req.params.jobId, res)) throw new ServerError('Verification job not found or expired', { status: 404, code: 'NOT_FOUND' });
});
router.post('/lyrics/verify/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelLyricVerify(req.params.jobId) });
});

// Re-read the song's Suno style (excluded styles included) from its song link,
// for a song imported before they were captured. Updates the linked track too.
router.post('/:id/song-style/suno', asyncHandler(async (req, res) => {
  const { url } = validateRequest(musicVideoSongStyleSunoSchema, req.body ?? {});
  res.json(await refreshSongStyleFromSuno(req.params.id, url));
}));

// After a track is attached or lyrics are imported (the director's own action),
// analyze the song if it has no analysis and start word alignment when the
// lines were never aligned. Returns the project and the alignment job to follow.
router.post('/:id/song/prepare', asyncHandler(async (req, res) => {
  const { refresh } = validateRequest(musicVideoSongPrepareSchema, req.body ?? {});
  const { autoPrepareSong } = await import('../services/musicVideo/songAutoPrepare.js');
  res.json(await autoPrepareSong(req.params.id, { refresh }));
}));

// The director keeps the old beat grid and lyric timing against a replaced take
// (#14793): the recorded basis moves to the current audio, nothing is re-derived.
router.post('/:id/song/keep-timing', asyncHandler(async (req, res) => {
  const { keepSongTiming } = await import('../services/musicVideo/songAudio.js');
  res.json(await presentProjectForRead(await keepSongTiming(req.params.id)));
}));

// The same words alone on a transparent page, laid over the storyboard animatic's frames.
router.get('/:id/lyrics/overlay/preview', asyncHandler(async (req, res) => {
  const { buildLyricPlaythroughPreview } = await import('../services/musicVideo/lyricPlaythrough.js');
  res.json(await buildLyricPlaythroughPreview(await requireProject(req.params.id), { overlay: true }));
}));

router.get('/lyrics/align/:jobId/events', (req, res) => {
  if (!attachLyricAlignSseClient(req.params.jobId, res)) {
    throw new ServerError('Alignment job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/lyrics/align/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelLyricAlign(req.params.jobId) });
});

// Read-only: the project's live alignment, vocal-separation and MIDI jobs on
// this instance (null when none), so a reloaded Setup reattaches to each
// instead of POSTing a new run.
router.get('/:id/active-jobs', asyncHandler(async (req, res) => {
  const { getActiveVocalSeparationJobId } = await import('../services/musicVideo/vocalSeparation.js');
  res.json({
    alignment: getActiveLyricAlignJobId(req.params.id),
    separation: getActiveVocalSeparationJobId(req.params.id),
    midi: getActiveMidiTranscriptionJobId(req.params.id),
  });
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
  const project = await requireProject(req.params.id);
  res.status(202).json(await startProjectMidiTranscription(project, { model }));
}));

// What shot planning and Cast & Sets read from the transcription: a song line
// plus one line per analyzed section, the exact text the prompts quote.
router.get('/:id/midi-planning', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  const facts = await projectMidiPlanningFacts(project);
  const jobId = getActiveMidiTranscriptionJobId(project.id);
  const error = project.midiTranscriptionError || null;
  const status = jobId ? 'running' : error ? 'failed' : project.midiTranscription ? 'ready' : 'never-run';
  res.json({ facts, status, jobId, error: status === 'failed' ? error : null });
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
// Private local export; no publication or provider submission.
router.get('/:id/sharing-copy', asyncHandler(async (req, res) => {
  res.json(await getSharingCopy(req.params.id));
}));
router.post('/:id/sharing-copy', asyncHandler(async (req, res) => {
  res.status(202).json(await prepareSharingCopy(req.params.id));
}));
router.get('/:id/sharing-copy/download', asyncHandler(async (req, res) => {
  const { file, copy, modifiedAt } = await sharingCopyDownload(req.params.id);
  let stream;
  const abort = () => { if (!res.writableFinished) stream?.destroy(); };
  try {
    if (req.aborted || res.destroyed) return;
    const etag = `"${copy.hash}"`;
    res.attachment(copy.filename).type('video/mp4');
    res.set({ 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': modifiedAt.toUTCString() });
    const matches = value => value === '*' || value?.split(',').some(tag => tag.trim() === etag);
    const unmodified = Date.parse(req.get('If-Unmodified-Since'));
    if ((req.get('If-Match') && !matches(req.get('If-Match'))) || (!req.get('If-Match') && Number.isFinite(unmodified) && Math.floor(modifiedAt.getTime() / 1000) > Math.floor(unmodified / 1000))) {
      res.status(412).end(); return;
    }
    if (req.fresh) { res.status(304).end(); return; }
    let start = 0; let end = copy.bytes - 1;
    const ifRange = req.get('If-Range');
    const rangeCurrent = !ifRange || ifRange === etag || (!ifRange.includes('"') && Number.isFinite(Date.parse(ifRange)) && modifiedAt.getTime() <= Date.parse(ifRange) + 999);
    if (req.get('Range') && rangeCurrent) {
      const ranges = req.range(copy.bytes, { combine: true });
      if (ranges === -1) { res.set('Content-Range', `bytes */${copy.bytes}`); res.status(416).end(); return; }
      // Like res.download, malformed/non-byte/multipart ranges fall back to 200.
      if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
        ({ start, end } = ranges[0]);
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${copy.bytes}`);
      }
    }
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { res.end(); return; }
    stream = file.createReadStream({ start, end, autoClose: false });
    res.once('close', abort);
    req.once('aborted', abort);
    await pipeline(stream, res);
  } finally {
    res.off('close', abort);
    req.off('aborted', abort);
    stream?.destroy();
    await file.close();
  }
}));

// Assemble the scenes' i2v clips into one MP4 over the track as the master audio
// bed. Kickoff returns { jobId }; progress streams over SSE (mirrors
// videoTimeline). Per-project mutex returns 409 with the live jobId for re-attach.
// A shot-by-shot render started here picks up again after a server restart.
router.post('/:id/render', asyncHandler(async (req, res) => {
  res.json(await renderMusicVideo(req.params.id, { resumable: true, startedBy: DIRECTOR_STARTED }));
}));

// Read-only: the live final-render job for a project (null when none runs on
// this instance), so a reloaded page re-attaches without POSTing a new render.
router.get('/:id/render', (req, res) => {
  res.json({ jobId: getActiveRenderJobId(req.params.id) });
});

// The shot, look and cleanup reads and their mutations plan the render, whose performance-take
// review decodes the song master with ffmpeg; only a caller with host control
// starts that decode (#13156). Others get the plan with the take unchecked.
let authGateModule;
const planOptions = async (req) => {
  const { requestHasHostControl } = await (authGateModule ??= import('../services/authGate.js'));
  return { decode: requestHasHostControl(req) };
};

router.get('/:id/render-cleanup', asyncHandler(async (req, res) => {
  const { getRenderCleanup } = await import('../services/musicVideo/renderCleanup.js');
  res.json(await getRenderCleanup(req.params.id, await planOptions(req)));
}));
router.post('/:id/render-cleanup', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoRenderCleanupSchema, req.body ?? {});
  const { cleanupRenders } = await import('../services/musicVideo/renderCleanup.js');
  res.json(await cleanupRenders(req.params.id, input, { decode: true }));
}));

// Per-shot render segments (shotSegments.js): every shot's cache state, one
// shot's render started or stopped, and a rendered shot's silent segment.
router.get('/:id/shot-renders', asyncHandler(async (req, res) => {
  const { getShotRenderStatus } = await import('../services/musicVideo/shotSegments.js');
  res.json(await getShotRenderStatus(req.params.id, await planOptions(req)));
}));
router.post('/:id/shots/:sceneId/render', asyncHandler(async (req, res) => {
  const { startShotRender } = await import('../services/musicVideo/shotSegments.js');
  res.status(202).json(await startShotRender(req.params.id, req.params.sceneId));
}));
router.post('/:id/shots/:sceneId/render/cancel', asyncHandler(async (req, res) => {
  const { cancelShotRender } = await import('../services/musicVideo/shotSegments.js');
  res.json({ ok: cancelShotRender(req.params.id, req.params.sceneId) });
}));
// The shots rendered so far, stitched in order with the song (a seam check
// while the rest renders), and the film looks cached over the current takes.
router.post('/:id/shot-renders/preview', asyncHandler(async (req, res) => {
  const { light } = validateRequest(musicVideoRenderPreviewSchema, req.body ?? {});
  const { buildRenderPreview } = await import('../services/musicVideo/shotSegments.js');
  res.json(await buildRenderPreview(req.params.id, { light: light === true }));
}));
router.get('/:id/film-looks', asyncHandler(async (req, res) => {
  const { listFilmLooks } = await import('../services/musicVideo/shotSegments.js');
  res.json(await listFilmLooks(req.params.id, await planOptions(req)));
}));
router.delete('/:id/film-looks/:lookId', asyncHandler(async (req, res) => {
  const { deleteFilmLook } = await import('../services/musicVideo/shotSegments.js');
  res.json(await deleteFilmLook(req.params.id, req.params.lookId, { decode: true }));
}));
// The cold open's sound (shots before the song), mixed for the animatic to play
// before the song: the same mix the final render lays in front of it.
router.post('/:id/cold-open/audio', asyncHandler(async (req, res) => {
  validateRequest(musicVideoColdOpenAudioSchema, req.body ?? {});
  const { coldOpenPreviewAudio } = await import('../services/musicVideo/coldOpen.js');
  const path = await coldOpenPreviewAudio(await requireProject(req.params.id));
  if (!path) throw new ServerError('No shot plays before the song', { status: 409, code: 'NO_COLD_OPEN' });
  res.json({ name: basename(path) });
}));
router.get('/:id/cold-open/:name', asyncHandler(async (req, res) => {
  const { coldOpenAudioFile } = await import('../services/musicVideo/coldOpen.js');
  const path = coldOpenAudioFile(req.params.id, req.params.name);
  if (!path) throw new ServerError('Cold open sound not found', { status: 404, code: 'NOT_FOUND' });
  res.type('audio/wav').sendFile(path);
}));
router.get('/:id/shot-renders/:name', asyncHandler(async (req, res) => {
  const { shotSegmentFile } = await import('../services/musicVideo/shotSegments.js');
  const path = shotSegmentFile(req.params.id, req.params.name);
  if (!path) throw new ServerError('Shot render not found', { status: 404, code: 'NOT_FOUND' });
  res.type('video/mp4').sendFile(path);
}));

// Read-only: this project's in-flight scene frame/clip renders (#10154), so a
// reloaded board restores its spinners instead of letting a duplicate be submitted.
router.get('/:id/scene-jobs', (req, res) => {
  res.json({ jobs: listInFlightSceneJobs(req.params.id) });
});

router.use('/', productionReviewRoutes);

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
  const project = await requireProject(req.params.id);
  if (project.composition?.mode !== 'code') {
    throw new ServerError('Switch the render style to Code-rendered first', { status: 409, code: 'NOT_CODE_MODE' });
  }
  res.json(prepareCodeRender(project));
}));

router.post('/:id/code/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.json(await generateMusicVideoCode(req.params.id, { ...body, startedBy: DIRECTOR_STARTED }));
}));

router.post('/:id/code/sections/:sectionId/regenerate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoCodeGenerateSchema, req.body || {});
  res.json(await regenerateMusicVideoCodeSection(req.params.id, req.params.sectionId, { ...body, startedBy: DIRECTOR_STARTED }));
}));

router.use('/', compositionRoutes);

// Local making-of compilation. The preview digest binds download to the exact
// reviewed metadata, content, rights declarations and explicit asset selection.
router.get('/:id/making-of/catalog', asyncHandler(async (req, res) => {
  const { getMakingOfCatalog } = await import('../services/musicVideo/makingOf.js');
  res.json(await getMakingOfCatalog(req.params.id));
}));

router.post('/making-of/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoMakingOfSelectionSchema, req.body ?? {});
  const { compileMakingOf } = await import('../services/musicVideo/makingOf.js');
  res.json(await compileMakingOf(input));
}));

router.post('/making-of/export', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoMakingOfSelectionSchema, req.body ?? {});
  const { compileMakingOf } = await import('../services/musicVideo/makingOf.js');
  const { zip } = await compileMakingOf(input, { download: true });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="music-video-making-of.zip"');
  res.set('Cache-Control', 'no-store');
  res.send(zip);
}));

router.use('/', sceneRoutes);
router.use('/', deliveryRoutes);

router.use('/', publishRoutes);

router.use('/', runRoutes);

router.use('/', devArtifactRoutes);

router.use('/', castAndSetsRoutes);

router.get('/:id/pacing-recut', asyncHandler(async (req, res) => {
  res.json(await previewProjectPacingRecut(req.params.id));
}));

router.post('/:id/pacing-recut', asyncHandler(async (req, res) => {
  const { revision } = validateRequest(musicVideoPacingRecutSchema, req.body ?? {});
  res.json(await recutProjectToPacing(req.params.id, revision));
}));

// Every still and clip generated for this video, each naming the shots using it now (the shot card's Swap picker).
router.get('/:id/media-pool', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  res.json(await getMusicVideoMediaPool(project));
}));

// Swap's search: the pool items whose prompts (the shot's text and the prompt each file was made from) hold the words.
router.get('/:id/media-pool/search', asyncHandler(async (req, res) => {
  const { q } = validateRequest(musicVideoPoolSearchQuerySchema, req.query);
  const project = await requireProject(req.params.id);
  res.json({ items: await searchMusicVideoMediaPool(project, q) });
}));

// The cutting room floor outro's tally: what was made, kept and turned down for this video.
router.get('/:id/stats-outro', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  res.json({ stats: await getMusicVideoOutroStats(project) });
}));

// The credits ending's suggested lines: song, artist, director and album from the track and its artist.
router.get('/:id/credits-prefill', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  const { getMusicVideoCreditsPrefill } = await import('../services/musicVideo/creditsOutro.js');
  res.json({ credits: await getMusicVideoCreditsPrefill(project) });
}));

// The asset manager: mark unused stills and clips ★ ingredient / ✕ bad, or delete them from the library.
router.patch('/:id/media-pool/marks', asyncHandler(async (req, res) => {
  const { items, mark, ...options } = validateRequest(musicVideoPoolMarkSchema, req.body);
  res.json(await markMediaPoolAssets(req.params.id, items.map((item) => `${item.kind}:${item.assetId}`), mark, options, { edit: true }));
}));

// Bring an earlier draft's stills and clips into this video's assets (references; the draft is untouched).
router.post('/:id/media-pool/import', asyncHandler(async (req, res) => {
  const { fromProjectId } = validateRequest(musicVideoPoolImportSchema, req.body);
  if (fromProjectId === req.params.id) throw new ServerError('Pick another video', { status: 400, code: 'VALIDATION_ERROR' });
  const [project, from] = await Promise.all([getProject(req.params.id), getProject(fromProjectId)]);
  if (!project || !from) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const result = await importMusicVideoPool(project, from);
  res.json({ ...result, items: (await getMusicVideoMediaPool(project)).items });
}));

// Media made for this video but never filed: search the whole library by prompt, then add picks.
router.get('/:id/media-pool/library', asyncHandler(async (req, res) => {
  const { q } = validateRequest(musicVideoLibrarySearchQuerySchema, req.query);
  const project = await requireProject(req.params.id);
  res.json(await searchMediaLibraryForPool(project, q));
}));

router.post('/:id/media-pool/add', asyncHandler(async (req, res) => {
  const { items } = validateRequest(musicVideoPoolAddSchema, req.body);
  const project = await requireProject(req.params.id);
  const result = await addLibraryMediaToPool(project, items);
  res.json({ ...result, items: (await getMusicVideoMediaPool(project)).items });
}));

router.post('/:id/media-pool/delete', asyncHandler(async (req, res) => {
  const { items } = validateRequest(musicVideoPoolDeleteSchema, req.body);
  const project = await requireProject(req.params.id);
  res.json(await deleteMusicVideoPoolAssets(project, items));
}));

// Shot color match: measure takes, edit one take's numbers, or pick a group's reference.
// The picture files stay as they are; the composed render reads the numbers.
router.post('/:id/color-match/measure', asyncHandler(async (req, res) => {
  const { sceneId } = validateRequest(musicVideoColorMatchMeasureSchema, req.body ?? {});
  const { measureShotColorMatch } = await import('../services/musicVideo/shotColorMatch.js');
  res.json(await measureShotColorMatch(req.params.id, { sceneId }));
}));

router.put('/:id/color-match/reference', asyncHandler(async (req, res) => {
  const body = validateRequest(musicVideoColorMatchReferenceUpdateSchema, req.body ?? {});
  const { setShotColorMatchReference } = await import('../services/musicVideo/shotColorMatch.js');
  res.json(await setShotColorMatchReference(req.params.id, body));
}));

// --- External-asset handoff (#8965) ---
// Export per-scene prompts + reference files for a tool PortOS does not drive
// (e.g. Midjourney), and import what the director generated there. Nothing
// here contacts the external service.
router.get('/:id/handoff', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  res.json(buildHandoffManifest(project));
}));

// Downloadable ZIP counterpart (#8978): the manifest plus every reference
// image and each scene's selected frame, so nothing has to be saved out of
// the gallery by hand before attaching it in the external tool.
router.get('/:id/handoff/bundle', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
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
  const project = await requireProject(req.params.id);
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
