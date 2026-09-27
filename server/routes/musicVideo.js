/**
 * Music Video Routes — REST surface for the director scene board (#1760, Phase 1).
 *
 * Project CRUD + per-scene board operations + a synchronous beat/tempo/section
 * analysis endpoint that runs the offline analyzer (Phase 0) on the project's
 * audio. Per-scene reference-frame + i2v generation and the beat-snapped render
 * are filed follow-ups; this surface covers the director MVP up to "scenes
 * arranged against the beat grid".
 */

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
  musicVideoPlanRequestSchema,
  musicVideoManualAnalysisSchema,
  musicVideoTranscribeMidiRequestSchema,
  musicVideoLyricsImportSchema,
  musicVideoTakeInputSchema,
  musicVideoTakeReviewSchema,
  musicVideoHandoffImportSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import { recordRenderPinFields } from '../lib/sharedSchemas.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { resolveGalleryImage } from '../lib/pathSafety.js';
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
import { planProject } from '../services/musicVideo/planner.js';
import { parseLyricCues } from '../services/musicVideo/timedText.js';
import { getTrack } from '../services/tracks/index.js';

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
  const updated = await setProjectAnalysis(project.id, analysis);
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

// Import timed lyric cues (#8964) from pasted LRC, SRT/WebVTT, or plain lines
// (plain lines arrive untimed, ready to be timed by hand). `replace` swaps the
// project's cue list; `append` adds after it. The cues persist through the
// ordinary project PATCH path, so ids/normalization match hand edits.
const MAX_LYRIC_CUES = 2000;
router.post('/:id/lyrics/import', asyncHandler(async (req, res) => {
  const { format = 'auto', text, mode = 'replace' } = validateRequest(musicVideoLyricsImportSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { format: detected, cues } = parseLyricCues(text, format);
  if (cues.length === 0) {
    throw new ServerError(`No lyric lines found in the ${detected} text`, { status: 422, code: 'NO_LYRICS' });
  }
  const lyricCues = mode === 'append' ? [...(project.lyricCues || []), ...cues] : cues;
  if (lyricCues.length > MAX_LYRIC_CUES) {
    throw new ServerError(`A project holds at most ${MAX_LYRIC_CUES} lyric cues`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const updated = await updateProject(project.id, { lyricCues });
  res.json({ project: updated, imported: cues.length, format: detected });
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
  const { kind, assetId, source = 'imported', provider, originalName } = validateRequest(musicVideoTakeInputSchema, req.body);
  if (!(await takeAssetExists(kind, assetId))) {
    throw new ServerError(`${kind === 'image' ? 'Image' : 'Video'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  const { scene, appended } = await appendSceneTakes(req.params.id, req.params.sceneId, [{
    kind, assetId, source, provider: provider ?? (source === 'generated' ? 'portos' : null), originalName,
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
    accepted.push({ sceneId, kind: item.kind, assetId: item.assetId, source: 'imported', provider, originalName: item.originalName });
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
