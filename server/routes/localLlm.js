/**
 * Local LLM Routes
 *
 * REST endpoints for managing local LLM backends (Ollama / LM Studio):
 * backend status, installed-model listing, a curated install catalog,
 * install/delete, and switch/migrate between backends. Long-running pulls and
 * migrations stream progress over the `localLlm:progress` socket event (same
 * contract the Database tab uses).
 */

import os from 'os'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import {
  validateRequest,
  localLlmInstallSchema,
  localLlmDeleteSchema,
  localLlmSwitchSchema,
  localLlmUnloadSchema,
  localLlmMigrateSchema,
  localLlmInstallBackendSchema,
  localLlmOllamaServiceSchema,
  localLlmHuggingFaceSearchSchema,
  localLlmTestSchema,
  localLlmCompareSchema,
  localLlmAssessmentRunSchema,
  localLlmAssessmentIntentSchema,
  localLlmAgentBenchmarkSchema,
  localLlmAssessmentDeleteSchema,
  localLlmAssessmentSweepSchema,
  localLlmCapabilityTestSchema,
  localLlmCapabilityTestRunSchema,
  localLlmCapabilityTestDeleteSchema,
  localLlmLlamaServerStartSchema,
  localLlmLmStudioServiceSchema,
  localLlmMtplxStartSchema,
  localLlmMtplxSearchSchema,
  localLlmMtplxPullSchema,
  localLlmMtplxRemoveSchema,
  localLlmSpecModelDownloadSchema
} from '../lib/validation.js'
import { getLlamaServerStatus, startLlamaServer, stopLlamaServer, installLlamaServer } from '../services/llamaServerManager.js'
import { getMtplxServerStatus, startMtplxServer, stopMtplxServer, installMtplx } from '../services/mtplxServerManager.js'
import { searchMtplxCatalog, pullMtplxModel, removeMtplxModel } from '../services/mtplxModelManager.js'
import { saveProcessList } from '../services/pm2.js'
import { getSpecDecodePresetStatus, downloadSpecDecodeModel } from '../services/specDecodeModels.js'
import { SPEC_TYPE_SUGGESTIONS } from '../lib/specDecodePresets.js'
import { resetProviderReadinessCache } from '../services/providerReadiness.js'
import { getCatalog, searchCatalog, isBackend } from '../lib/localLlmCatalog.js'
import { isAppleSilicon } from '../lib/platform.js'
import { searchHuggingFaceModels, enrichCatalogWithVariants, applyMeasuredFit } from '../services/huggingFaceCatalog.js'
import { getMeasuredFits } from '../services/localModelAssessmentStore.js'
import {
  getStatus, listModels, listVisionModels, listToolUseModels, installModel, deleteModel, switchBackend, migrateBackend, installBackend, upgradeBackend, controlOllamaServer,
  describeInstallProgress
} from '../services/localLlm.js'
import { getSettings } from '../services/settings.js'
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js'
import { getAssessmentReport, runAssessment, deleteAssessment } from '../services/localModelAssessments.js'
import { startSweep, getSweepStatus, cancelSweep } from '../services/localModelAssessmentSweep.js'
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js'
import { getCapabilityTestReport, getCapabilityTestResult, runCapabilityTest } from '../services/modelCapabilityTests.js'
import { deleteResult as deleteCapabilityTestResult } from '../services/modelCapabilityTestStore.js'
import { listUserModels } from '../services/audioModels.js'
import { ENGINES } from '../services/pipeline/musicGen.js'
import { abortSignalFromResponse } from '../lib/requestAbort.js'
import { awaitWritableDrain } from '../lib/streamBackpressure.js'
import {
  getLastLoadedModelsError as getOllamaResidencyError,
  getLoadedModels as getLoadedOllamaModels,
  unloadModel as unloadOllamaModel,
} from '../services/ollamaManager.js'
import {
  controlLmStudioServer,
  getLastLoadedModelsError as getLmStudioResidencyError,
  getLoadedModels as getLoadedLmStudioModels,
} from '../services/lmStudioManager.js'

const router = Router()

const emitter = (req) => {
  const io = req.app.get('io')
  return (event, message) => io?.emit('localLlm:progress', { event, message })
}

// GET /api/local-llm/status — both backends + active marker
router.get('/status', asyncHandler(async (req, res) => {
  res.json(await getStatus())
}))

