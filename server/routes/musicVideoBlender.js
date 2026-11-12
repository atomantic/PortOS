/**
 * Music Video "Blender film" routes (`composition.mode === 'blender'`), mounted
 * under /api/music-video by routes/musicVideo.js. The film is operator-authored
 * Python that PortOS runs in Blender: these routes hold its settings, its
 * workspace source, the sync that reads its shot list, per-shot renders, cut
 * assembly and the director's notes. See docs/features/music-video-blender.md.
 *
 * Every route that runs Blender or ffmpeg, or sets what Blender will run (the
 * workspace source), is listed in lib/hostControlRoutes.js. The engine is
 * imported inside each handler: the reads never load the code that renders.
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { normalizeBlenderRecord } from '../lib/musicVideoBlender.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import {
  musicVideoBlenderCutSchema, musicVideoBlenderFileQuerySchema, musicVideoBlenderFileWriteSchema, musicVideoBlenderMediaQuerySchema,
  musicVideoBlenderNoteSchema, musicVideoBlenderRenderSchema, musicVideoBlenderSettingsSchema, musicVideoBlenderSyncSchema,
  musicVideoBlenderWorkspaceSchema,
} from '../lib/musicVideoBlenderValidation.js';

const router = Router();

// The same sandbox the other Music Video media routes serve under: a render is
// shown, never run with the PortOS origin.
const MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

const stateOf = async (projectId) => {
  const { getBlenderState } = await import('../services/musicVideo/blender/state.js');
  return getBlenderState(projectId);
};

router.get('/:id/blender', asyncHandler(async (req, res) => {
  res.json(await stateOf(req.params.id));
}));

router.put('/:id/blender/settings', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoBlenderSettingsSchema, req.body ?? {});
  const { saveBlenderSettings } = await import('../services/musicVideo/blender/record.js');
  await saveBlenderSettings(req.params.id, patch);
  res.json(await stateOf(req.params.id));
}));

router.post('/:id/blender/workspace', asyncHandler(async (req, res) => {
  validateRequest(musicVideoBlenderWorkspaceSchema, req.body ?? {});
  const { scaffoldBlenderWorkspace } = await import('../services/musicVideo/blender/sources.js');
  const { writeBlenderSong } = await import('../services/musicVideo/blender/song.js');
  const { announceBlenderState } = await import('../services/musicVideo/blender/record.js');
  const project = await requireProject(req.params.id);
  await scaffoldBlenderWorkspace(project.id);
  // An author reads song.json before the first job writes it.
  await writeBlenderSong(project, normalizeBlenderRecord(project.blender).settings);
  announceBlenderState(project.id);
  res.status(201).json(await stateOf(project.id));
}));

router.get('/:id/blender/files', asyncHandler(async (req, res) => {
  const { listBlenderFiles } = await import('../services/musicVideo/blender/sources.js');
  await requireProject(req.params.id);
  res.json(await listBlenderFiles(req.params.id));
}));

router.get('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderFileQuerySchema, req.query);
  const { readBlenderFile } = await import('../services/musicVideo/blender/sources.js');
  await requireProject(req.params.id);
  res.json(await readBlenderFile(req.params.id, path));
}));

router.put('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path, content } = validateRequest(musicVideoBlenderFileWriteSchema, req.body ?? {});
  const { writeBlenderFile } = await import('../services/musicVideo/blender/sources.js');
  const { announceBlenderState } = await import('../services/musicVideo/blender/record.js');
  await requireProject(req.params.id);
  await writeBlenderFile(req.params.id, path, content);
  announceBlenderState(req.params.id);
  res.json(await stateOf(req.params.id));
}));

router.delete('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderFileQuerySchema, req.query);
  const { deleteBlenderFile } = await import('../services/musicVideo/blender/sources.js');
  const { announceBlenderState } = await import('../services/musicVideo/blender/record.js');
  await requireProject(req.params.id);
  await deleteBlenderFile(req.params.id, path);
  announceBlenderState(req.params.id);
  res.json(await stateOf(req.params.id));
}));

// describe is the operator's code and may run for minutes: the sync is a job, not a held request.
router.post('/:id/blender/sync', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderSyncSchema, req.body ?? {});
  const { startBlenderSync } = await import('../services/musicVideo/blender/sync.js');
  res.status(202).json(await startBlenderSync(req.params.id, input));
}));

// What the workspace takes on disk. Walks every rendered frame, so it is its own read, not part of the state.
router.get('/:id/blender/usage', asyncHandler(async (req, res) => {
  const { getBlenderDiskUsage } = await import('../services/musicVideo/blender/usage.js');
  res.json(await getBlenderDiskUsage(req.params.id));
}));

router.post('/:id/blender/frames/clear', asyncHandler(async (req, res) => {
  const { clearBlenderFrames } = await import('../services/musicVideo/blender/usage.js');
  res.json(await clearBlenderFrames(req.params.id));
}));

router.post('/:id/blender/render', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderRenderSchema, req.body ?? {});
  const { enqueueBlenderRenders } = await import('../services/musicVideo/blender/queue.js');
  res.status(202).json(await enqueueBlenderRenders(req.params.id, input));
}));

router.post('/:id/blender/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
  const { cancelBlenderJob } = await import('../services/musicVideo/blender/queue.js');
  res.json({ ok: await cancelBlenderJob(req.params.id, req.params.jobId) });
}));

router.post('/:id/blender/cancel', asyncHandler(async (req, res) => {
  const { cancelBlenderProjectJobs } = await import('../services/musicVideo/blender/queue.js');
  res.json({ ok: await cancelBlenderProjectJobs(req.params.id) });
}));

router.post('/:id/blender/cut', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderCutSchema, req.body ?? {});
  const { startBlenderCut } = await import('../services/musicVideo/blender/cuts.js');
  res.status(202).json(await startBlenderCut(req.params.id, input));
}));

router.put('/:id/blender/shots/:shotId/note', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderNoteSchema, req.body ?? {});
  const { saveBlenderShotNote } = await import('../services/musicVideo/blender/record.js');
  await saveBlenderShotNote(req.params.id, req.params.shotId, input);
  res.json(await stateOf(req.params.id));
}));

router.post('/:id/blender/shots/:shotId/open', asyncHandler(async (req, res) => {
  const { openBlenderShot } = await import('../services/musicVideo/blender/open.js');
  res.json(await openBlenderShot(req.params.id, req.params.shotId));
}));

// A file under renders/: a shot video, a frame, a still, a cut or a job log.
// express' sendFile answers Range requests, which a scrubbing player needs.
router.get('/:id/blender/media', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderMediaQuerySchema, req.query);
  const { resolveBlenderMedia } = await import('../services/musicVideo/blender/workspace.js');
  await requireProject(req.params.id);
  const { absolute, type } = await resolveBlenderMedia(req.params.id, path);
  res.setHeader('Content-Security-Policy', MEDIA_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(type);
  res.sendFile(absolute, { dotfiles: 'deny' });
}));

export default router;
