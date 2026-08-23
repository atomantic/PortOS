/**
 * Video Timeline Routes — non-linear editor backend.
 *
 * Project CRUD + render pipeline. Render emits SSE progress on the same
 * pattern as videoGen so the client can reuse EventSource wiring. Output
 * lands in the existing video-history.json with a `timelineProjectId` flag.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  renderProject,
  attachSseClient,
  cancelRender,
} from '../services/videoTimeline/local.js';
import {
  IMAGE_ASSET_KINDS,
  AUDIO_ASSET_KINDS,
  MAX_SEGMENTS,
  MAX_OVERLAYS,
  MAX_AUDIO_TRACKS,
  MAX_FADE_SEC,
  MAX_STILL_SEC,
  MAX_VOLUME,
} from '../services/videoTimeline/segments.js';

const router = Router();

// Lane schemas mirror server/services/videoTimeline/segments.js. Zod is the
// coarse shape/bounds gate at the edge; the service validators re-check the
// cross-field rules (fades fitting inside their own duration, asset
// containment under an allowlisted data/ subdirectory) that a schema can't
// express against the filesystem. That split is deliberate — but the kind
// lists and the numeric bounds come FROM the service, so a new asset kind or a
// raised cap can't be accepted by one layer and 400'd by the other.
const fadeFields = {
  fadeInSec: z.number().min(0).max(MAX_FADE_SEC).optional(),
  fadeOutSec: z.number().min(0).max(MAX_FADE_SEC).optional(),
};

const outAfterIn = [
  (c) => c.outSec > c.inSec,
  { message: 'outSec must be > inSec', path: ['outSec'] },
];
const clipTrimFields = {
  clipId: z.string().guid(),
  inSec: z.number().min(0),
  outSec: z.number().min(0),
};

const assetFields = (kinds) => ({
  assetKind: z.enum(kinds),
  // Basename only — the service resolves it under the kind's data/ root and
  // refuses anything that escapes.
  assetFile: z.string().min(1).max(255),
});

const clipSchema = z.object(clipTrimFields).refine(...outAfterIn);

const clipSegmentSchema = z.object({
  type: z.literal('clip'),
  ...clipTrimFields,
  volume: z.number().min(0).max(MAX_VOLUME).optional(),
  ...fadeFields,
}).refine(...outAfterIn);

const stillSegmentSchema = z.object({
  type: z.literal('still'),
  ...assetFields(IMAGE_ASSET_KINDS),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  ...fadeFields,
});

const segmentSchema = z.discriminatedUnion('type', [clipSegmentSchema, stillSegmentSchema]);

const overlaySchema = z.object({
  type: z.literal('image').optional(),
  ...assetFields(IMAGE_ASSET_KINDS),
  startSec: z.number().min(0),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  // Normalized to the canonical canvas so placement survives a change of
  // canonical dimensions. Slight overscan lets a graphic bleed off-frame.
  x: z.number().min(-1).max(2).optional(),
  y: z.number().min(-1).max(2).optional(),
  width: z.number().gt(0).max(4).optional(),
  opacity: z.number().min(0).max(1).optional(),
  ...fadeFields,
});

const audioTrackSchema = z.object({
  ...assetFields(AUDIO_ASSET_KINDS),
  startSec: z.number().min(0),
  offsetSec: z.number().min(0).optional(),
  durationSec: z.number().gt(0).max(MAX_STILL_SEC),
  volume: z.number().min(0).max(MAX_VOLUME).optional(),
  ...fadeFields,
});

const audioSchema = z.object({
  clipVolume: z.number().min(0).max(MAX_VOLUME).optional(),
  tracks: z.array(audioTrackSchema).max(MAX_AUDIO_TRACKS).optional(),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
});

const PATCHABLE_KEYS = ['name', 'clips', 'segments', 'overlays', 'audio'];

const updateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // `clips` is the v1 video lane. Still accepted so an older client (or an
  // older peer-authored payload) keeps working; the service upgrades it to
  // clip segments, and `segments` wins when both are present.
  clips: z.array(clipSchema).max(MAX_SEGMENTS).optional(),
  segments: z.array(segmentSchema).max(MAX_SEGMENTS).optional(),
  overlays: z.array(overlaySchema).max(MAX_OVERLAYS).optional(),
  audio: audioSchema.optional(),
  expectedUpdatedAt: z.string().optional(),
}).refine((b) => PATCHABLE_KEYS.some((k) => b[k] !== undefined), {
  message: `PATCH body must include at least one of: ${PATCHABLE_KEYS.join(', ')}`,
});

// Backward-compatible by default: returns the full projects array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/projects', asyncHandler(async (req, res) => {
  const projects = await listProjects();
  if (!isPaginationRequested(req.query)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const data = validateRequest(createBodySchema, req.body);
  res.status(201).json(await createProject(data.name));
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(project);
}));

router.patch('/projects/:id', asyncHandler(async (req, res) => {
  const { expectedUpdatedAt, ...patch } = validateRequest(updateBodySchema, req.body);
  res.json(await updateProject(req.params.id, patch, expectedUpdatedAt));
}));

router.delete('/projects/:id', asyncHandler(async (req, res) => {
  res.json(await deleteProject(req.params.id));
}));

router.post('/projects/:id/render', asyncHandler(async (req, res) => {
  res.json(await renderProject(req.params.id));
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

router.post('/:jobId/cancel', (req, res) => {
  const cancelled = cancelRender(req.params.jobId);
  res.json({ ok: cancelled });
});

export default router;
