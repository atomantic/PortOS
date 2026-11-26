import { Router } from 'express'
import { asyncHandler, ServerError } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import { abortSignalFromResponse } from '../../lib/requestAbort.js'

const router = Router()

const layaService = () => import('../../services/layaMlx.js')

const layaFailureStatuses = new Map([
  ['laya-request-invalid', 400],
  ['laya-unsupported', 400],
  ['laya-context-too-long', 400],
  ['laya-disabled', 403],
  ['laya-busy', 409],
  ['laya-not-ready', 503],
])

router.get('/laya-mlx/status', asyncHandler(async (_req, res) => {
  res.json(await (await layaService()).getLayaStatus())
}))
router.post('/laya-mlx/install', asyncHandler(async (_req, res) => {
  const result = await (await layaService()).installLaya()
  if (result?.ok !== true) {
    const code = result?.code || 'laya-install-failed'
    const status = layaFailureStatuses.get(code) ?? 502
    throw new ServerError('Laya-MLX could not start installation.', { status, code })
  }
  res.status(202).json(result)
}))
router.post('/laya-mlx/score', asyncHandler(async (req, res) => {
  const { layaScoreRequestSchema } = await import('../../lib/layaMlx.js')
  const input = validateRequest(layaScoreRequestSchema, req.body)
  const result = await (await layaService()).scoreLaya(input, abortSignalFromResponse(res))
  if (!result?.ok) {
    const code = result?.code || 'laya-scoring-failed'
    const status = layaFailureStatuses.get(code) ?? 502
    throw new ServerError('Laya-MLX could not score the request.', { status, code })
  }
  res.json(result)
}))

export default router