// GET /api/local-llm/vision-models — vision-capable installed models across
// both backends, tagged with the provider id that serves them. Powers the
// LoRA caption-model picker.
router.get('/vision-models', asyncHandler(async (_req, res) => {
  res.json({ models: await listVisionModels() })
}))

// GET /api/local-llm/tool-use-models — tool-use (function-calling) capable
// installed models across both backends, tagged with the provider id that serves
// them. Powers the agent model pickers' tool-use annotation.
//
// Kept separate from /vision-models rather than folded into it: that endpoint's
// contract is "every row returned is vision-capable" (the LoRA caption picker
// lists its rows verbatim), so returning tool-only rows there would need a
// discriminator plus a filter in every existing consumer, and its CLI-provider
// expansion has no tool-use analogue.
router.get('/tool-use-models', asyncHandler(async (_req, res) => {
  res.json({ models: await listToolUseModels() })
}))

// GET /api/local-llm/catalog?backend=ollama&q=llama — curated install picker.
// HF-repo-backed entries are enriched with the same per-quant variant picker +
// RAM-aware default as the live Hugging Face search, so the recommended quant
// fits this machine instead of being hard-coded per model.
router.get('/catalog', asyncHandler(async (req, res) => {
  const { backend, q, variants } = req.query
  if (!isBackend(backend)) throw new ServerError('backend must be "ollama" or "lmstudio"', { status: 400 })
  const installedModels = await listModels(backend)
  // getCatalog/searchCatalog normalize raw ids (no `@quant` suffix) — feed them the
  // RAW ids so the offline installed overlay is correct even when HF enrichment
  // fails/times out. Variant enrichment gets the quant-augmented ids (`<id>@<quant>`)
  // for per-quant installed detection (a single installed quant must not flag every
  // quant of a repo as installed) — it overwrites the overlay on success.
  const installedRaw = installedModels.map((m) => m.id)
  const installedForVariants = installedModels.map((m) => (
    backend === 'lmstudio' && m.quantization ? `${m.id}@${m.quantization}` : m.id
  ))
  // Native MLX entries are meaningful only on Apple Silicon. Keep this gate at
  // the route boundary so the pure catalog remains useful to tests and other
  // callers while the user-facing picker never offers an un-runnable format.
  const catalogOptions = { appleSilicon: isAppleSilicon() }
  const models = q
    ? searchCatalog(backend, q, installedRaw, catalogOptions)
    : getCatalog(backend, installedRaw, catalogOptions)
  // Total system memory drives the RAM-aware recommended quant (unified memory on
  // Apple Silicon also backs the GPU, so a big box can default to higher fidelity).
  const systemMemoryBytes = os.totalmem()
  // Quant-variant enrichment probes Hugging Face per HF-backed entry, so it's
  // opt-in (`?variants=1`): the recommended-models picker requests it, but callers
  // that only need catalog metadata (e.g. the playground decorating installed
  // models) get the fast, fully-local response the catalog has always been.
  if (variants === '1' || variants === 'true') {
    await enrichCatalogWithVariants(models, { backend, systemMemoryBytes, installedIds: installedForVariants })
  }
  // Measured evidence overrules the size estimate wherever a model has actually
  // been run here. Disk-only read — a catalog listing must never trigger a
  // measurement (AI Provider Usage Policy).
  applyMeasuredFit(models, { backend, measured: await getMeasuredFits(backend).catch(() => ({})) })
  res.json({ backend, models, systemMemoryGb: Math.round(systemMemoryBytes / 1024 ** 3) })
}))

