import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import { validateRequest, LOCAL_LLM_REVIEWERS, normalizeReviewerEffort, reviewerEffortLevels, reviewerEffortsFromDefaults } from '../lib/validation.js'
import { getSettings } from '../services/settings.js'
import { runLocalCodeReview, getCodeReviewDefaults, getReviewerCliInstalled } from '../services/codeReview.js'

const router = Router()

// Body shape for POST /api/code-review/local. `model` and `effort` are optional —
// when omitted (or empty) we fall back to the model / reasoning effort configured
// on the Code Review Defaults panel, and with no configured model either, to the
// model the backend itself reports serving when that is unambiguous (see
// `resolveServedModel`). The diff is sent as-is; agents can pipe
// `gh pr diff <N>` straight into it without preprocessing.
// `effort` is checked against the ladder for the REQUESTED backend rather than a
// flat union of every local level: the two backends are separate identities in
// `REVIEWER_EFFORT_LEVELS`, so a union would accept a level valid only for the
// other one, and `runLocalCodeReview`'s inner `normalizeReviewerEffort` would then
// silently drop it — a 200 with the effort ignored instead of a 400. Same
// normalizer both places, so they can't disagree.
const localReviewRequestSchema = z.object({
  backend: z.enum(LOCAL_LLM_REVIEWERS),
  model: z.string().optional(),
  effort: z.string().optional(),
  diff: z.string().min(1, 'diff must be non-empty'),
  timeoutMs: z.number().int().positive().max(600000).optional(),
}).strict().superRefine((body, ctx) => {
  // Blank is "not pinned", not "invalid" — same fallback the sibling `model` field
  // gets from `body.model || configured` below, and what this route's header
  // documents ("when omitted or empty we fall back"). Only a NON-empty value that
  // the backend's ladder rejects is a 400.
  if (!body.effort) return
  if (normalizeReviewerEffort(body.effort, body.backend)) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['effort'],
    message: `Invalid effort for the ${body.backend} reviewer — expected one of: ${(reviewerEffortLevels(body.backend) || []).join(', ')}`,
  })
})

// GET /api/code-review/defaults — resolved global defaults (settings.codeReview
// + hardcoded fallback). The Code Reviewers settings page reads this to render the
// initial state; TaskAddForm + ScheduleTab read it to seed new reviewer lists.
// `installed` (per-CLI-reviewer boolean, TTL-probed) rides alongside so a
// picker can flag a configured reviewer whose binary isn't on this machine
// (#3606) — warn-only, never filters the `reviewers` list above.
router.get('/defaults', asyncHandler(async (_req, res) => {
  const [defaults, installed] = await Promise.all([getCodeReviewDefaults(), getReviewerCliInstalled()])
  res.json({ ...defaults, installed })
}))

// POST /api/code-review/local — run a single review pass against the
// configured local-LLM backend (LM Studio, Ollama, or MTPLX) and return the findings
// text the agent will act on. Synchronous: keeps the agent's `curl` step
// simple — one request, one body back.
router.post('/local', asyncHandler(async (req, res) => {
  const body = validateRequest(localReviewRequestSchema, req.body)
  const settings = await getSettings()
  // Keyed off the roster's `<reviewer>Model` scalar rather than a per-backend
  // branch, so a backend added to LOCAL_LLM_REVIEWERS reads its own configured
  // model instead of silently inheriting another backend's.
  const configured = settings.codeReview?.[`${body.backend}Model`]
  const model = body.model || configured
  // Per-request effort wins over the panel default; absent in both = omit the
  // field entirely so the model reasons however it normally would. The stored
  // default is read through the validated accessor rather than off the raw slice,
  // so this route and `pickCodeReviewDefaults` agree on a hand-edited value
  // (an open-coded read misses the normalizer's case-folding).
  const effort = body.effort || reviewerEffortsFromDefaults(settings.codeReview)[body.backend] || null
  const result = await runLocalCodeReview({
    backend: body.backend,
    model,
    effort,
    diff: body.diff,
    timeoutMs: body.timeoutMs,
  })
  if (!result.ok) {
    // A model neither the request, the panel, nor the backend's own listing could
    // supply is the caller's config gap (400) — the 502 bucket is for a reviewer
    // that was actually asked and failed.
    throw new ServerError(result.error || 'Code review failed', {
      status: result.code === 'NO_MODEL' ? 400 : 502,
      context: { backend: result.backend, model: result.model }
    })
  }
  res.json(result)
}))

export default router
