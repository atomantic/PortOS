import { loadedObservation } from '../../services/localModelObservations.js'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import {
  localLlmInstallSchema,
  localLlmModelTargetSchema,
  localLlmLoadedQuerySchema,
  localLlmDeleteSchema,
  localLlmSwitchSchema,
  localLlmUnloadSchema,
  localLlmMigrateSchema,
  localLlmInstallBackendSchema,
  localLlmOllamaServiceSchema,
  localLlmLmStudioServiceSchema,
  localLlmDownloadPreflightSchema,
  localPersistentMindSetupApplySchema,
} from '../../lib/mediaValidation.js'
import { localLlmProgress as emitter } from '../localLlmProgress.js'
import { previewSlotstreamDownload } from '../../services/slotstreamModelManager.js'
import { previewMtplxPull } from '../../services/mtplxModelManager.js'
import { previewSpecDecodeDownload } from '../../services/specDecodeModels.js'
import { resetProviderReadinessCache } from '../../services/provider/providerReadiness.js'
import {
  getStatus,
  installModel,
  cancelModelInstall,
  previewInstallModel,
  deleteModel,
  switchBackend,
  migrateBackend,
  installBackend,
  upgradeBackend,
  controlOllamaServer,
  describeInstallProgress,
} from '../../services/localLlm.js'
import { describeLocalPersistentMindSetup, applyLocalPersistentMindSetup } from '../../services/localPersistentMindSetup.js'
import { unloadModel as unloadOllamaModel } from '../../services/ollamaManager.js'
import { controlLmStudioServer } from '../../services/lmStudioManager.js'

const router = Router()

// GET /api/local-llm/persistent-mind-setup — Grok-box / CPU-only free local
// Persistent Mind checklist (Ollama + Qwen2.5 7B Instruct). Applicable hosts
// only; curated GPU coding hosts get applicable:false.
router.get('/persistent-mind-setup', asyncHandler(async (_req, res) => {
  res.json(await describeLocalPersistentMindSetup())
}))

// POST /api/local-llm/persistent-mind-setup/apply — enable the ollama provider
// and optionally pin the Persistent Mind profile. Never installs Ollama or
// pulls weights (those stay on install-backend / install / ollama-service).
router.post('/persistent-mind-setup/apply', asyncHandler(async (req, res) => {
  const body = validateRequest(localPersistentMindSetupApplySchema, req.body || {})
  const result = await applyLocalPersistentMindSetup(body)
  if (!result.success) {
    throw new ServerError(result.error || 'Could not apply local Persistent Mind setup', {
      status: 400,
      context: { applicable: result.status?.applicable === true },
    })
  }
  resetProviderReadinessCache()
  res.json(result)
}))

// GET /api/local-llm/status — both backends + active marker
router.get('/status', asyncHandler(async (req, res) => {
  res.json(await getStatus())
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

// POST /api/local-llm/download-preflight — size / dest / free-disk numbers for
// the confirm step. Does not start a transfer. An `insufficient` verdict is
// returned in the body so the UI can disable Confirm; the download endpoints
// still throw DISK_INSUFFICIENT if the confirm is skipped.
router.post('/download-preflight', asyncHandler(async (req, res) => {
  const body = validateRequest(localLlmDownloadPreflightSchema, req.body)
  if (body.kind === 'spec-decode') {
    res.json(await previewSpecDecodeDownload({ presetId: body.presetId, role: body.role }))
    return
  }
  if (body.kind === 'mtplx') {
    res.json(await previewMtplxPull({ model: body.model }))
    return
  }
  if (body.kind === 'slotstream') {
    res.json(await previewSlotstreamDownload({ model: body.model }))
    return
  }
  res.json(await previewInstallModel(body.backend, body.modelId))
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
  // A user's Cancel is not a failure: no error toast, just a terminal frame.
  if (result.canceled) {
    emit('error', `${modelId} download canceled`)
    res.json({ success: false, canceled: true, modelId })
    return
  }
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

// POST /api/local-llm/install/cancel — stop a download POST /install started.
// The install request then answers `{ canceled: true }` after removing the
// partial files.
router.post('/install/cancel', asyncHandler(async (req, res) => {
  const { backend, modelId } = validateRequest(localLlmModelTargetSchema, req.body)
  const result = cancelModelInstall(backend, modelId)
  if (!result.success) {
    throw new ServerError(result.error, { status: result.code === 'INSTALL_NOT_CANCELABLE' ? 409 : 404, code: result.code })
  }
  res.json(result)
}))

// POST /api/local-llm/upgrade-backend — upgrade an existing backend install
// (Homebrew on macOS, official script for Ollama on Linux). Streams progress
// over the same `localLlm:progress` socket event the install/pull paths use.
router.post('/upgrade-backend', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(localLlmInstallBackendSchema, req.body)
  const emit = emitter(req)
  // Abort an in-flight download when the client goes away before we respond.
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  const result = await upgradeBackend(backend, ({ event, message }) => emit(event, message), ac.signal)
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
    throw new ServerError(result.error || 'Switch failed', result.code === 'BACKEND_OVERRIDE_CONFLICT'
      ? { status: 409 }
      : { status: 502, code: 'INTERNAL_ERROR' })
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
    throw new ServerError(result.error || 'Migration failed', { status: 502 })
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
router.get('/loaded', asyncHandler(async (req, res) => {
  const { fresh } = validateRequest(localLlmLoadedQuerySchema, req.query)
  res.json(await loadedObservation.read({ fresh: fresh === '1' }));
}))

// POST /api/local-llm/unload — body: { backend: 'ollama', modelId }.
// Forces Ollama to evict the named model immediately (`keep_alive: 0`).
// LM Studio's unload lives at POST /api/lmstudio/unload — we don't proxy
// it here to keep each backend's quirks behind its own router.
router.post('/unload', asyncHandler(async (req, res) => {
  const { modelId } = validateRequest(localLlmUnloadSchema, req.body)
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

export default router