// GET /api/local-llm/huggingface-search?backend=ollama&q=qwen&category=coding
// Live Hub discovery — GGUF-compatible community models, plus (for the `audio`
// category) audio/music generators that install into the shared audio-model
// registry and surface in the Music studio.
router.get('/huggingface-search', asyncHandler(async (req, res) => {
  const { backend, q, category, limit } = validateRequest(localLlmHuggingFaceSearchSchema, req.query)
  // Carry LM Studio's per-model quantization into the installed id (`<id>@<quant>`)
  // so the catalog can mark per-quant installed state — LM Studio's `id` alone is
  // repo-level, which would otherwise flag every quant of a repo as installed.
  const installed = (await listModels(backend)).map((m) => (
    backend === 'lmstudio' && m.quantization ? `${m.id}@${m.quantization}` : m.id
  ))
  // Cross-reference the shared audio-model registry so a model already installed
  // via the Music studio (or this tab) shows "Installed". Only the user-added
  // repos count — shipped engine defaults download lazily on first generation.
  let installedAudioRepos = []
  if (category === 'audio') {
    const perEngine = await Promise.all(Object.keys(ENGINES).map((id) => listUserModels(id)))
    installedAudioRepos = perEngine.flat().map((m) => m.repo)
  }
  // Total system memory drives the RAM-aware default quant pick and the per-quant
  // fit verdicts. On unified-memory Macs this pool also backs the GPU, so a big
  // box can default to a higher-fidelity build than the old Q4-always pick.
  const systemMemoryBytes = os.totalmem()
  // Live Hugging Face MLX results surface only on Apple Silicon through LM Studio;
  // packaged Ollama MLX tags live in the curated catalog above. Gate this extra
  // Hub query so non-Apple installs don't see un-installable results. Detected at
  // the route boundary so the service stays deterministic.
  const appleSilicon = isAppleSilicon()
  const models = await searchHuggingFaceModels({ backend, query: q, category, limit, installedIds: installed, installedAudioRepos, systemMemoryBytes, appleSilicon })
  applyMeasuredFit(models, { backend, measured: await getMeasuredFits(backend).catch(() => ({})) })
  res.json({ backend, source: 'huggingface', models, systemMemoryGb: Math.round(systemMemoryBytes / 1024 ** 3), appleSilicon })
}))

// POST /api/local-llm/install-backend — install the backend app/binary itself
// (Homebrew on macOS, official script for Ollama on Linux). Streams progress.
router.post('/install-backend', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(localLlmInstallBackendSchema, req.body)
  const emit = emitter(req)
  const result = await installBackend(backend, ({ event, message }) => emit(event, message))
    .catch((err) => {
      emit('error', `Install failed: ${err.message}`)
      throw err
    })
  if (!result.success) {
    emit('error', result.error || 'Install failed')
    throw new ServerError(result.error || 'Install failed', { status: 502, context: { backend } })
  }
  emit('complete', `${backend === 'ollama' ? 'Ollama' : 'LM Studio'} installed${result.note ? ` — ${result.note}` : ''}`)
  res.json(result)
}))

// POST /api/local-llm/ollama-service — start/stop the local Ollama server
router.post('/ollama-service', asyncHandler(async (req, res) => {
  const { action } = validateRequest(localLlmOllamaServiceSchema, req.body)
  const emit = emitter(req)
  const actionLabel = {
    start: 'Starting Ollama…',
    stop: 'Stopping Ollama…',
    enable: 'Registering Ollama as a background service…',
    disable: 'Disabling Ollama background service…'
  }[action]
  emit('start', actionLabel)
  const result = await controlOllamaServer(action).catch((err) => {
    emit('error', `Ollama ${action} failed: ${err.message}`)
    throw err
  })
  if (!result.success) {
    emit('error', result.error || `Ollama ${action} failed`)
    throw new ServerError(result.error || `Ollama ${action} failed`, { status: 502 })
  }
  const completeLabel = {
    start: 'Ollama is running',
    stop: 'Ollama stopped',
    enable: 'Ollama will run in the background at login',
    disable: 'Ollama background service disabled'
  }[action]
  emit('complete', completeLabel)
  res.json(result)
}))

// POST /api/local-llm/lmstudio-service — start/stop LM Studio's local server
// via its own `lms` CLI. No enable/disable counterpart: launch-at-login belongs
// to the LM Studio app, not to `lms`.
router.post('/lmstudio-service', asyncHandler(async (req, res) => {
  const { action } = validateRequest(localLlmLmStudioServiceSchema, req.body)
  const emit = emitter(req)
  emit('start', action === 'start' ? 'Starting the LM Studio server…' : 'Stopping the LM Studio server…')
  const result = await controlLmStudioServer(action).catch((err) => {
    emit('error', `LM Studio ${action} failed: ${err.message}`)
    throw err
  })
  if (!result.success) {
    emit('error', result.error || `LM Studio ${action} failed`)
    throw new ServerError(result.error || `LM Studio ${action} failed`, { status: 502 })
  }
  resetProviderReadinessCache()
  emit('complete', action === 'start' ? 'LM Studio server is running' : 'LM Studio server stopped')
  res.json(result)
}))

