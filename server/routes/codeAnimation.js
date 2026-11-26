/**
 * Code Animation routes — build an LLM prompt for a procedurally coded
 * animation film (and optionally run it to get the HTML).
 *
 *   GET  /api/code-animation/options        formats, limits, host contract
 *   GET  /api/code-animation/vendor/three   the vendored three.js modules the preview inlines
 *   POST /api/code-animation/brief          write a brief from the universe → { brief }
 *   POST /api/code-animation/prompt         resolve configurations → { prompt, attachments, frame }
 *   POST /api/code-animation/generate       start a provider run → 202 job
 *   POST /api/code-animation/generate/:id/cancel  cancel an active generation → job
 *   GET  /api/code-animation/jobs           list saved jobs for the gallery
 *   GET  /api/code-animation/jobs/:id/poster   a completed job's gallery poster (JPEG)
 *   POST /api/code-animation/jobs/:id/poster   capture a missing poster → { posterVersion } (null when it could not be drawn)
 *   GET  /api/code-animation/generate/:id   poll a job (html once completed)
 *   POST /api/code-animation/:id/export     queue a frame-exact MP4 render → 202 media job
 *   GET  /api/code-animation/:id/package    download a portable source package
 *   POST /api/code-animation/packages/validate   check package data/integrity only
 *   POST /api/code-animation/projects/:id/stage-runs            start a bounded production run → 202
 *   POST /api/code-animation/projects/:id/stage-runs/:runId/cancel   stop an active run
 *   GET  /api/code-animation/projects/:id/acceptance      accepted output + freshness + run comparison
 *   POST /api/code-animation/projects/:id/accepted-output promote a passing run's video
 */

import { Router } from 'express';
import codeAnimationFilms from './codeAnimationFilms.js';
import { soundAssetSchema, stageProductionSoundAsset } from '../services/codeAnimation/soundAssets.js';
import { ensureCodeAnimationSoundtrackTrack, startCodeAnimationSoundtrack } from '../services/codeAnimation/soundtrack.js';
import { preflightProductionProject } from '../services/codeAnimation/preflight.js';
import {
  briefSchema,
  generateSchema,
  briefIdeaSchema,
  jobsPageSchema,
  exportParamsSchema,
  projectPageSchema,
  revisionParamsSchema,
  soundtrackSchema,
  revisionBodySchema,
  stageRunParamsSchema,
  acceptRunBodySchema,
} from '../lib/codeAnimationValidation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  buildCodeAnimationRequest,
  cancelCodeAnimationGeneration,
  captureCodeAnimationJobPoster,
  codeAnimationPosterPath,
  deleteCodeAnimationJob,
  generateCodeAnimationBrief,
  getCodeAnimationJob,
  listCodeAnimationJobs,
  pageCodeAnimationJobs,
  getCodeAnimationOptions,
  startCodeAnimationGeneration,
} from '../services/codeAnimation/index.js';
import { startCodeAnimationExport } from '../services/codeAnimation/export.js';
import { getBlenderStarterPackage } from '../services/codeAnimation/blenderStarter.js';
import { lastCheckedBlenderVersion } from '../services/codeAnimation/execution.js';
import { exportCodeAnimationPackage } from '../services/codeAnimation/package.js';
import { readThreeVendor } from '../services/codeAnimation/threeVendor.js';
import { codeAnimationPackageSchema, summarizeCodeAnimationPackage } from '../lib/codeAnimationPackage.js';
import { codeAnimationProjectSchema, codeAnimationProjectPatchSchema, codeAnimationStageRunSchema } from '../lib/codeAnimationProjects.js';
import { acceptProductionOutput, getProductionAcceptance } from '../services/codeAnimation/acceptance.js';
import { startProductionStageRun, cancelProductionStageRun } from '../services/codeAnimation/stages.js';
import {
  createProductionProject, getProductionProject, patchProductionProject,
  listProductionProjects, getProductionHistory, importProductionPackage,
  acceptProductionSource, exportProductionPackage, exportProductionBrief,
} from '../services/codeAnimation/projects.js';

const router = Router();
router.use('/films', codeAnimationFilms);

router.get('/options', (_req, res) => {
  res.json(getCodeAnimationOptions());
});

