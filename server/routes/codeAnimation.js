/**
 * Code Animation routes — build an LLM prompt for a procedurally coded
 * animation film (and optionally run it to get the HTML).
 *
 *   GET  /api/code-animation/options        formats, limits, host contract
 *   POST /api/code-animation/prompt         resolve configurations → { prompt, attachments, frame }
 *   POST /api/code-animation/generate       start a provider run → 202 job
 *   GET  /api/code-animation/generate/:id   poll a job (html once completed)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { EFFORT_LEVELS } from '../lib/providerModels.js';
import { emptyToNull } from '../lib/zodCompat.js';
import {
  buildCodeAnimationRequest,
  getCodeAnimationJob,
  getCodeAnimationOptions,
  startCodeAnimationGeneration,
} from '../services/codeAnimation/index.js';
import {
  CODE_ANIMATION_ASPECT_RATIOS,
  CODE_ANIMATION_LIMITS,
  CODE_ANIMATION_RENDERERS,
  CODE_ANIMATION_RESOLUTIONS,
} from '../services/codeAnimation/prompt.js';

const router = Router();
const L = CODE_ANIMATION_LIMITS;

// An upload basename as POST /api/uploads returns it — never a path.
const uploadFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+$/, 'filename must be an upload basename');
const optionalId = z.preprocess(emptyToNull, z.string().trim().min(1).max(128).nullable().optional());

const briefSchema = z.object({
  title: z.string().trim().max(200).default(''),
  concept: z.string().trim().min(1, 'Describe what happens in the animation').max(L.conceptMax),
  onScreenText: z.string().trim().max(L.textMax).default(''),
  // Refinements on top of the universe style — the universe is the art direction.
  styleNotes: z.string().trim().max(L.styleNotesMax).default(''),
  format: z.object({
    durationSeconds: z.number().int().min(L.durationMin).max(L.durationMax).default(20),
    aspectRatio: z.enum(Object.keys(CODE_ANIMATION_ASPECT_RATIOS)).default('16:9'),
    resolution: z.enum(Object.keys(CODE_ANIMATION_RESOLUTIONS)).default('1080p'),
    fps: z.number().int().refine((fps) => L.fpsOptions.includes(fps), 'Unsupported frame rate').default(30),
  }).prefault({}),
  renderer: z.enum(CODE_ANIMATION_RENDERERS).default('auto'),
  interactive: z.boolean().default(false),
  soundtrack: z.enum(['none', 'procedural']).default('none'),
  universeId: optionalId,
  // Absent → follow the universe's linked board; '' / null → no board.
  moodBoardId: optionalId,
  includeMoodBoardImages: z.boolean().default(true),
  referenceImages: z.array(z.object({
    filename: uploadFilenameSchema,
    label: z.string().trim().max(200).default(''),
    note: z.string().trim().max(L.referenceNoteMax).default(''),
  })).max(L.referenceImagesMax).default([]),
  audio: z.object({
    filename: uploadFilenameSchema,
    label: z.string().trim().max(200).default(''),
    durationSeconds: z.number().positive().max(60 * 60).nullable().optional(),
    notes: z.string().trim().max(L.audioNotesMax).default(''),
  }).nullable().optional(),
}).strict();

const generateSchema = briefSchema.extend({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(256).optional(),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
}).strict();

router.get('/options', (_req, res) => {
  res.json(getCodeAnimationOptions());
});

router.post('/prompt', asyncHandler(async (req, res) => {
  const input = validateRequest(briefSchema, req.body ?? {});
  const { prompt, frame, attachments, audioUrl, moodBoardId } = await buildCodeAnimationRequest(input);
  res.json({ prompt, frame, attachments, audioUrl, moodBoardId });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(generateSchema, req.body ?? {});
  res.status(202).json(await startCodeAnimationGeneration(input));
}));

router.get('/generate/:id', asyncHandler(async (req, res) => {
  const job = getCodeAnimationJob(req.params.id);
  if (!job) throw new ServerError('Generation job not found (it may have expired or the server restarted)', { status: 404, code: 'NOT_FOUND' });
  res.json(job);
}));

export default router;