// POST /api/local-llm/install — pull/download a model (streams progress)
router.post('/install', asyncHandler(async (req, res) => {
  const { backend, modelId, force } = validateRequest(localLlmInstallSchema, req.body)
  const emit = emitter(req)
  emit('start', `${force ? 'Redownloading' : 'Installing'} ${modelId} on ${backend}…`)
  // A thrown rejection (e.g. the pull stream dropping mid-download) would 500
  // via asyncHandler but never emit a terminal progress frame, leaving the
  // client's progress banner stuck on the last 'start'. Surface it as 'error'.
  // Any statused frame renders — percent progress, a transient-error retry, or
  // the `finalizing` pass where PortOS completes an install Ollama abandoned
  // (without which the banner would sit at "100%" through the whole recovery).
  const result = await installModel(backend, modelId, (p) => {
    const label = describeInstallProgress(p)
    if (label) emit('start', `${modelId}: ${label}`)
  }, { force: !!force }).catch((err) => {
    emit('error', `Install failed: ${err.message}`)
    throw err
  })
  if (!result.success) {
    emit('error', result.error || 'Install failed')
    // Forward structured `code` (e.g. OLLAMA_OUTDATED) so the client can offer
    // a recovery action — like prompting to upgrade Ollama — instead of just
    // surfacing the raw error string in a toast.
    throw new ServerError(result.error || 'Install failed', { status: 502, ...(result.code ? { code: result.code } : {}), context: { modelId } })
  }
  emit('complete', result.pending
    ? `${modelId} download started in LM Studio — it'll finish in the background`
    : `${modelId} ${force ? 'redownloaded' : 'installed'} on ${backend}`)
  res.json({ success: true, ...result })
}))

// POST /api/local-llm/upgrade-backend — upgrade an existing backend install
// (Homebrew on macOS, official script for Ollama on Linux). Streams progress
// over the same `localLlm:progress` socket event the install/pull paths use.
router.post('/upgrade-backend', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(localLlmInstallBackendSchema, req.body)
  const emit = emitter(req)
  const result = await upgradeBackend(backend, ({ event, message }) => emit(event, message))
    .catch((err) => {
      emit('error', `Upgrade failed: ${err.message}`)
      throw err
    })
  if (!result.success) {
    emit('error', result.error || 'Upgrade failed')
    throw new ServerError(result.error || 'Upgrade failed', { status: 502, context: { backend } })
  }
  emit('complete', `${backend === 'ollama' ? 'Ollama' : 'LM Studio'} upgraded${result.note ? ` — ${result.note}` : ''}`)
  res.json(result)
}))

// POST /api/local-llm/delete — remove an installed model
router.post('/delete', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmDeleteSchema, req.body)
  const result = await deleteModel(backend, modelId)
  if (!result.success) throw new ServerError(result.error || 'Delete failed', { status: 502, context: { modelId } })
  res.json({ success: true, ...result })
}))

// POST /api/local-llm/switch — set the default backend without moving models
router.post('/switch', asyncHandler(async (req, res) => {
  const { to } = validateRequest(localLlmSwitchSchema, req.body)
  const emit = emitter(req)
  emit('start', `Setting ${to} as default…`)
  const result = await switchBackend(to)
  if (!result.success) {
    emit('error', result.error || 'Switch failed')
    throw new ServerError(result.error || 'Switch failed', { status: 500 })
  }
  emit('complete', `${to} is now the default backend`)
  res.json(result)
}))

// POST /api/local-llm/migrate — move the OTHER backend's models onto `to`
// (bidirectional; link/share or copy GGUF locally where possible, else re-pull).
// Does NOT change the default backend — use /switch for that.
router.post('/migrate', asyncHandler(async (req, res) => {
  const { to, mode } = validateRequest(localLlmMigrateSchema, req.body)
  const emit = emitter(req)
  const result = await migrateBackend(to, { mode, onProgress: ({ event, message }) => emit(event, message) })
  if (!result.success) {
    emit('error', result.error || 'Migration failed')
    throw new ServerError(result.error || 'Migration failed', { status: 500 })
  }
  res.json(result)
}))

