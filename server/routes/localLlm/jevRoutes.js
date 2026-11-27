import { jevPolicyPatchSchema, resolveUntrustedContentPolicy } from '../../lib/untrustedContent.js'
import { readSettingsStrict, updateSettingsWith } from '../../services/settings.js'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import { localLlmProgress as emitter } from '../localLlmProgress.js'
import { jevDecideRequestSchema } from '../../lib/jev.js'
import { jevHeadActionRequestSchema, jevHeadTrainRequestSchema } from '../../lib/jevHead.js'
import { cancelJevInstall, decide, getJevStatus, installJev, stopJevSidecar } from '../../services/jev.js'
import { readJevDecisionStats } from '../../services/jevRouter.js'

// The head store and the trainer are DEFERRED into their handlers, not
// imported at module scope: `jevTraining.js` reaches the sidecar lifecycle, the
// pinned model contract and the corpus builder's forge stack, and this route
// module sits in the static closure of a great many suites
// (`server/lib/importScoping.test.js`). Four endpoints nobody calls by default
// must not make every one of them pay for that subtree.
const jevHeadStore = () => import('../../services/jevHeads.js')
const jevTrainer = () => import('../../services/jevTraining.js')

const router = Router()

// The jev scorer mirrors the guard's lifecycle: a pinned, offline model with
// its own venv and its own installer, never reachable through the general
// chat-model path.
router.get('/jev/status', asyncHandler(async (_req, res) => {
  res.json(await getJevStatus())
}))

// Per-decision agreement and abstention counters. Counts only — never a
// premise, a choice tied to one, or anything about what was analyzed.
router.get('/jev/decisions', asyncHandler(async (_req, res) => {
  res.json(await readJevDecisionStats())
}))

// Resolve inheritance on the server, and expose only the scorer's own settings.
const presentJevPolicy = (settings) => ({
  scopeAdherenceEnabled: settings.untrustedContent?.scopeAdherenceEnabled !== false,
  sources: Object.fromEntries(['github-issue', 'email', 'stacker-news'].map(source => {
    const policy = resolveUntrustedContentPolicy(settings.untrustedContent, source)
    return [source, policy ? { jevMode: policy.jevMode, jevMinMargin: policy.jevMinMargin } : null]
  })),
})

router.get('/jev/policy', asyncHandler(async (_req, res) => {
  const state = await readSettingsStrict()
  if (state.corrupt) throw new ServerError('Scorer settings could not be read.', { status: 503 })
  res.json(presentJevPolicy(state.settings))
}))

router.put('/jev/policy', asyncHandler(async (req, res) => {
  const patch = validateRequest(jevPolicyPatchSchema, req.body)
  const updated = await updateSettingsWith(current => {
    const policy = current.untrustedContent || {}
    const sources = { ...policy.sources }
    for (const [source, fields] of Object.entries(patch.sources || {})) {
      sources[source] = { ...sources[source], ...fields }
    }
    return { ...current, untrustedContent: { ...policy,
      ...(patch.scopeAdherenceEnabled === undefined ? {} : { scopeAdherenceEnabled: patch.scopeAdherenceEnabled }),
      sources,
    } }
  }, { actor: 'user' })
  res.json(presentJevPolicy(updated))
}))

router.post('/jev/install', asyncHandler(async (req, res) => {
  const emit = emitter(req)
  const result = await installJev({
    onEvent: ({ event, message, stage }) => emit(event, message, { scope: 'jev', stage }),
  })
  if (!result?.ok) {
    const code = result?.code || 'jev-install-failed'
    const message = code === 'jev-python-unavailable'
      ? 'Install Python 3.10 or newer on this machine, restart PortOS if needed to detect it, then refresh jev status.'
      : code === 'jev-runtime-install-failed'
        ? 'Scorer package installation failed. Check internet access and Python compatibility, then retry from Models > Decision Classifiers > Jev.'
        : code === 'jev-model-download-failed'
          ? 'The pinned jev model snapshot could not be downloaded. Check internet access and free disk space, then retry.'
          : code
    const detail = result?.diagnostic
    const actionableMessage = detail ? `${message} ${detail.message} ${detail.action}` : message
    emit('error', actionableMessage, { scope: 'jev', stage: detail?.stage })
    throw new ServerError(actionableMessage, { status: 502, code })
  }
  res.json(result)
}))

