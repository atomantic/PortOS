import { localReviewRequestSchema, reviewerIdentityQuerySchema } from '../lib/codeReviewValidation.js'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import { validateRequest } from '../lib/validateRequest.js'
import { cliReviewerOutcomeSchema } from '../lib/cos/cosValidation.js'
import { isProviderReviewer, isReviewerConfigFault, reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../lib/reviewerConfig.js'
import { reviewerAccessFailureCode } from '../lib/reviewerHealth.js'
import { getSettings } from '../services/settings.js'
import { verifyReviewerIdentities } from '../services/reviewerIdentity.js'
import { getReviewerVerdictStats, recordReviewerVerdict } from '../services/reviewerVerdicts.js'
import { runLocalCodeReview, getCodeReviewDefaults, getReviewerCliInstalled, getProviderReviewCapability, withoutResolvedUnsupportedFaults, reportReviewerFailure, reportReviewerSuccess } from '../services/codeReview.js'

const router = Router()

// GET /api/code-review/defaults — resolved global defaults (settings.codeReview
// + an empty opt-in fallback). The Code Reviewers settings page reads this to render the
// initial state; TaskAddForm + ScheduleTab read it to seed new reviewer lists.
// `installed` (per-CLI-reviewer boolean, TTL-probed) rides alongside so a
// picker can flag a configured reviewer whose binary isn't on this machine
// (#3606) — warn-only, never filters the `reviewers` list above.
// `providerReviewUnsupported` is its provider-backed counterpart (#7660): the
// `provider:<id>` reviewers that have no runnable review transport, so
// the picker warns at selection time instead of letting the user discover it as
// a review gate that never clears. Warn-only in exactly the same way.
router.get('/defaults', asyncHandler(async (_req, res) => {
  const [defaults, installed, { unsupported, capable }] = await Promise.all([
    getCodeReviewDefaults(),
    getReviewerCliInstalled(),
    getProviderReviewCapability(),
  ])
  const reviewerConfigFaults = withoutResolvedUnsupportedFaults(defaults.reviewerConfigFaults || {}, capable)
  res.json({ ...defaults, reviewerConfigFaults, installed, providerReviewUnsupported: unsupported })
}))

router.get('/reviewer-identities', asyncHandler(async (req, res) => {
  const { forge, host } = validateRequest(reviewerIdentityQuerySchema, req.query)
  const defaults = await getCodeReviewDefaults()
  // `defaults` is already normalized (see pickCodeReviewDefaults).
  const usernames = defaults.usernames || []
  const optionalLogins = (defaults.optionalReviewers || []).filter(r => r.startsWith('@')).map(r => r.slice(1))
  const optionalSet = new Set(optionalLogins.map(r => r.toLowerCase()))
  const identities = (await verifyReviewerIdentities([...usernames, ...optionalLogins], { forge, host }))
    .map(entry => ({ ...entry, required: !optionalSet.has(entry.token.toLowerCase()) }))
  res.json({ forge, identities })
}))

// POST /api/code-review/local — run a single review pass against the
// configured local-LLM backend (LM Studio, Ollama, or MTPLX) and return the findings
// text the agent will act on. Synchronous: keeps the agent's `curl` step
// simple — one request, one body back.
router.post('/local', asyncHandler(async (req, res) => {
  const body = validateRequest(localReviewRequestSchema, req.body)
  const settings = body.inheritDefaults === false ? {} : await getSettings()
  // Keyed off the roster's `<reviewer>Model` scalar rather than a per-backend
  // branch, so a backend added to LOCAL_LLM_REVIEWERS reads its own configured
  // model instead of silently inheriting another backend's.
  const configured = isProviderReviewer(body.backend)
    ? reviewerModelsFromDefaults(settings.codeReview)[body.backend]
    : settings.codeReview?.[`${body.backend}Model`]
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
    cwd: body.cwd,
    toolFree: body.toolFree,
    timeoutMs: body.timeoutMs,
    headSha: body.headSha,
    maxBatchBytes: body.maxBatchBytes,
    maxBatches: body.maxBatches,
  })
  if (!result.ok) {
    await reportReviewerFailure(body.backend, result)
    // A refusal the caller can fix by changing configuration — no model, a
    // missing/disabled provider, or one with no command configured —
    // is a config gap (400). The 502 bucket is for a reviewer that was actually
    // asked and failed, which is the only kind a caller should retry.
    throw new ServerError(result.error || 'Code review failed', {
      status: isReviewerConfigFault(result.code) ? 400 : 502,
      context: { backend: result.backend, model: result.model,
        ...(result.code === 'MALFORMED_REVIEW' ? { code: result.code, diagnostics: result.diagnostics } : {}),
        ...(result.coverage ? { code: result.code, coverage: result.coverage,
          ...(result.verdict === 'findings' ? { verdict: result.verdict, findings: result.findings } : {}) } : {}) }
    })
  }
  await reportReviewerSuccess(body.backend)
  res.json(result)
}))

// The existing /api auth gate protects this orchestrator-only report. It never
// invokes a provider, accepts raw CLI output, or changes optional-review policy.
router.post('/cli-outcome', asyncHandler(async (req, res) => {
  const body = validateRequest(cliReviewerOutcomeSchema, req.body)
  if (body.outcome === 'reviewed') {
    const recorded = await reportReviewerSuccess(body.reviewer)
    if (!body.agentId) return res.json({ recorded })
    const run = await recordReviewerVerdict(body)
    return res.json({ recorded, ...run })
  }
  const code = reviewerAccessFailureCode(body.reviewer, body.failure)
  const recorded = code ? await reportReviewerFailure(body.reviewer, { code }) : false
  res.json({ recorded, code })
}))

// GET /api/code-review/verdict-stats — clean rate per reviewer and per reviewed
// diff size, from the verdicts runs recorded above. Read by the CoS Learning tab.
router.get('/verdict-stats', asyncHandler(async (_req, res) => {
  res.json(await getReviewerVerdictStats())
}))

export default router