// GET /api/local-llm/loaded — models currently resident in memory across both
// local backends. The endpoint stays 200 for a partial outage, but names the
// affected source explicitly so an unknown residency state is never mistaken
// for a trustworthy empty list by cleanup controls.
// Distinct from /catalog (disk-installed) — only flags what's eating VRAM
// right now so the Memory Management panel can show what to unload before
// kicking off a big diffusion render.
//
// sourceErrors stays the full failure list: a backend the user marked disabled
// (localLlm.<id>.disabled — "PortOS will not expect this backend to be running")
// is STILL probed, and a failed probe on a disabled-but-actually-running backend
// must keep its "unknown residency" status so "Free everything" can't claim it
// reclaimed a model it can't even see. The `disabled` field names the backends
// the user opted out of availability warnings for, so the panel stays quiet
// about them WITHOUT weakening that cleanup guard.
router.get('/loaded', asyncHandler(async (_req, res) => {
  const settings = await getSettings().catch(() => ({}))
  const ollamaDisabled = Boolean(settings.localLlm?.ollama?.disabled)
  const lmStudioDisabled = Boolean(settings.localLlm?.lmstudio?.disabled)
  const [ollama, lmstudio] = await Promise.all([
    getLoadedOllamaModels(),
    getLoadedLmStudioModels(true),
   ])
  const sourceErrors = [
     ...(getOllamaResidencyError() ? ['ollama'] : []),
     ...(getLmStudioResidencyError() ? ['lmstudio'] : []),
   ]
  const disabled = [
     ...(ollamaDisabled ? ['ollama'] : []),
     ...(lmStudioDisabled ? ['lmstudio'] : []),
   ]
  res.json({ ollama, lmstudio, sourceErrors, disabled })
}))

// POST /api/local-llm/unload — body: { backend: 'ollama', modelId }.
// Forces Ollama to evict the named model immediately (`keep_alive: 0`).
// LM Studio's unload lives at POST /api/lmstudio/unload — we don't proxy
// it here to keep each backend's quirks behind its own router.
router.post('/unload', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmUnloadSchema, req.body)
  if (backend !== 'ollama') throw new ServerError('backend must be "ollama" (use /api/lmstudio/unload for LM Studio)', { status: 400 })
  const result = await unloadOllamaModel(modelId)
  // "not loaded" is an idempotent no-op (the model already isn't resident
  // — between the panel's last poll and this click it may have hit Ollama's
  // keep_alive idle timer). Return 200 so the client sees a clean outcome
  // and doesn't surface a red error toast. 502 stays reserved for genuine
  // failures (Ollama unreachable / request errored / non-2xx from /api/generate).
  if (!result.unloaded) {
    if (result.reason === 'not loaded') {
      return res.json({ success: true, unloaded: false, reason: result.reason, modelId })
    }
    throw new ServerError(result.reason || 'unload failed', { status: 502, context: { modelId } })
  }
  res.json({ success: true, ...result })
}))

// POST /api/local-llm/test — run one installed local model with a prompt.
// Returns speed metrics and a run id so the playground can inspect output
// quality without leaving the Local LLM workflow.
router.post('/test', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmTestSchema, req.body)
  res.json(await runLocalLlmTest({ ...body, signal: abortSignalFromResponse(res) }))
}))

// POST /api/local-llm/test/stream — same as /test, but streams the model's
// output token-by-token as newline-delimited JSON (NDJSON) so the playground
// can render live. Frames: `{ type: 'token', delta, kind }` per chunk (kind is
// 'content' or 'reasoning' so the client can render thinking separately), then a
// terminal `{ type: 'result', result }` carrying the same object /test returns
// (text, timings, runId, and any error). `runLocalLlmTest` resolves rather than
// throws — including on timeout/abort — so the result frame always lands while
// the socket is alive, and no JSON error body is attempted after headers flush.
router.post('/test/stream', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmTestSchema, req.body)
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // Once headers are flushed the response is "in stream mode" — never throw past
  // here. A write after the client disconnected can throw ERR_STREAM_WRITE_AFTER_END;
  // treat any failure as a dead socket and drop the frame.
  //
  // Honour socket backpressure: when `res.write` returns false the kernel/send
  // buffer is full, so await the next `drain` before letting the producer queue
  // more NDJSON. A fast local model writing to a slow reader would otherwise
  // buffer the whole response in memory. The producer awaits `onToken`, so
  // returning this promise actually pauses the upstream read until the socket
  // catches up. (`awaitWritableDrain` is the same helper routes/ask.js uses.)
  const write = async (frame) => {
    if (res.writableEnded || res.destroyed) return
    let writeOk
    try { writeOk = res.write(`${JSON.stringify(frame)}\n`) } catch { return /* client gone */ }
    if (!writeOk) await awaitWritableDrain(res)
  }

  // `runLocalLlmTest` resolves for in-stream failures, but can still THROW before
  // the stream opens (unconfigured/invalid provider). Headers are already flushed,
  // so a throw past here can't bubble to asyncHandler's JSON error path without
  // ERR_HTTP_HEADERS_SENT — convert it to a terminal result frame the client toasts.
  const result = await runLocalLlmTest({
    ...body,
    signal: abortSignalFromResponse(res),
    onToken: (delta, kind = 'content') => (delta ? write({ type: 'token', delta, kind }) : undefined),
  }).catch((err) => ({
    backend: body.backend,
    modelId: body.modelId,
    error: err?.message || 'Local LLM test failed',
    text: '',
  }))
  await write({ type: 'result', result })
  res.end()
}))

