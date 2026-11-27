/**
 * Continuous-video episode routes (#6227) — submit a script + bible for
 * chained multi-clip generation and track its progress. Mirrors the
 * SSE-progress shape `server/routes/videoGen.js` uses for single renders and
 * chains, over its own outer-job registry (`continuousVideo.js`) since an
 * episode is not a mediaJobQueue entry.
 */

import { previewBodySchema, submitBodySchema } from '../lib/continuousVideoEpisodeValidation.js';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { getSettings } from '../services/settings.js';
import { lintClips } from '../lib/videoPromptLinter.js';
import {
  generateContinuousVideoEpisode,
  composeEpisodeClips,
  attachEpisodeSseClient,
  resolveEpisodeContinuity,
  listActiveContinuousVideoEpisodes,
  cancelContinuousVideoEpisode,
} from '../services/videoGen/continuousVideo.js';

const router = Router();

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
  await resolveEpisodeContinuity({ backend, renderOptions });
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
    console.error(`❌ Continuous video episode [${jobId.slice(0, 8)}] orchestration crashed: ${err.message}`);
  });

  res.json({ jobId, generationId: jobId, status: 'running' });
}));

router.get('/active', (_req, res) => {
  const episodes = listActiveContinuousVideoEpisodes();
  res.json({
    activeEpisodes: episodes,
    activeEpisode: episodes.length ? episodes[episodes.length - 1] : null,
  });
});

router.post('/:jobId/cancel', asyncHandler(async (req, res) => {
  const result = await cancelContinuousVideoEpisode(req.params.jobId);
  if (!result.ok) {
    const status = result.code === 'ALREADY_TERMINAL' ? 409 : 404;
    throw new ServerError(result.error || 'Cancel failed', { status, code: result.code || 'NOT_FOUND' });
  }
  res.json(result);
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachEpisodeSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

export default router;
