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
  localLlmInstallBackendSchema
} from '../lib/validation.js'
import { getCatalog, searchCatalog, isBackend } from '../lib/localLlmCatalog.js'
import {
  getStatus, listModels, installModel, deleteModel, switchBackend, migrateBackend, installBackend
} from '../services/localLlm.js'

const router = Router()

const emitter = (req) => {
  const io = req.app.get('io')
  return (event, message) => io?.emit('localLlm:progress', { event, message })
}

// GET /api/local-llm/status — both backends + active marker
router.get('/status', asyncHandler(async (req, res) => {
  res.json(await getStatus())
}))

// GET /api/local-llm/models?backend=ollama — installed models for a backend
router.get('/models', asyncHandler(async (req, res) => {
  const { backend } = req.query
  if (!isBackend(backend)) return res.status(400).json({ error: 'backend must be "ollama" or "lmstudio"' })
  res.json({ backend, models: await listModels(backend) })
}))

// GET /api/local-llm/catalog?backend=ollama&q=llama — curated install picker
router.get('/catalog', asyncHandler(async (req, res) => {
  const { backend, q } = req.query
  if (!isBackend(backend)) return res.status(400).json({ error: 'backend must be "ollama" or "lmstudio"' })
  const installed = (await listModels(backend)).map((m) => m.id)
  const models = q ? searchCatalog(backend, q, installed) : getCatalog(backend, installed)
  res.json({ backend, models })
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
  }).catch((err) => {
    emit('error', `Install failed: ${err.message}`)
    throw err
  })
  if (!result.success) {
    emit('error', result.error || 'Install failed')
    return res.status(502).json({ error: result.error || 'Install failed', modelId })
  }
  emit('complete', result.pending
    ? `${modelId} download started in LM Studio — it'll finish in the background`
    : `${modelId} installed on ${backend}`)
  res.json({ success: true, ...result })
}))

// POST /api/local-llm/delete — remove an installed model
router.post('/delete', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmDeleteSchema, req.body)
  const result = await deleteModel(backend, modelId)
  if (!result.success) return res.status(502).json({ error: result.error || 'Delete failed', modelId })
  res.json({ success: true, ...result })
}))

// POST /api/local-llm/switch — flip active backend without moving models
router.post('/switch', asyncHandler(async (req, res) => {
  const { to } = validateRequest(localLlmSwitchSchema, req.body)
  const emit = emitter(req)
  emit('start', `Switching to ${to}…`)
  const result = await switchBackend(to)
  if (!result.success) {
    emit('error', result.error || 'Switch failed')
    return res.status(500).json({ error: result.error || 'Switch failed' })
  }
  emit('complete', `Switched to ${to}`)
  res.json(result)
}))

// POST /api/local-llm/migrate — provision models on target (copy GGUF locally
// where possible, else re-pull), then switch the active backend
router.post('/migrate', asyncHandler(async (req, res) => {
  const { to } = validateRequest(localLlmSwitchSchema, req.body)
  const emit = emitter(req)
  const result = await migrateBackend(to, ({ event, message }) => emit(event, message))
  if (!result.success) {
    emit('error', result.error || 'Migration failed')
    return res.status(500).json({ error: result.error || 'Migration failed' })
  }
  res.json(result)
}))

export default router
