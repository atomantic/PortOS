import { emitToOperatorsOn } from '../../services/socketIo.js'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import {
  localLlmAssessmentRunSchema,
  localLlmAssessmentIntentSchema,
  localLlmAgentBenchmarkSchema,
  localLlmAssessmentDeleteSchema,
  localLlmAssessmentSweepSchema,
  localLlmAssessmentBenchmarkSchema,
  localLlmCapabilityTestSchema,
  localLlmCapabilityTestRunSchema,
  localLlmCapabilityTestDeleteSchema,
} from '../../lib/mediaValidation.js'
import { getAssessmentReport, runAssessment, deleteAssessment } from '../../services/localModelAssessments.js'
import { startSweep, getSweepStatus, cancelSweep } from '../../services/localModelAssessmentSweep.js'
import { runOpenCodeAgentBenchmark } from '../../services/localModelAgentBenchmark.js'
import { getCapabilityTestReport, getCapabilityTestResult, runCapabilityTest } from '../../services/modelCapabilityTests.js'
import { deleteResult as deleteCapabilityTestResult } from '../../services/modelCapabilityTestStore.js'
import { abortSignalFromResponse } from '../../lib/requestAbort.js'

const router = Router()

// === Measured local-model assessments ========================================
// PortOS's catalog fit badge is a size estimate that never runs the model. These
// endpoints back the measured alternative: run a model at several context sizes
// and rank installed models on the evidence.
//
// The read/run split is the AI Provider Usage Policy boundary (root AGENTS.md):
// GET touches disk only and is safe to poll; POST /run is the ONLY path that
// reaches a provider, and it fires solely from a deliberate user action whose
// UI names the backend, model, and run count first. Do not add a boot hook, a
// scheduler, or an "assess everything" sweep here.

// GET /api/local-llm/assessments?intent=balanced — persisted results, the
// intent-ranked recommendation, and which installed models have no evidence yet.
// Zero LLM calls.
router.get('/assessments', asyncHandler(async (req, res) => {
  const { intent } = validateRequest(localLlmAssessmentIntentSchema, req.query)
  res.json(await getAssessmentReport({ intent }))
}))

// POST /api/local-llm/assessments/run — measure ONE model. User-triggered only.
// Long-running by nature (one bounded generation per context size), so the
// client's abort signal is threaded through to stop mid-run on disconnect.
router.post('/assessments/run', asyncHandler(async (req, res) => {
  const { backend, modelId, contextTokens, tuning } = validateRequest(localLlmAssessmentRunSchema, req.body)
  const io = req.app.get('io')
  // Same `localLlm:progress` channel the pull/migrate paths use, so one banner
  // renders every long local-LLM operation. The extra fields (`scope`, `backend`,
  // `modelId`, `sampleIndex`/`sampleCount`) let a listener tell an assessment
  // frame from a model pull streaming on the same event.
  const onProgress = (frame) => emitToOperatorsOn(io, 'localLlm:progress', frame)
  res.json(await runAssessment({ backend, modelId, contextTokens, tuning, signal: abortSignalFromResponse(res), onProgress }))
}))

// POST /api/local-llm/assessments/agent-benchmark — run one explicit,
// disposable local-TUI task through a configured local provider. This is
// deliberately separate from `/run`: it measures task-loop completion, not just
// decoder speed, and never runs from a read/poll/bootstrap path.
router.post('/assessments/agent-benchmark', asyncHandler(async (req, res) => {
  const { backend, modelId, timeoutMs } = validateRequest(localLlmAgentBenchmarkSchema, req.body)
  res.json(await runOpenCodeAgentBenchmark({ backend, modelId, timeoutMs }))
}))

// POST /api/local-llm/assessments/sweep — measure EVERY model the scope covers,
// or (with `tunings: true` plus a backend/modelId) ONE model across the tuning
// grid its runtime declares.
// User-triggered only, same as the single-model run: the UI names the model and
// generation count before this fires.
//
// Unlike /run this returns immediately and the queue keeps going server-side —
// a full sweep is hours of work started at the end of the day, so it must not
// depend on the browser tab staying open. Progress rides the same
// `localLlm:progress` socket event under `scope: 'assessment-sweep'`, and the
// GET below is the reload-safe source of truth.
router.post('/assessments/sweep', asyncHandler(async (req, res) => {
  const { scope, contextTokens, backend, modelId, tunings } = validateRequest(localLlmAssessmentSweepSchema, req.body)
  const io = req.app.get('io')
  // `tunings` is the ASK, not the grid: the client says "sweep this model's
  // tunings" and the service decides which knob sets that means. A client that
  // could post the grid could post an arbitrary batch of provider calls, and the
  // count the consent gate named would stop being the count that runs.
  const status = await startSweep({
    scope, contextTokens, backend, modelId, tunings,
    onProgress: (frame) => emitToOperatorsOn(io, 'localLlm:progress', frame),
    onChange: (state) => emitToOperatorsOn(io, 'localLlm:sweep:changed', state),
  })
  // A refused start (one already running, or nothing to measure) is a 409, not a
  // silent no-op that would leave the page waiting for progress that never comes.
  if (status.rejected) throw new ServerError(status.rejected, { status: 409, context: { scope } })
  res.json(status)
}))

