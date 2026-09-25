/**
 * Code Animation routes — build an LLM prompt for a procedurally coded
 * animation film (and optionally run it to get the HTML).
 *
 *   GET  /api/code-animation/options        formats, limits, host contract
 *   POST /api/code-animation/brief          write a brief from the universe → { brief }
 *   POST /api/code-animation/prompt         resolve configurations → { prompt, attachments, frame }
 *   POST /api/code-animation/generate       start a provider run → 202 job
 *   GET  /api/code-animation/jobs           list saved jobs for the gallery
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
  generateCodeAnimationBrief,
  getCodeAnimationJob,
  listCodeAnimationJobs,
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

const formatSchema = z.object({
  durationSeconds: z.number().int().min(L.durationMin).max(L.durationMax).default(20),
  aspectRatio: z.enum(Object.keys(CODE_ANIMATION_ASPECT_RATIOS)).default('16:9'),
  resolution: z.enum(Object.keys(CODE_ANIMATION_RESOLUTIONS)).default('1080p'),
  fps: z.number().int().refine((fps) => L.fpsOptions.includes(fps), 'Unsupported frame rate').default(30),
});

const briefSchema = z.object({
  title: z.string().trim().max(L.titleMax).default(''),
  concept: z.string().trim().min(1, 'Describe what happens in the animation').max(L.conceptMax),
  // The lead characters' design bible — what the coding model rigs.
  cast: z.string().trim().max(L.castMax).default(''),
  onScreenText: z.string().trim().max(L.textMax).default(''),
  // Refinements on top of the universe style — the universe is the art direction.
  styleNotes: z.string().trim().max(L.styleNotesMax).default(''),
  format: formatSchema.prefault({}),
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
  seedIdea: z.string().trim().max(L.seedIdeaMax).default(''),
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(256).optional(),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
}).strict();

// Writing the brief needs only the art-direction selections plus whatever the
// artist has typed so far — never the uploads or audio, which condition the
// picture, not the story.
const briefIdeaSchema = z.object({
  universeId: optionalId,
  moodBoardId: optionalId,
  seedIdea: z.string().trim().max(L.seedIdeaMax).default(''),
  // The same brief, partially filled — derived from briefSchema so the field
  // caps are stated once, with `concept` relaxed because there may be none yet.
  current: briefSchema
    .pick({ title: true, cast: true, onScreenText: true, styleNotes: true })
    .extend({ concept: z.string().trim().max(L.conceptMax).default('') })
    .prefault({}),
  // Only the two the writer's prompt reads — the renderer, fps, and resolution
  // condition the picture, not the story.
  format: formatSchema.pick({ durationSeconds: true, aspectRatio: true }).prefault({}),
  providerId: z.string().trim().max(128).optional(),
  model: z.string().trim().max(256).optional(),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
}).strict();

router.get('/options', (_req, res) => {
  res.json(getCodeAnimationOptions());
});

router.post('/brief', asyncHandler(async (req, res) => {
  res.json(await generateCodeAnimationBrief(validateRequest(briefIdeaSchema, req.body ?? {})));
}));

router.post('/prompt', asyncHandler(async (req, res) => {
  const input = validateRequest(briefSchema, req.body ?? {});
  const { prompt, frame, attachments, audioUrl, moodBoardId } = await buildCodeAnimationRequest(input);
  res.json({ prompt, frame, attachments, audioUrl, moodBoardId });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(generateSchema, req.body ?? {});
  res.status(202).json(await startCodeAnimationGeneration(input));
}));

router.get('/jobs', asyncHandler(async (_req, res) => {
  res.json(await listCodeAnimationJobs());
}));

router.get('/generate/:id', asyncHandler(async (req, res) => {
  const job = await getCodeAnimationJob(req.params.id);
  if (!job) throw new ServerError('Generation job not found', { status: 404, code: 'NOT_FOUND' });
  res.json(job);
}));

export default router;
