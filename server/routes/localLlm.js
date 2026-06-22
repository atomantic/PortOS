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
  localLlmCompareSchema
} from '../lib/validation.js'
import { getCatalog, searchCatalog, isBackend } from '../lib/localLlmCatalog.js'
import { isAppleSilicon } from '../lib/platform.js'
import { searchHuggingFaceModels, enrichCatalogWithVariants } from '../services/huggingFaceCatalog.js'
import {
  getStatus, listModels, listVisionModels, installModel, deleteModel, switchBackend, migrateBackend, installBackend, upgradeBackend, controlOllamaServer
} from '../services/localLlm.js'
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js'
import { listUserModels } from '../services/audioModels.js'
import { ENGINES } from '../services/pipeline/musicGen.js'
import { abortSignalFromResponse } from '../lib/requestAbort.js'
import { awaitWritableDrain } from '../lib/streamBackpressure.js'
import { getLoadedModels as getLoadedOllamaModels, unloadModel as unloadOllamaModel } from '../services/ollamaManager.js'

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

// GET /api/local-llm/catalog?backend=ollama&q=llama — curated install picker.
// HF-repo-backed entries are enriched with the same per-quant variant picker +
// RAM-aware default as the live Hugging Face search, so the recommended quant
// fits this machine instead of being hard-coded per model.
router.get('/catalog', asyncHandler(async (req, res) => {
  const { backend, q } = req.query
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
  const models = q ? searchCatalog(backend, q, installedRaw) : getCatalog(backend, installedRaw)
  // Total system memory drives the RAM-aware recommended quant (unified memory on
  // Apple Silicon also backs the GPU, so a big box can default to higher fidelity).
  const systemMemoryBytes = os.totalmem()
  await enrichCatalogWithVariants(models, { backend, systemMemoryBytes, installedIds: installedForVariants })
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
  // MLX models surface only on Apple Silicon (and only for LM Studio) — gate the
  // extra MLX query on the host so non-Apple installs don't see un-installable
  // results. Detected here at the route boundary; the service stays deterministic.
  const appleSilicon = isAppleSilicon()
  const models = await searchHuggingFaceModels({ backend, query: q, category, limit, installedIds: installed, installedAudioRepos, systemMemoryBytes, appleSilicon })
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

// POST /api/local-llm/install — pull/download a model (streams progress)
router.post('/install', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmInstallSchema, req.body)
  const emit = emitter(req)
  emit('start', `Installing ${modelId} on ${backend}…`)
  // A thrown rejection (e.g. the pull stream dropping mid-download) would 500
  // via asyncHandler but never emit a terminal progress frame, leaving the
  // client's progress banner stuck on the last 'start'. Surface it as 'error'.
  const result = await installModel(backend, modelId, (p) => {
    if (p?.percent != null) emit('start', `${modelId}: ${p.status || 'downloading'} ${p.percent}%`)
    else if (p?.retrying) emit('start', `${modelId}: ${p.status || 'retrying…'}`)
  }).catch((err) => {
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
    : `${modelId} installed on ${backend}`)
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

// GET /api/local-llm/loaded — models currently resident in memory.
// Distinct from /catalog (disk-installed) — only flags what's eating VRAM
// right now so the Memory Management panel can show what to unload before
// kicking off a big diffusion render.
router.get('/loaded', asyncHandler(async (req, res) => {
  const loaded = await getLoadedOllamaModels()
  res.json({ ollama: loaded })
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

export default router
