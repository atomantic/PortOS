import { Router } from 'express';
import { asyncHandler, ServerError, createServiceErrorMapper } from '../lib/errorHandler.js';
import {
  validateRequest,
  storySessionCreateSchema,
  storySessionUpdateSchema,
  storySessionSyncSchema,
  storyStepGenerateSchema,
  storyStepRefineSchema,
  storyIssueLockSchema,
  storyIssuesGenerateSchema,
} from '../lib/validation.js';
import { STEPS, isValidStepId } from '../lib/storyBuilderSteps.js';
import {
  listStorySessions,
  getStorySession,
  getStorySessionView,
  createStorySession,
  updateStorySession,
  deleteStorySession,
  lockStep,
  unlockStep,
  setCurrentStep,
  setIssueLock,
  generateIssuesFromArc,
  setStorySessionSync,
  reconcileStorySession,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
} from '../services/storyBuilder.js';
import { startStepRun, attachClient } from '../services/storyBuilderRunner.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [ERR_NOT_FOUND]: 404,
  [ERR_VALIDATION]: 400,
};
const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

// Echo the step manifest so the client stepper doesn't hardcode the order /
// labels (single source of truth is server/lib/storyBuilderSteps.js).
router.get('/steps', (_req, res) => {
  res.json({ steps: STEPS });
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listStorySessions());
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(storySessionCreateSchema, req.body || {});
  const created = await createStorySession(input).catch((err) => { throw mapServiceError(err); });
  res.status(201).json(created);
}));

// Flatten a session view into the shape the client consumes: the persisted
// session plus the computed (non-persisted) staleSteps array and the syncDrift
// flag (#730: this machine's live records diverged from the synced baseline).
const flattenView = (view) => ({ ...view.session, staleSteps: view.staleSteps, syncDrift: view.syncDrift });

router.get('/:id', asyncHandler(async (req, res) => {
  const view = await getStorySessionView(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(flattenView(view));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const input = validateRequest(storySessionUpdateSchema, req.body || {});
  const updated = await updateStorySession(req.params.id, input).catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await deleteStorySession(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// ── Cross-machine resume opt-in (#730) ──────────────────────────────────────

// Toggle whether this session participates in cross-machine resume. Local-only
// is the default; flipping sync on captures a staleness baseline that travels
// with the session so a peer's universe edit can't false-positive-stale it.
router.post('/:id/sync', asyncHandler(async (req, res) => {
  const { sync } = validateRequest(storySessionSyncSchema, req.body || {});
  await setStorySessionSync(req.params.id, sync).catch((err) => { throw mapServiceError(err); });
  // Return the recomputed view, not the bare record: toggling sync changes the
  // staleness baseline (live-diff ↔ carried syncedHashes), so staleSteps can
  // shift too — the client merges both reactively without a separate refetch.
  const view = await getStorySessionView(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(flattenView(view));
}));

// Re-snapshot a sync-enabled session's staleness baseline to the current live
// records — the explicit "adopt this machine's universe/series state" gesture.
router.post('/:id/reconcile', asyncHandler(async (req, res) => {
  await reconcileStorySession(req.params.id).catch((err) => { throw mapServiceError(err); });
  // Reconcile moves the carried baseline, so staleSteps recompute against it
  // (a locked step whose frozen hash differs from the adopted records becomes
  // stale). Return the fresh view so the step rail updates without a refetch.
  const view = await getStorySessionView(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(flattenView(view));
}));

// ── Step state machine ─────────────────────────────────────────────────────

function assertStep(stepId) {
  if (!isValidStepId(stepId)) {
    throw new ServerError(`Unknown step: ${stepId}`, { status: 400, code: ERR_VALIDATION });
  }
}

router.post('/:id/current-step/:stepId', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const updated = await setCurrentStep(req.params.id, req.params.stepId).catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.post('/:id/steps/:stepId/lock', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const updated = await lockStep(req.params.id, req.params.stepId).catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.post('/:id/steps/:stepId/unlock', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const updated = await unlockStep(req.params.id, req.params.stepId).catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

// Generate / refine kick off in the background and stream progress over SSE —
// a long arc-overview would otherwise block the request with only a spinner.
// The POST returns immediately with the runId + sseUrl; the result lands on the
// progress stream and the client refetches the session view on `complete`.
// Validate the session exists up front so a bad id returns 404 here rather than
// surfacing as a background error after a 200.
router.post('/:id/steps/:stepId/generate', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const input = validateRequest(storyStepGenerateSchema, req.body || {});
  await getStorySession(req.params.id).catch((err) => { throw mapServiceError(err); });
  // Backfill (fromDownstream) and forward generate both dispatch through
  // generateStep, but tag distinct ops so the client's backfill button (op:
  // 'backfill') re-attaches to an in-flight backfill instead of being told a
  // different op is running. The runner routes any non-'refine' op to generateStep.
  const op = input.fromDownstream ? 'backfill' : 'generate';
  const run = startStepRun(req.params.id, req.params.stepId, { op, ...input });
  res.json({ ...run, sseUrl: `/api/story-builder/${req.params.id}/steps/${req.params.stepId}/progress` });
}));

router.post('/:id/steps/:stepId/refine', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const input = validateRequest(storyStepRefineSchema, req.body || {});
  await getStorySession(req.params.id).catch((err) => { throw mapServiceError(err); });
  const run = startStepRun(req.params.id, req.params.stepId, { op: 'refine', ...input });
  res.json({ ...run, sseUrl: `/api/story-builder/${req.params.id}/steps/${req.params.stepId}/progress` });
}));

router.get('/:id/steps/:stepId/progress', (req, res) => {
  assertStep(req.params.stepId);
  const attached = attachClient(req.params.id, req.params.stepId, res);
  if (!attached) {
    throw new ServerError('No active run for this step', { status: 404 });
  }
});

// ── Issues step: seed issues from the arc + per-issue locks ──────────────────

// Generate the per-episode breakdown for the linked series' seasons and
// persist one issue per episode, so the user never has to leave the builder.
router.post('/:id/issues/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(storyIssuesGenerateSchema, req.body || {});
  const result = await generateIssuesFromArc(req.params.id, input).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.post('/:id/issues/:issueId/lock', asyncHandler(async (req, res) => {
  const { locked } = validateRequest(storyIssueLockSchema, req.body || {});
  const updated = await setIssueLock(req.params.id, req.params.issueId, locked).catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

export default router;