// The preview iframe has an opaque origin, so it cannot fetch these itself: the
// client reads them once here and inlines them. Fixed for the installed three
// version, hence cacheable.
router.get('/vendor/three', asyncHandler(async (_req, res) => {
  const { version, files } = await readThreeVendor();
  res.set('Cache-Control', 'private, max-age=86400');
  res.json({ version, files: files.filter(({ path }) => path.endsWith('.js')).map(({ path, data, sha256 }) => ({ path, sha256, text: data.toString('utf8') })) });
}));

router.post('/brief', asyncHandler(async (req, res) => {
  res.json(await generateCodeAnimationBrief(validateRequest(briefIdeaSchema, req.body ?? {})));
}));

router.post('/prompt', asyncHandler(async (req, res) => {
  const input = validateRequest(briefSchema, req.body ?? {});
  const { prompt, frame, attachments, audioUrl, moodBoardId, base } = await buildCodeAnimationRequest(input);
  res.json({ prompt, frame, attachments, audioUrl, moodBoardId, base });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(generateSchema, req.body ?? {});
  res.status(202).json(await startCodeAnimationGeneration(input));
}));

router.get('/jobs', asyncHandler(async (req, res) => {
  // Existing query-less callers retain the array contract.
  res.json(Object.keys(req.query).length === 0
    ? await listCodeAnimationJobs()
    : await pageCodeAnimationJobs(validateRequest(jobsPageSchema, req.query)));
}));

router.get('/jobs/:id/poster', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  // The gallery requests it with ?v=<poster mtime>, so a recapture is a new URL.
  // The header rides only a sent file, so a missing poster's 404 is not cached.
  res.sendFile(codeAnimationPosterPath(id), { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } }, (error) => {
    if (error && !res.headersSent) res.status(404).json({ error: 'Poster not found', code: 'NOT_FOUND' });
  });
}));

router.post('/jobs/:id/poster', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await captureCodeAnimationJobPoster(id));
}));

router.get('/generate/:id', asyncHandler(async (req, res) => {
  const job = await getCodeAnimationJob(req.params.id);
  if (!job) throw new ServerError('Generation job not found', { status: 404, code: 'NOT_FOUND' });
  res.json(job);
}));

router.post('/generate/:id/cancel', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await cancelCodeAnimationGeneration(id));
}));

// Delete a gallery item: its files go to the system Trash, then the row.
router.delete('/jobs/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await deleteCodeAnimationJob(id));
}));

router.get('/projects', asyncHandler(async (req, res) => {
  res.json(await listProductionProjects(validateRequest(projectPageSchema, req.query)));
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
  res.json(await getProductionHistory(id, validateRequest(projectPageSchema, req.query)));
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
  const { revisionId } = validateRequest(revisionBodySchema, req.body);
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
  const { id, runId } = validateRequest(stageRunParamsSchema, req.params);
  res.json(cancelProductionStageRun(id, runId));
}));
router.get('/projects/:id/acceptance', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await getProductionAcceptance(id));
}));
// Explicit promotion of one finished run's video; frozen to its source/audio/render hashes.
router.post('/projects/:id/accepted-output', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  const { runId } = validateRequest(acceptRunBodySchema, req.body);
  res.json(await acceptProductionOutput(id, runId));
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
router.get('/packages/starter/blender', asyncHandler(async (_req, res) => {
  const version = lastCheckedBlenderVersion();
  res.json(await getBlenderStarterPackage(version ? { version } : {}));
}));

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

// Generate (or regenerate) a soundtrack for a finished animation with a local
// music engine, without re-running the animation code. 202: the render runs on
// the audio media lane; progress rides audio-gen:* for `mediaJobId`.

router.post('/:id/soundtrack', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.status(202).json(await startCodeAnimationSoundtrack(id, validateRequest(soundtrackSchema, req.body ?? {})));
}));

// The soundtrack track a coded score (written by a coding model, rendered in
// the browser or by SuperCollider) saves its take onto. Created on first use.
router.post('/:id/soundtrack/track', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.json(await ensureCodeAnimationSoundtrackTrack(id));
}));

// Frame-exact export: the stored HTML renders through the HTML-composition
// pipeline (seek each frame, H.264 MP4, Media History) on the media queue.
// Progress streams from /api/html-composition/:jobId/events.
router.post('/:id/export', asyncHandler(async (req, res) => {
  const { id } = validateRequest(exportParamsSchema, req.params);
  res.status(202).json(await startCodeAnimationExport(id));
}));

export default router;