// POST /api/local-llm/assessments/benchmark — the side-by-side benchmark: the
// picked models, one after another on the SAME queue as the sweep, each under the
// fixed warm profile (`BENCHMARK_PROFILE`). User-triggered only: the UI names the
// models and generation count first. Results persist as ordinary assessments, so
// they feed the Models › Comparison measured axes.
router.post('/assessments/benchmark', asyncHandler(async (req, res) => {
  const { models } = validateRequest(localLlmAssessmentBenchmarkSchema, req.body)
  const io = req.app.get('io')
  const status = await startSweep({
    models,
    onProgress: (frame) => emitToOperatorsOn(io, 'localLlm:progress', frame),
    onChange: (state) => emitToOperatorsOn(io, 'localLlm:sweep:changed', state),
  })
  if (status.rejected) throw new ServerError(status.rejected, { status: 409, context: { models: models.length } })
  res.json(status)
}))

// GET /api/local-llm/assessments/sweep — queue status. Module state only, zero
// LLM calls; mount, reconnect and tab re-show reconcile missed state events here.
router.get('/assessments/sweep', asyncHandler(async (_req, res) => {
  res.json(getSweepStatus())
}))

// POST /api/local-llm/assessments/sweep/cancel — stop the queue and the model in
// flight. Everything already measured stays on disk.
router.post('/assessments/sweep/cancel', asyncHandler(async (_req, res) => {
  res.json(cancelSweep())
}))

// POST /api/local-llm/assessments/delete — drop one stale measurement (e.g. after
// a RAM upgrade or a backend update makes the recorded evidence misleading).
// 404s when nothing was removed rather than reporting a phantom success.
router.post('/assessments/delete', asyncHandler(async (req, res) => {
  const { backend, modelId, tuningKey } = validateRequest(localLlmAssessmentDeleteSchema, req.body)
  const result = await deleteAssessment(backend, modelId, tuningKey)
  if (!result.deleted) throw new ServerError('No assessment recorded for that model', { status: 404, context: { backend, modelId, tuningKey } })
  res.json({ success: true, backend, modelId, tuningKey })
}))

// === Capability tests ========================================================
// The assessments above answer "how fast is this model here". These answer the
// question speed cannot: can it do what its badges claim? One test per
// capability — tool use (repair a module in a sandbox, driven through the
// configured OpenCode task driver), vision (describe a fixture image, scored on
// required and bonus keywords), and chat/reasoning (a twelve-beat story outline
// plus a fiction scene, scored on structural signals). Every run keeps the
// model's full output.
//
// Same read/run split as the assessments, and for the same reason: GET touches
// disk only; POST /run is the ONLY path that reaches a model, and it fires from
// one deliberate click whose gate names the runtime, model and tests first.
// There is deliberately no sweep and no scheduled entry point here — a
// capability run is a manual act.

// GET /api/local-llm/capability-tests — what each installed model claims, which
// tests apply, and what each one proved last time. Zero LLM calls.
router.get('/capability-tests', asyncHandler(async (_req, res) => {
  res.json(await getCapabilityTestReport())
}))

// POST /api/local-llm/capability-tests/run — run ONE test against ONE model.
// Long-running (a sandbox repair is an agent loop), so the client's abort signal
// is threaded through to stop mid-run on disconnect.
router.post('/capability-tests/run', asyncHandler(async (req, res) => {
  const { backend, modelId, testId } = validateRequest(localLlmCapabilityTestRunSchema, req.body)
  const io = req.app.get('io')
  // Same `localLlm:progress` channel every long local-LLM operation uses. The
  // `scope: 'capability-test'` field plus backend/model/test is what lets a
  // listener tell these frames from a model pull streaming on the same event —
  // and the `output` frames are what render the agent transcript live.
  const onProgress = (frame) => emitToOperatorsOn(io, 'localLlm:progress', frame)
  res.json(await runCapabilityTest({
    backend, modelId, testId, onProgress, signal: abortSignalFromResponse(res),
  }))
}))

// GET /api/local-llm/capability-tests/result — ONE stored result in full,
// including the model's output and the agent transcript.
//
// Split from the report on purpose: those two fields are the bulk of a record
// and are read only when the drawer opens one pairing, so the report ships
// summaries and this fills in the rest. Query params rather than a path because
// a model id is not one — it carries `/` and `:` (`hf.co/org/repo:Q4_K_M`).
router.get('/capability-tests/result', asyncHandler(async (req, res) => {
  const { backend, modelId, testId } = validateRequest(localLlmCapabilityTestSchema, req.query)
  const result = await getCapabilityTestResult(backend, modelId, testId)
  if (!result) throw new ServerError('No capability test result recorded for that model', { status: 404, context: { backend, modelId, testId } })
  res.json(result)
}))

// POST /api/local-llm/capability-tests/delete — drop one recorded result.
// 404s when nothing was removed rather than reporting a phantom success.
router.post('/capability-tests/delete', asyncHandler(async (req, res) => {
  const { backend, modelId, testId } = validateRequest(localLlmCapabilityTestDeleteSchema, req.body)
  const result = await deleteCapabilityTestResult(backend, modelId, testId)
  if (!result.deleted) throw new ServerError('No capability test result recorded for that model', { status: 404, context: { backend, modelId, testId } })
  res.json({ success: true, backend, modelId, testId })
}))

export default router
