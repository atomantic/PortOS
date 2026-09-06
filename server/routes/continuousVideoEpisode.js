/**
 * Continuous-video episode routes (#6227) — submit a script + bible for
 * chained multi-clip generation and track its progress. Mirrors the
 * SSE-progress shape `server/routes/videoGen.js` uses for single renders and
 * chains, over its own outer-job registry (`continuousVideo.js`) since an
 * episode is not a mediaJobQueue entry.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { getSettings } from '../services/settings.js';
import { lintClips } from '../lib/videoPromptLinter.js';
import {
  generateContinuousVideoEpisode, composeEpisodeClips, attachEpisodeSseClient, CONTINUOUS_VIDEO_BACKENDS,
} from '../services/videoGen/continuousVideo.js';

const router = Router();

const lineSchema = z.object({
  type: z.enum(['action', 'dialogue']),
  speaker: z.string().min(1).max(200).optional(),
  voice: z.string().max(200).optional(),
  text: z.string().max(4000),
});

const sceneSchema = z.object({
  sceneId: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  lines: z.array(lineSchema).min(1),
});

const bibleEntrySchema = z.object({ descriptor: z.string().min(1).max(2000) });
const bibleSchema = z.object({
  styleDescriptor: z.string().max(2000).optional(),
  cast: z.record(bibleEntrySchema).optional(),
  locations: z.record(bibleEntrySchema).optional(),
});

// Backend render knobs a caller may steer. `settings`/`pythonPath` are always
// server-resolved below and never accepted here — Zod strips any unknown key
// (including an attempted apiKey/pythonPath/settings override) by default.
const renderOptionsSchema = z.object({
  modelId: z.string().max(64).optional(),
  width: z.number().min(64).max(2048).optional(),
  height: z.number().min(64).max(2048).optional(),
  negativePrompt: z.string().max(8000).optional(),
  seed: z.number().optional(),
  falModelId: z.string().min(1).max(200).optional(),
  falDuration: z.number().min(1).max(60).optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
  reactorSeconds: z.number().min(1).max(60).optional(),
});

const compilerOptionsSchema = z.object({
  maxWords: z.number().int().positive().max(200).optional(),
  maxSpeakers: z.number().int().positive().max(10).optional(),
  maxChainLength: z.number().int().positive().max(50).optional(),
  fps: z.number().positive().max(60).optional(),
  frameGrid: z.enum(['uniform', '17n+5']).optional(),
});

const previewBodySchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(200),
  bible: bibleSchema,
  framings: z.array(z.string().max(200).nullable()).max(2000).optional(),
  compilerOptions: compilerOptionsSchema.optional(),
});

const submitBodySchema = previewBodySchema.extend({
  backend: z.enum(CONTINUOUS_VIDEO_BACKENDS).optional(),
  renderOptions: renderOptionsSchema.optional(),
});

// Compose+lint without submitting anything — the Episode Composer UI calls
// this on every scene edit to render a live beat/lint preview before the
// user queues generation. Never touches a backend or settings.
router.post('/lint', asyncHandler(async (req, res) => {
  const parsed = previewBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const {
    scenes, bible, framings, compilerOptions,
  } = parsed.data;
  const clips = composeEpisodeClips({
    scenes, bible, framings, compilerOptions,
  });
  const lint = lintClips(clips, { bible });
  res.json({ clips, lint });
}));

router.post('/', asyncHandler(async (req, res) => {
  const parsed = submitBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const {
    scenes, bible, framings, backend, renderOptions, compilerOptions,
  } = parsed.data;

  // Lint BEFORE anything is submitted to a backend — a rule-violating clip
  // prompt is rejected here, synchronously, rather than surfacing only later
  // over the SSE progress stream.
  const clips = composeEpisodeClips({
    scenes, bible, framings, compilerOptions,
  });
  const lint = lintClips(clips, { bible });
  if (!lint.pass) {
    throw new ServerError('One or more clip prompts failed the continuous-video lint', {
      status: 422, code: 'VIDEO_PROMPT_LINT_FAILED', context: { lint },
    });
  }

  const settings = await getSettings();
  const jobId = randomUUID();
  // The orchestrator runs its own multi-clip chain in the background and
  // reports progress over `GET /:jobId/events` (attachEpisodeSseClient) —
  // matches the queued-then-SSE contract every other video-gen submit uses.
  generateContinuousVideoEpisode({
    backend,
    jobId,
    // Already compiled + linted above — pass the finished clips through
    // rather than recompiling the script a second time (bible/scenes are
    // only needed to build clips, which is done).
    clips,
    renderOptions: {
      ...renderOptions,
      settings,
      pythonPath: settings.imageGen?.local?.pythonPath || null,
    },
  }).catch((err) => {
    console.log(`❌ Continuous video episode [${jobId.slice(0, 8)}] orchestration crashed: ${err.message}`);
  });

  res.json({ jobId, generationId: jobId, status: 'running' });
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachEpisodeSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

export default router;
