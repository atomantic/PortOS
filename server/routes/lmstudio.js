/**
 * LM Studio Routes
 *
 * Only model unload is exposed over REST (the Local LLM panel calls it). Status,
 * listing, load and download go through `/api/local-llm`.
 */

import { Router } from 'express'
import { observeModelMutations } from '../services/modelObservation.js'
import * as lmStudioManager from '../services/lmStudioManager.js'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import { validateRequest } from '../lib/validateRequest.js';
import { lmStudioModelIdSchema } from '../lib/lmstudioValidation.js';

const router = Router()
router.use(observeModelMutations('loaded-models', 'provider-readiness'));

/**
 * POST /api/lmstudio/unload
 * Unload a model from memory
 */
router.post('/unload', asyncHandler(async (req, res) => {
  const { modelId } = validateRequest(lmStudioModelIdSchema, req.body)

  const result = await lmStudioManager.unloadModel(modelId)
  if (!result.success) {
    throw new ServerError(result.error || 'Unload failed', { status: 502, context: { modelId } })
  }
  res.json(result)
}))

export default router
