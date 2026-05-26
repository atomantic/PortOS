import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../lib/errorHandler.js'
import { validateRequest, LOCAL_LLM_REVIEWERS } from '../lib/validation.js'
import { getSettings } from '../services/settings.js'
import { runLocalCodeReview, getCodeReviewDefaults } from '../services/codeReview.js'

const router = Router()

// Body shape for POST /api/code-review/local. `model` is optional — when
// omitted (or empty) we fall back to the model configured on the Code Review
// Defaults panel. The diff is sent as-is; agents can pipe `gh pr diff <N>`
// straight into it without preprocessing.
const localReviewRequestSchema = z.object({
  backend: z.enum(LOCAL_LLM_REVIEWERS),
  model: z.string().optional(),
  diff: z.string().min(1, 'diff must be non-empty'),
  timeoutMs: z.number().int().positive().max(600000).optional(),
}).strict()

// GET /api/code-review/defaults — resolved global defaults (settings.codeReview
// + hardcoded fallback). The AI Providers panel reads this to render the
// initial state; TaskAddForm + ScheduleTab read it to seed new reviewer lists.
router.get('/defaults', asyncHandler(async (_req, res) => {
  res.json(await getCodeReviewDefaults())
}))

// POST /api/code-review/local — run a single review pass against the
// configured local-LLM backend (LM Studio or Ollama) and return the findings
// text the agent will act on. Synchronous: keeps the agent's `curl` step
// simple — one request, one body back.
router.post('/local', asyncHandler(async (req, res) => {
  const body = validateRequest(localReviewRequestSchema, req.body)
  const settings = await getSettings()
  const configured = body.backend === 'lmstudio'
    ? settings.codeReview?.lmstudioModel
    : settings.codeReview?.ollamaModel
  const model = body.model || configured
  const result = await runLocalCodeReview({
    backend: body.backend,
    model,
    diff: body.diff,
    timeoutMs: body.timeoutMs,
  })
  if (!result.ok) {
    res.status(502).json(result)
    return
  }
  res.json(result)
}))

export default router