// POST /api/local-llm/compare — run one prompt through multiple local models.
// `round-robin` measures each model in isolation; `parallel` intentionally
// measures contention when several loaded local models run at once.
router.post('/compare', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmCompareSchema, req.body)
  res.json(await compareLocalLlmModels({ ...body, signal: abortSignalFromResponse(res) }))
}))

// === Measured local-model assessments ========================================
// PortOS's catalog fit badge is a size estimate that never runs the model. These
// endpoints back the measured alternative: run a model at several context sizes
// and rank installed models on the evidence.
//
// The read/run split is the AI Provider Usage Policy boundary (root CLAUDE.md):
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
  const onProgress = (frame) => io?.emit('localLlm:progress', frame)
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
    onProgress: (frame) => io?.emit('localLlm:progress', frame),
  })
  // A refused start (one already running, or nothing to measure) is a 409, not a
  // silent no-op that would leave the page waiting for progress that never comes.
  if (status.rejected) throw new ServerError(status.rejected, { status: 409, context: { scope } })
  res.json(status)
}))

// GET /api/local-llm/assessments/sweep — queue status. Module state only, zero
// LLM calls, so the page can poll it and a reload can pick a running sweep back up.
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
  const onProgress = (frame) => io?.emit('localLlm:progress', frame)
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

// === llama-server (DFlash 2 / Speculative Decoding) ==========================
// GET /api/local-llm/llama-server/status — binary availability, process state,
// logs, and the curated target/drafter presets with each GGUF's on-disk state.
// The presets ride along on the status call the launcher already makes so the
// card can render "not downloaded + Download" instead of making the user press
// Start to discover a missing file. Disk-only: no Hugging Face call here.
router.get('/llama-server/status', asyncHandler(async (_req, res) => {
  const [status, presets] = await Promise.all([getLlamaServerStatus(), getSpecDecodePresetStatus()])
  // Spec-type suggestions ride along for the same reason the presets do: the
  // card renders the server's list instead of keeping a copy that can rot.
  res.json({ ...status, presets, specTypes: SPEC_TYPE_SUGGESTIONS })
}))

// POST /api/local-llm/llama-server/download-model — fetch one preset's GGUF from
// Hugging Face into the exact path the launcher will pass llama.cpp. Byte
// progress streams over `llamaServer:download`; the card renders it as a bar on
// the row that started it.
router.post('/llama-server/download-model', asyncHandler(async (req, res) => {
  const { presetId, role } = validateRequest(localLlmSpecModelDownloadSchema, req.body)
  const io = req.app.get('io')
  const result = await downloadSpecDecodeModel({
    presetId,
    role,
    onProgress: (frame) => io?.emit('llamaServer:download', frame),
  })
  res.json(result)
}))

// Each of the three actions below changes exactly what the provider-readiness
// probes remember — is the binary there, is something answering — so each drops
// those caches. Without it the Providers page keeps reporting "llama.cpp setup
// incomplete" for up to a cache TTL after the user fixed it right here.

// POST /api/local-llm/llama-server/start — launch llama-server
router.post('/llama-server/start', asyncHandler(async (req, res) => {
  const options = validateRequest(localLlmLlamaServerStartSchema, req.body)
  const result = await startLlamaServer(options)
  resetProviderReadinessCache()
  res.json(result)
}))

// POST /api/local-llm/llama-server/stop — stop managed llama-server
router.post('/llama-server/stop', asyncHandler(async (_req, res) => {
  const result = await stopLlamaServer()
  resetProviderReadinessCache()
  res.json(result)
}))

// POST /api/local-llm/llama-server/install — install llama.cpp via Homebrew
router.post('/llama-server/install', asyncHandler(async (req, res) => {
  const io = req.app.get('io')
  const onProgress = (data) => io?.emit('localLlm:progress', data)
  const result = await installLlamaServer({ onProgress })
  resetProviderReadinessCache()
  res.json(result)
}))