router.post('/jev/install/cancel', asyncHandler(async (_req, res) => {
  cancelJevInstall()
  res.json({ cancelled: true })
}))

// An explicit operator action in the same request, per the AI Provider Usage
const jevScoreFailureStatuses = new Map([
  ['jev-request-invalid', 400],
  ['jev-premise-too-large', 400],
  ['jev-not-installed', 503],
  ['jev-start-failed', 503],
  ['jev-timeout', 504],
])

// Policy: this is the only path that starts the sidecar, and it starts it
// because someone asked for a score.
router.post('/jev/score', asyncHandler(async (req, res) => {
  const { premise, hypotheses, minMargin } = validateRequest(jevDecideRequestSchema, req.body)
  const result = await decide({ premise, options: hypotheses, minMargin })
  if (!result?.ok) {
    const code = result?.code || 'jev-response-invalid'
    const status = jevScoreFailureStatuses.get(code) ?? 502
    throw new ServerError('Jev could not score the request.', { status, code })
  }
  res.json(result)
}))

// Free the resident weights without waiting out the idle timer.
router.post('/jev/unload', asyncHandler(async (_req, res) => {
  res.json({ unloaded: stopJevSidecar() })
}))

// ── Project-specific trained heads ────────────────────────────────────────
// Every artifact under `data/jev/` is a derived record of this install's own
// repository history. These routes report metrics and adoption state; none of
// them returns a corpus row, a premise, or a path.
router.get('/jev/heads', asyncHandler(async (_req, res) => {
  const [{ describeJevHeads }, { isJevTrainingRunning }] = await Promise.all([jevHeadStore(), jevTrainer()])
  res.json({ ...await describeJevHeads(), training: isJevTrainingRunning() })
}))

// An explicit operator action in the same request, per the AI Provider Usage
// Policy — and the only path that builds a corpus or starts a training run.
// Trains against THIS install's own checkout: a head learns the product the
// operator is actually running, and there is no client-supplied path to reach
// anything else.
router.post('/jev/heads/train', asyncHandler(async (req, res) => {
  const { architecture } = validateRequest(jevHeadTrainRequestSchema, req.body || {})
  const { trainScopeAdherenceHead } = await jevTrainer()
  const result = await trainScopeAdherenceHead({ architecture })
  if (!result?.ok) throw new ServerError('Training a project head failed.', { status: 502, code: result?.code || 'jev-head-training-failed' })
  res.json(result)
}))

// THE ADOPTION GATE is in `adoptJevHead`, not here: a head that does not beat
// both the stock zero-shot and the majority-class baseline cannot be promoted
// through any surface, and hiding a button is a suggestion, not a gate.
router.post('/jev/heads/adopt', asyncHandler(async (req, res) => {
  const { decisionId } = validateRequest(jevHeadActionRequestSchema, req.body || {})
  const { adoptJevHead } = await jevHeadStore()
  const result = await adoptJevHead(decisionId)
  if (!result?.ok) throw new ServerError('This head cannot be adopted.', { status: 400, code: result?.code || 'jev-head-invalid' })
  res.json({ adopted: true, decisionId, metrics: result.head.metrics })
}))

// Discarding the ADOPTED head returns the decision to the stock zero-shot
// classifier — the state every install ships in, so nothing is lost but the
// training run.
router.post('/jev/heads/discard', asyncHandler(async (req, res) => {
  const { decisionId, adopted } = validateRequest(jevHeadActionRequestSchema, req.body || {})
  const { discardJevHead } = await jevHeadStore()
  res.json(await discardJevHead(decisionId, { candidate: adopted !== true }))
}))

export default router
