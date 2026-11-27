import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { pipelineStageRecoverySchema, pipelineStageRecoveryParamsSchema } from '../../lib/pipelineMediaValidation.js';
import { ERR_NOT_FOUND } from '../../services/pipeline/issuesShared.js';
import { getStageRecovery, recoverLegacyStage } from '../../services/pipeline/textStages.js';

const router = Router();
const mapError = createServiceErrorMapper({ [ERR_NOT_FOUND]: 404, PIPELINE_RECOVERY_CONFLICT: 409 });

router.get('/issues/:id/stages/:stageId/recovery', asyncHandler(async (req, res) => {
  const { id, stageId } = validateRequest(pipelineStageRecoveryParamsSchema, req.params);
  res.json(await getStageRecovery(id, stageId).catch((err) => { throw mapError(err); }));
}));
router.post('/issues/:id/stages/:stageId/recover', asyncHandler(async (req, res) => {
  const { id, stageId } = validateRequest(pipelineStageRecoveryParamsSchema, req.params);
  const { revision } = validateRequest(pipelineStageRecoverySchema, req.body ?? {});
  res.json(await recoverLegacyStage(id, stageId, revision).catch((err) => { throw mapError(err); }));
}));

export default router;
