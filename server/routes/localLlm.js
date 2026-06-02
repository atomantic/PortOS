/**
 * Local LLM Routes
 *
 * REST endpoints for managing local LLM backends (Ollama / LM Studio):
 * backend status, installed-model listing, a curated install catalog,
 * install/delete, and switch/migrate between backends. Long-running pulls and
 * migrations stream progress over the `localLlm:progress` socket event (same
 * contract the Database tab uses).
 */

import { Router } from 'express'
import { asyncHandler } from '../lib/errorHandler.js'
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
import { searchHuggingFaceModels } from '../services/huggingFaceCatalog.js'
import {
  getStatus, listModels, installModel, deleteModel, switchBackend, migrateBackend, installBackend, upgradeBackend, controlOllamaServer
} from '../services/localLlm.js'
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js'
import { abortSignalFromResponse } from '../lib/requestAbort.js'
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

// GET /api/local-llm/catalog?backend=ollama&q=llama — curated install picker
router.get('/catalog', asyncHandler(async (req, res) => {
  const { backend, q } = req.query
  if (!isBackend(backend)) return res.status(400).json({ error: 'backend must be "ollama" or "lmstudio"' })
  const installed = (await listModels(backend)).map((m) => m.id)
  const models = q ? searchCatalog(backend, q, installed) : getCatalog(backend, installed)
  res.json({ backend, models })
}))

// GET /api/local-llm/huggingface-search?backend=ollama&q=qwen&category=coding
// Live Hub discovery for GGUF-compatible community models.
router.get('/huggingface-search', asyncHandler(async (req, res) => {
  const { backend, q, category, limit } = validateRequest(localLlmHuggingFaceSearchSchema, req.query)
  const installed = (await listModels(backend)).map((m) => m.id)
  const models = await searchHuggingFaceModels({ backend, query: q, category, limit, installedIds: installed })
  res.json({ backend, source: 'huggingface', models })
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
    return res.status(502).json({ error: result.error || 'Install failed', backend })
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
    return res.status(502).json({ error: result.error || `Ollama ${action} failed` })
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
    return res.status(502).json({ error: result.error || 'Install failed', modelId, ...(result.code ? { code: result.code } : {}) })
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
    return res.status(502).json({ error: result.error || 'Upgrade failed', backend })
  }
  emit('complete', `${backend === 'ollama' ? 'Ollama' : 'LM Studio'} upgraded${result.note ? ` — ${result.note}` : ''}`)
  res.json(result)
}))

// POST /api/local-llm/delete — remove an installed model
router.post('/delete', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmDeleteSchema, req.body)
  const result = await deleteModel(backend, modelId)
  if (!result.success) return res.status(502).json({ error: result.error || 'Delete failed', modelId })
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
    return res.status(500).json({ error: result.error || 'Switch failed' })
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
    return res.status(500).json({ error: result.error || 'Migration failed' })
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
  if (backend !== 'ollama') return res.status(400).json({ error: 'backend must be "ollama" (use /api/lmstudio/unload for LM Studio)' })
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
    return res.status(502).json({ error: result.reason || 'unload failed', modelId })
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

// POST /api/local-llm/compare — run one prompt through multiple local models.
// `round-robin` measures each model in isolation; `parallel` intentionally
// measures contention when several loaded local models run at once.
router.post('/compare', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmCompareSchema, req.body)
  res.json(await compareLocalLlmModels({ ...body, signal: abortSignalFromResponse(res) }))
}))

export default router
