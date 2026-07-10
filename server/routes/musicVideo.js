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
  musicVideoProjectUpdateSchema,
  musicVideoSceneCreateSchema,
  musicVideoSceneUpdateSchema,
  musicVideoSceneReorderSchema,
  musicVideoPlanRequestSchema,
  musicVideoTranscribeMidiRequestSchema,
} from '../lib/validation.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  setProjectAnalysis,
  addProjectScene,
  updateScene,
  deleteScene,
  reorderProjectScenes,
  setProjectMidiTranscription,
} from '../services/musicVideo/projects.js';
import {
  startMidiTranscription,
  attachMidiTranscriptionSseClient,
  cancelMidiTranscription,
} from '../services/audioMidiTranscription.js';
import { analyzeAudioFile } from '../services/musicVideo/audioAnalysis.js';
import { renderMusicVideo, attachRenderSseClient, cancelRender } from '../services/musicVideo/render.js';
import { planProject } from '../services/musicVideo/planner.js';
import { getTrack } from '../services/tracks/index.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listProjects());
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(p);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoProjectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoProjectUpdateSchema, req.body);
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

export default router;
