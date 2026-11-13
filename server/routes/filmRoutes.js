/** Shared film routes; the owner resolver verifies domain membership before every operation. */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { normalizeBlenderRecord } from '../lib/musicVideoBlender.js';
import {
  musicVideoBlenderCutSchema, musicVideoBlenderFileQuerySchema, musicVideoBlenderFileWriteSchema, musicVideoBlenderMediaQuerySchema,
  musicVideoBlenderNoteSchema, musicVideoBlenderRenderSchema, musicVideoBlenderSettingsSchema, musicVideoBlenderSyncSchema,
  musicVideoBlenderWorkspaceSchema,
} from '../lib/musicVideoBlenderValidation.js';

export function createFilmRoutes({ resolveOwner, readState, startCut }) {
const router = Router();
const ownerOf = (req) => resolveOwner(req.params.id);

// The same sandbox the other Music Video media routes serve under: a render is
// shown, never run with the PortOS origin.
const MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

const stateOf = async (owner) => {
  const { getBlenderState } = await import('../services/film/state.js');
  return readState ? readState(owner) : getBlenderState(owner);
};

router.get('/:id/blender', asyncHandler(async (req, res) => {
  res.json(await stateOf(await ownerOf(req)));
}));

router.put('/:id/blender/settings', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoBlenderSettingsSchema, req.body ?? {});
  const { saveBlenderSettings } = await import('../services/film/record.js');
  await saveBlenderSettings(await ownerOf(req), patch);
  res.json(await stateOf(await ownerOf(req)));
}));

router.post('/:id/blender/workspace', asyncHandler(async (req, res) => {
  validateRequest(musicVideoBlenderWorkspaceSchema, req.body ?? {});
  const { scaffoldBlenderWorkspace } = await import('../services/film/sources.js');
  const { writeBlenderSong } = await import('../services/film/song.js');
  const { announceBlenderState } = await import('../services/film/record.js');
  const owner = await ownerOf(req);
  await scaffoldBlenderWorkspace(owner);
  // An author reads song.json before the first job writes it.
  await writeBlenderSong(owner, normalizeBlenderRecord(await owner.readRecord()).settings);
  announceBlenderState(owner);
  res.status(201).json(await stateOf(owner));
}));

router.get('/:id/blender/files', asyncHandler(async (req, res) => {
  const { listBlenderFiles } = await import('../services/film/sources.js');
  res.json(await listBlenderFiles(await ownerOf(req)));
}));

router.get('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderFileQuerySchema, req.query);
  const { readBlenderFile } = await import('../services/film/sources.js');
  res.json(await readBlenderFile(await ownerOf(req), path));
}));

router.put('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path, content } = validateRequest(musicVideoBlenderFileWriteSchema, req.body ?? {});
  const { writeBlenderFile } = await import('../services/film/sources.js');
  const { announceBlenderState } = await import('../services/film/record.js');
  await writeBlenderFile(await ownerOf(req), path, content);
  announceBlenderState(await ownerOf(req));
  res.json(await stateOf(await ownerOf(req)));
}));

router.delete('/:id/blender/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderFileQuerySchema, req.query);
  const { deleteBlenderFile } = await import('../services/film/sources.js');
  const { announceBlenderState } = await import('../services/film/record.js');
  await deleteBlenderFile(await ownerOf(req), path);
  announceBlenderState(await ownerOf(req));
  res.json(await stateOf(await ownerOf(req)));
}));

// describe is the operator's code and may run for minutes: the sync is a job, not a held request.
router.post('/:id/blender/sync', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderSyncSchema, req.body ?? {});
  const { startBlenderSync } = await import('../services/film/sync.js');
  res.status(202).json(await startBlenderSync(await ownerOf(req), input));
}));

// What the workspace takes on disk. Walks every rendered frame, so it is its own read, not part of the state.
router.get('/:id/blender/usage', asyncHandler(async (req, res) => {
  const { getBlenderDiskUsage } = await import('../services/film/usage.js');
  res.json(await getBlenderDiskUsage(await ownerOf(req)));
}));

router.post('/:id/blender/frames/clear', asyncHandler(async (req, res) => {
  const { clearBlenderFrames } = await import('../services/film/usage.js');
  res.json(await clearBlenderFrames(await ownerOf(req)));
}));

router.post('/:id/blender/render', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderRenderSchema, req.body ?? {});
  const { enqueueBlenderRenders } = await import('../services/film/queue.js');
  res.status(202).json(await enqueueBlenderRenders(await ownerOf(req), input));
}));

router.post('/:id/blender/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
  const { cancelBlenderJob } = await import('../services/film/queue.js');
  res.json({ ok: await cancelBlenderJob(await ownerOf(req), req.params.jobId) });
}));

router.post('/:id/blender/cancel', asyncHandler(async (req, res) => {
  const { cancelBlenderProjectJobs } = await import('../services/film/queue.js');
  res.json({ ok: await cancelBlenderProjectJobs(await ownerOf(req)) });
}));

router.post('/:id/blender/cut', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderCutSchema, req.body ?? {});
  const { startBlenderCut } = await import('../services/film/cuts.js');
  res.status(202).json(await (startCut || startBlenderCut)(await ownerOf(req), input));
}));

router.put('/:id/blender/shots/:shotId/note', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoBlenderNoteSchema, req.body ?? {});
  const { saveBlenderShotNote } = await import('../services/film/record.js');
  await saveBlenderShotNote(await ownerOf(req), req.params.shotId, input);
  res.json(await stateOf(await ownerOf(req)));
}));

router.post('/:id/blender/shots/:shotId/open', asyncHandler(async (req, res) => {
  const { openBlenderShot } = await import('../services/film/open.js');
  res.json(await openBlenderShot(await ownerOf(req), req.params.shotId));
}));

// A file under renders/: a shot video, a frame, a still, a cut or a job log.
// express' sendFile answers Range requests, which a scrubbing player needs.
router.get('/:id/blender/media', asyncHandler(async (req, res) => {
  const { path } = validateRequest(musicVideoBlenderMediaQuerySchema, req.query);
  const { resolveBlenderMedia } = await import('../services/film/workspace.js');
  const { absolute, type } = await resolveBlenderMedia(await ownerOf(req), path);
  res.setHeader('Content-Security-Policy', MEDIA_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(type);
  res.sendFile(absolute, { dotfiles: 'deny' });
}));

return router;
}