// === MTPLX (native-MTP Qwen on Apple Silicon) ================================
// Managed exactly like llama-server: a PM2 process (`portos-mtplx`) PortOS can
// start, stop, log, and — via /save-startup below — persist across a reboot.
// PortOS never downloads MTPLX weights; `serve` runs on a checkpoint already in
// MTPLX's own cache. See docs/features/mtplx.md.

// GET /api/local-llm/mtplx/status — binary availability, process state, the
// endpoint it serves on, its cached checkpoints, and recent logs. Disk + a
// loopback probe only.
router.get('/mtplx/status', asyncHandler(async (_req, res) => {
  res.json(await getMtplxServerStatus())
}))

// POST /api/local-llm/mtplx/start — launch `mtplx serve` under PM2
router.post('/mtplx/start', asyncHandler(async (req, res) => {
  const options = validateRequest(localLlmMtplxStartSchema, req.body)
  const emit = emitter(req)
  emit('start', 'Starting MTPLX…')
  const result = await startMtplxServer({ ...options, onProgress: (line) => emit('start', line) })
    .catch((err) => {
      emit('error', err.message)
      throw err
    })
  resetProviderReadinessCache()
  emit('complete', `MTPLX is running at ${result.endpoint}`)
  res.json(result)
}))

// POST /api/local-llm/mtplx/stop — stop the managed MTPLX process
router.post('/mtplx/stop', asyncHandler(async (_req, res) => {
  const result = await stopMtplxServer()
  resetProviderReadinessCache()
  res.json(result)
}))

// POST /api/local-llm/mtplx/install — install MTPLX (Homebrew tap, pip fallback)
router.post('/mtplx/install', asyncHandler(async (req, res) => {
  const emit = emitter(req)
  const result = await installMtplx({ onProgress: ({ event, message }) => emit(event, message) })
    .catch((err) => {
      emit('error', `Install failed: ${err.message}`)
      throw err
    })
  resetProviderReadinessCache()
  emit('complete', 'MTPLX installed')
  res.json(result)
}))

// --- MTPLX model catalog ----------------------------------------------------
// Search / download / remove MTP checkpoints without leaving PortOS. Before
// these existed the card told the user to run `mtplx pull` in a terminal, which
// is a dead end inside an app that manages the runtime everywhere else.

// GET /api/local-llm/mtplx/models/search — MTPLX-branded checkpoints on
// Hugging Face (`mtplx forge discover`). Network call; no download.
router.get('/mtplx/models/search', asyncHandler(async (req, res) => {
  const params = validateRequest(localLlmMtplxSearchSchema, req.query)
  res.json(await searchMtplxCatalog(params))
}))

// POST /api/local-llm/mtplx/models/pull — download one checkpoint into MTPLX's
// cache. Byte progress streams over `mtplx:download`; the card renders it as a
// bar on the row that started it. Omitting `model` fetches MTPLX's own verified
// default, the same checkpoint the provider-readiness checklist pulls.
router.post('/mtplx/models/pull', asyncHandler(async (req, res) => {
  const { model } = validateRequest(localLlmMtplxPullSchema, req.body)
  const io = req.app.get('io')
  const result = await pullMtplxModel({ model, onProgress: (frame) => io?.emit('mtplx:download', frame) })
  // A cache that just went from empty to servable is exactly what the readiness
  // probes remember as "MTPLX setup incomplete".
  if (result.success) resetProviderReadinessCache()
  res.json(result)
}))

// POST /api/local-llm/mtplx/models/remove — delete one checkpoint from the cache
router.post('/mtplx/models/remove', asyncHandler(async (req, res) => {
  const { model } = validateRequest(localLlmMtplxRemoveSchema, req.body)
  const result = await removeMtplxModel(model)
  resetProviderReadinessCache()
  res.json(result)
}))

// POST /api/local-llm/save-startup — `pm2 save`, so the PM2-managed local
// runtime servers currently running (llama-server, MTPLX, PortOS itself) are in
// the dump a boot-time `pm2 resurrect` replays. The privileged half — `pm2
// startup`, which writes the launchd/systemd unit — is deliberately blocked and
// stays a one-time operator command.
router.post('/save-startup', asyncHandler(async (_req, res) => {
  res.json(await saveProcessList())
}))

export default router
