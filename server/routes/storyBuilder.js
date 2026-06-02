import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  storySessionCreateSchema,
  storySessionUpdateSchema,
  storyStepGenerateSchema,
  storyStepRefineSchema,
  storyIssueLockSchema,
  storyIssuesGenerateSchema,
} from '../lib/validation.js';
import { STEPS, isValidStepId } from '../lib/storyBuilderSteps.js';
import {
  listStorySessions,
  getStorySessionView,
  createStorySession,
  updateStorySession,
  deleteStorySession,
  lockStep,
  unlockStep,
  setCurrentStep,
  setIssueLock,
  generateStep,
  refineStep,
  generateIssuesFromArc,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
} from '../services/storyBuilder.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [ERR_NOT_FOUND]: 404,
  [ERR_VALIDATION]: 400,
};
const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

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

router.get('/:id', asyncHandler(async (req, res) => {
  const view = await getStorySessionView(req.params.id).catch((err) => { throw mapServiceError(err); });
  // Flatten the session with the computed (non-persisted) staleSteps array.
  res.json({ ...view.session, staleSteps: view.staleSteps });
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

router.post('/:id/steps/:stepId/generate', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const input = validateRequest(storyStepGenerateSchema, req.body || {});
  const result = await generateStep(req.params.id, req.params.stepId, input).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.post('/:id/steps/:stepId/refine', asyncHandler(async (req, res) => {
  assertStep(req.params.stepId);
  const input = validateRequest(storyStepRefineSchema, req.body || {});
  const result = await refineStep(req.params.id, req.params.stepId, input).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

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
