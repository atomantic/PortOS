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
 *   POST /api/code-animation/:id/export     queue a frame-exact MP4 render → 202 media job
 *   GET  /api/code-animation/:id/package    download a portable source package
 *   POST /api/code-animation/packages/validate   check package data/integrity only
 *   POST /api/code-animation/projects/:id/stage-runs            start a bounded production run → 202
 *   POST /api/code-animation/projects/:id/stage-runs/:runId/cancel   stop an active run
 */

import { Router } from 'express';
import { soundAssetSchema, stageProductionSoundAsset } from '../services/codeAnimation/soundAssets.js';
import { preflightProductionProject } from '../services/codeAnimation/preflight.js';
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
  pageCodeAnimationJobs,
  getCodeAnimationOptions,
  startCodeAnimationGeneration,
} from '../services/codeAnimation/index.js';
import { startCodeAnimationExport } from '../services/codeAnimation/export.js';
import { getBlenderStarterPackage } from '../services/codeAnimation/blenderStarter.js';
import { exportCodeAnimationPackage } from '../services/codeAnimation/package.js';
import { codeAnimationPackageSchema, summarizeCodeAnimationPackage } from '../lib/codeAnimationPackage.js';
import { codeAnimationProjectSchema, codeAnimationProjectPatchSchema, codeAnimationStageRunSchema } from '../lib/codeAnimationProjects.js';
import { startProductionStageRun, cancelProductionStageRun } from '../services/codeAnimation/stages.js';
import {
  createProductionProject, getProductionProject, patchProductionProject,
  listProductionProjects, getProductionHistory, importProductionPackage,
  acceptProductionSource, exportProductionPackage, exportProductionBrief,
} from '../services/codeAnimation/projects.js';
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

const uploadAudioSchema = z.object({
  source: z.literal('upload').optional().default('upload'),
  filename: uploadFilenameSchema,
  label: z.string().trim().max(200).default(''),
  durationSeconds: z.number().positive().max(60 * 60).nullable().optional(),
  notes: z.string().trim().max(L.audioNotesMax).default(''),
});

const trackAudioSchema = z.object({
  source: z.literal('track'),
  trackId: z.string().trim().min(1).max(128),
  label: z.string().trim().max(200).optional(),
  durationSeconds: z.number().positive().max(60 * 60).nullable().optional(),
  notes: z.string().trim().max(L.audioNotesMax).default(''),
});

const audioSchema = z.union([trackAudioSchema, uploadAudioSchema]).nullable().optional();

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
  audio: audioSchema,
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

const jobsPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(256).optional(),
}).strict();

router.get('/jobs', asyncHandler(async (req, res) => {
  // Existing query-less callers retain the array contract.
  res.json(Object.keys(req.query).length === 0
    ? await listCodeAnimationJobs()
    : await pageCodeAnimationJobs(validateRequest(jobsPageSchema, req.query)));
}));

router.get('/generate/:id', asyncHandler(async (req, res) => {
  const job = await getCodeAnimationJob(req.params.id);
  if (!job) throw new ServerError('Generation job not found', { status: 404, code: 'NOT_FOUND' });
  res.json(job);
}));

const exportParamsSchema = z.object({ id: z.string().uuid() }).strict();

const projectPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().regex(/^(0|[1-9][0-9]{0,8})$/).optional(),
}).strict();
const projectPage = query => {
  const { limit, cursor } = validateRequest(projectPageSchema, query);
  return { limit, offset: Number(cursor || 0) };
};
const revisionParamsSchema = exportParamsSchema.extend({ revisionId: z.string().uuid() });

router.get('/projects', asyncHandler(async (req, res) => {
  res.json(await listProductionProjects(projectPage(req.query)));
}));
router.post('/projects', asyncHandler(async (req, res) => {
  res.status(201).json(await createProductionProject(validateRequest(codeAnimationProjectSchema, req.body)));
}));
router.get('/projects/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await getProductionProject(id));
}));
router.patch('/projects/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await patchProductionProject(id, validateRequest(codeAnimationProjectPatchSchema, req.body)));
}));
router.get('/projects/:id/preflight', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await preflightProductionProject(id));
}));
router.get('/projects/:id/history', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await getProductionHistory(id, projectPage(req.query)));
}));
router.post('/projects/:id/import', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.status(201).json(await importProductionPackage(id, validateRequest(codeAnimationPackageSchema, req.body)));
}));
router.post('/projects/:id/sound-assets', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.status(201).json(await stageProductionSoundAsset(id, validateRequest(soundAssetSchema, req.body)));
}));
router.post('/projects/:id/accept', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  const { revisionId } = validateRequest(z.object({ revisionId: z.string().uuid() }).strict(), req.body);
  res.json(await acceptProductionSource(id, revisionId));
}));
// An explicit, user-started stage run (style frame → pilot → inspect → repair → final).
// 202: the run continues in the background; progress arrives as code-animation:changed.
router.post('/projects/:id/stage-runs', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  const { run } = await startProductionStageRun(id, validateRequest(codeAnimationStageRunSchema, req.body ?? {}));
  res.status(202).json(run);
}));
router.post('/projects/:id/stage-runs/:runId/cancel', asyncHandler(async (req, res) => {
  const { id, runId } = validateRequest(z.object({ id: z.string().uuid(), runId: z.string().uuid() }).strict(), req.params);
  res.json(cancelProductionStageRun(id, runId));
}));
router.get('/projects/:id/brief', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.attachment(`code-animation-brief-${id}.json`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.json(await exportProductionBrief(id));
}));
router.get('/projects/:id/revisions/:revisionId/package', asyncHandler(async (req, res) => {
  const { id, revisionId } = validateRequest(revisionParamsSchema, req.params);
  res.attachment(`code-animation-source-${revisionId}.json`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.json(await exportProductionPackage(id, revisionId));
}));

// External harness handoff is data-only. Validation grants no execution and
// neither stages imported files nor changes a saved/accepted animation.
router.get('/packages/starter/blender', asyncHandler(async (_req, res) => res.json(await getBlenderStarterPackage())));

router.post('/packages/validate', (req, res) => {
  const pkg = validateRequest(codeAnimationPackageSchema, req.body);
  res.json(summarizeCodeAnimationPackage(pkg));
});

router.get('/:id/package', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  const pkg = await exportCodeAnimationPackage(id);
  res.attachment(`code-animation-${id}.json`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.json(pkg);
}));

// Frame-exact export: the stored HTML renders through the HTML-composition
// pipeline (seek each frame, H.264 MP4, Media History) on the media queue.
// Progress streams from /api/html-composition/:jobId/events.
router.post('/:id/export', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.status(202).json(await startCodeAnimationExport(id));
}));

export default router;
