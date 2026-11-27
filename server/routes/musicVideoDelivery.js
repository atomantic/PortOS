/**
 * Delivery routes of the Music Video surface: DCP builds, review excerpts with notes, and social cuts (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { assertCancelResult } from '../lib/cancelResponse.js';
import {
  musicVideoDcpRequestSchema,
  musicVideoExcerptNoteSchema,
  musicVideoExcerptNoteUpdateSchema,
  musicVideoExcerptRequestSchema,
  musicVideoSocialCutsQuerySchema,
} from '../lib/musicVideo/routeValidation/delivery.js';
import { inspectDcpReadiness } from '../services/musicVideo/dcpPreflight.js';
import { startDcp, attachDcp, cancelDcp, dcpArtifactPaths } from '../services/musicVideo/dcp.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { startExcerptRender, attachExcerptRenderSseClient, cancelExcerptRender } from '../services/musicVideo/excerptRender.js';
import { deleteExcerpt, addReviewNote, editReviewNote, deleteReviewNote } from '../services/musicVideo/excerptService.js';
import { suggestSocialCuts } from '../services/musicVideo/socialCuts.js';

const router = Router();

// A director-chosen [startSec, endSec) window re-rendered through the same
// composed pipeline, plus a cut/cue contact sheet and timecoded review notes.
// Kickoff returns { jobId, excerptId }; progress streams over SSE (mirrors the
// full render above) on its OWN job map, so an excerpt draft and a full render
// can run at once without contending for the same mutex.
router.post('/:id/excerpt', asyncHandler(async (req, res) => {
  const { startSec, endSec, aspect, fade } = validateRequest(musicVideoExcerptRequestSchema, req.body);
  res.json(await startExcerptRender(req.params.id, { startSec, endSec, aspect, fade }));
}));

// Local cinema package: no upload or external delivery.
router.post('/:id/dcp/readiness', asyncHandler(async (req, res) => {
  res.json(await inspectDcpReadiness(req.params.id));
}));

router.post('/:id/dcp/build', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDcpRequestSchema, req.body);
  res.json(await startDcp(req.params.id, input));
}));

router.get('/dcp/:jobId/events', (req, res) => {
  if (!attachDcp(req.params.jobId, res)) throw new ServerError('Cinema package job not found or expired', { status: 404, code: 'NOT_FOUND' });
});

router.post('/dcp/:jobId/cancel', (req, res) => res.json(assertCancelResult(cancelDcp(req.params.jobId), { notFoundMessage: 'DCP export job not found' })));

router.get('/:id/dcp/:artifactId/location', asyncHandler(async (req, res) => {
  const { packagePath } = await dcpArtifactPaths(req.params.id, req.params.artifactId);
  res.json({ packagePath });
}));

router.get('/:id/dcp/:artifactId/report', asyncHandler(async (req, res) => {
  const { reportPath } = await dcpArtifactPaths(req.params.id, req.params.artifactId);
  res.download(reportPath, 'dcp-verification.txt');
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
  res.json(assertCancelResult(cancelExcerptRender(req.params.jobId), { notFoundMessage: 'Draft render job not found' }));
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

export default router;
