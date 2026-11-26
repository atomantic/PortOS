import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import { validateRequest } from '../lib/validateRequest.js'
import {
  localLlmLlamaServerStartSchema, localLlmMtplxStartSchema, localLlmSlotstreamStartSchema,
  managedInklingActionSchema, managedInklingCancelSchema, mkserveInstallSchema, splashContextSchema, localLlmSpecModelDownloadSchema,
  localLlmMtplxSearchSchema, localLlmMtplxPullSchema, localLlmMtplxRemoveSchema, localLlmSlotstreamDownloadSchema,
} from '../lib/mediaValidation.js'
import {
  getLlamaServerStatus,
  getLlamaServerUpdateStatus,
  startLlamaServer,
  stopLlamaServer,
  installLlamaServer,
  upgradeLlamaServer,
  waitForLlamaServerReady,
} from '../services/llamaServerManager.js'
import { onDemandRuntimeAppNames } from '../lib/managedRuntimeApps.js'
import { getMtplxServerStatus, startMtplxServer, stopMtplxServer, installMtplx, uninstallMtplx, waitForMtplxReady } from '../services/mtplxServerManager.js'
import { getSplashRuntimeStatus } from '../services/splashRuntimeStatus.js'
import { installSplashRuntime, saveSplashContextWindow, startSplashServer, stopSplashServer, uninstallSplashRuntime } from '../services/splashServerManager.js'
import { getMkserveRuntimeStatus, installMkserve, startMkserveServer, stopMkserveServer, uninstallMkserve } from '../services/mkserveRuntimeManager.js'
import { getSlotstreamServerStatus, startSlotstreamServer, stopSlotstreamServer, installSlotstream, uninstallSlotstream, waitForSlotstreamReady } from '../services/slotstreamServerManager.js'
import { cancelSlotstreamModelDownload, downloadSlotstreamModel } from '../services/slotstreamModelManager.js'
import { searchMtplxCatalog, pullMtplxModel, removeMtplxModel } from '../services/mtplxModelManager.js'
import { saveProcessList } from '../services/pm2.js'
import { getSpecDecodePresetStatus, downloadSpecDecodeModel, cancelSpecDecodeModelDownload, removeSpecDecodeModel } from '../services/specDecodeModels.js'
import { SPEC_TYPE_SUGGESTIONS } from '../lib/specDecodePresets.js'
import { resetProviderReadinessCache } from '../services/provider/providerReadiness.js'
import { syncRuntimeProviderModels } from '../services/localRuntimeProviderSync.js'
import { emitToOperatorsOn } from '../services/socketIo.js'
import { requestHasHostControl } from '../services/authGate.js'
import { localLlmProgress as emitter } from './localLlmProgress.js'

const router = Router()

// The adapters describe each runtime's capabilities. Literal registrations below
// keep the public paths visible to the source-derived API inventory.
const runtimeAdapters = {
  llama: {
    status: async (options) => {
      // Disk-only preset availability rides with status. Package metadata is
      // fetched separately so a slow version probe can't delay the controls.
      const [status, presets] = await Promise.all([getLlamaServerStatus(options), getSpecDecodePresetStatus()])
      return { ...status, presets, specTypes: SPEC_TYPE_SUGGESTIONS }
    },
    start: startLlamaServer,
    startSchema: localLlmLlamaServerStartSchema,
    waitForReady: waitForLlamaServerReady,
    stop: stopLlamaServer,
    install: installLlamaServer,
    installError: 'llama.cpp install failed',
  },
  mtplx: {
    label: 'MTPLX',
    status: getMtplxServerStatus,
    start: startMtplxServer,
    startSchema: localLlmMtplxStartSchema,
    waitForReady: waitForMtplxReady,
    stop: stopMtplxServer,
    install: installMtplx,
    uninstall: uninstallMtplx,
    installError: 'Install failed',
  },
  slotstream: {
    label: 'Slotstream',
    status: getSlotstreamServerStatus,
    start: startSlotstreamServer,
    startSchema: localLlmSlotstreamStartSchema,
    waitForReady: waitForSlotstreamReady,
    stop: stopSlotstreamServer,
    install: installSlotstream,
    uninstall: uninstallSlotstream,
    installError: 'Install failed',
  },
  splash: {
    label: 'Splash',
    background: true,
    status: getSplashRuntimeStatus,
    start: startSplashServer,
    stop: stopSplashServer,
    install: installSplashRuntime,
    upgrade: installSplashRuntime,
    uninstall: uninstallSplashRuntime,
  },
  mkserve: {
    label: 'mkserve',
    background: true,
    status: getMkserveRuntimeStatus,
    start: startMkserveServer,
    stop: stopMkserveServer,
    install: installMkserve,
    installSchema: mkserveInstallSchema,
    upgrade: installMkserve,
    uninstall: uninstallMkserve,
  },
}

// After a user-triggered start, checkpoint download or removal, bring the presets fronting that runtime up to date
// (what "Refresh Models" does by hand). Called after the response is sent and never awaited: it owns its rejections
// and must not delay or fail the lifecycle action. `started.online === false` means the start returned before the
// endpoint answered, so the refresh waits on `waitFor` first.
const refreshRuntimeModels = (req, kind, started = null, waitFor = null) => {
  const pending = started?.online === false && waitFor && started.endpoint
  void syncRuntimeProviderModels({
    kind,
    io: req.app.get('io'),
    waitForReady: pending ? () => waitFor(started.endpoint) : null,
  })
}

// A runtime summary is available to ordinary readers. Host logs can include
// local paths and are only collected for an operator.
const statusRoute = (runtime) => asyncHandler(async (req, res) => {
  const { status: readStatus, background } = runtimeAdapters[runtime]
  const status = await readStatus({ includeLogs: requestHasHostControl(req) })
  res.json(background ? {
    ...status, operation: bundleOperations.get(runtime)?.operation ?? null, lastError: bundleErrors.get(runtime) ?? null,
  } : status)
})

const startRoute = (runtime) => asyncHandler(async (req, res) => {
  const { label, start, startSchema, waitForReady } = runtimeAdapters[runtime]
  const options = validateRequest(startSchema, req.body)
  const emit = emitter(req)
  if (label) emit('start', `Starting ${label}…`)
  const launch = label ? { ...options, onProgress: (line) => emit('start', line) } : options
  const result = await start(launch).catch((err) => {
    if (label) emit('error', err.message)
    throw err
  })
  resetProviderReadinessCache()
  if (label) emit('complete', `${label} is running at ${result.endpoint}`)
  res.json(result)
  refreshRuntimeModels(req, runtime, result, waitForReady)
})

const stopRoute = (runtime) => asyncHandler(async (_req, res) => {
  const { stop } = runtimeAdapters[runtime]
  const result = await stop()
  if (result?.success === false) throw new ServerError(result.message || 'Could not stop runtime', { status: 409, code: result.code || 'EXTERNAL_PROCESS_RUNNING' })
  resetProviderReadinessCache()
  res.json(result)
})

const installRoute = (runtime) => asyncHandler(async (req, res) => {
  const { install, label, installError } = runtimeAdapters[runtime]
  const io = req.app.get('io')
  const emit = emitter(req)
  // llama.cpp forwards the full package-manager frame, including structured data.
  const onProgress = label ? ({ event, message }) => emit(event, message) : (frame) => emitToOperatorsOn(io, 'localLlm:progress', frame)
  const result = await install({ onProgress }).catch((err) => {
    emit('error', `${installError}: ${err.message}`)
    throw err
  })
  resetProviderReadinessCache()
  if (label) emit('complete', `${label} installed`)
  res.json(result)
})

const uninstallRoute = (runtime) => asyncHandler(async (_req, res) => {
  const result = await runtimeAdapters[runtime].uninstall()
  resetProviderReadinessCache()
  res.json(result)
})

// Downloads outlive a browser request. Keep progress and the last failure
// available from Status as well as the socket, so reopening the tab is safe.
const bundleOperations = new Map()
const bundleErrors = new Map()
const bundleActionRoute = (runtime, action) => asyncHandler(async (req, res) => {
  const { label, [action]: run, installSchema } = runtimeAdapters[runtime]
  const schema = action === 'install' && installSchema ? installSchema : managedInklingActionSchema
  const options = validateRequest(schema, req.body ?? {})
  if (bundleOperations.has(runtime)) {
    throw new ServerError(`${label} already has an operation in progress.`, { status: 409 })
  }
  const emit = emitter(req)
  const scope = { runtime }
  const controller = ['install', 'upgrade'].includes(action) ? new AbortController() : null
  const operation = { id: randomUUID(), action: options.repair ? 'repair' : action, message: '' }
  bundleErrors.delete(runtime)
  bundleOperations.set(runtime, { operation, controller })
  const report = (progress) => {
    const message = typeof progress === 'string' ? progress : progress?.message
    if (!message || controller?.signal.aborted || bundleOperations.get(runtime)?.operation !== operation) return
    operation.message = `${label}: ${message}`
    emit('progress', operation.message, { ...scope, operation: { ...operation } })
  }
  report({ install: 'Preparing installation', repair: 'Preparing repair', upgrade: 'Preparing update', start: 'Starting', stop: 'Stopping', uninstall: 'Removing runtime files' }[operation.action])
  res.status(202).json({ operation })
  void Promise.resolve().then(() => run({ ...options, onProgress: report, signal: controller?.signal })).then(
    () => {
      bundleOperations.delete(runtime)
      resetProviderReadinessCache()
      const done = { install: 'installation complete', repair: 'repair complete', upgrade: 'update complete', start: 'start completed', stop: 'stopped', uninstall: 'uninstalled' }[operation.action]
      emit('complete', `${label}: ${done}.`, { ...scope, operation: null, lastError: null })
      // Their start only resolves once the model answers, so no readiness wait.
      if (action === 'start') refreshRuntimeModels(req, runtime)
    },
    (err) => {
      bundleOperations.delete(runtime)
      resetProviderReadinessCache()
      if (controller?.signal.aborted && (err === controller.signal.reason || err?.name === 'AbortError')) {
        emit('cancelled', `${label}: ${operation.action === 'repair' ? 'Repair' : 'Installation'} cancelled.`, { ...scope, operation: null, lastError: null })
        return
      }
      const message = err instanceof ServerError ? (err.responseMessage || err.message) : 'Operation failed. See PortOS server logs for details.'
      if (!(err instanceof ServerError)) console.error(`❌ ${label} ${action} failed: ${err?.message ?? 'Unknown error'}`)
      bundleErrors.set(runtime, message)
      emit('error', `${label}: ${message}`, { ...scope, operation: null, lastError: message })
    },
  )
})

const bundleCancelRoute = (runtime) => asyncHandler(async (req, res) => {
  const { label } = runtimeAdapters[runtime]
  const { operationId } = validateRequest(managedInklingCancelSchema, req.body ?? {})
  const active = bundleOperations.get(runtime)
  if (!active?.controller || (operationId && active.operation.id !== operationId)) {
    return res.json({ cancelled: false })
  }
  const { controller, operation } = active
  if (!controller.signal.aborted) {
    controller.abort()
    operation.cancelling = true
    operation.message = `${label}: Cancelling ${operation.action === 'repair' ? 'repair' : 'installation'}…`
    emitter(req)('progress', operation.message, { runtime, operation: { ...operation } })
  }
  res.json({ cancelled: true, operation })
})

router.get('/llama-server/status', statusRoute('llama'))
router.post('/llama-server/start', startRoute('llama'))
router.post('/llama-server/stop', stopRoute('llama'))
router.post('/llama-server/install', installRoute('llama'))

router.get('/mtplx/status', statusRoute('mtplx'))
router.post('/mtplx/start', startRoute('mtplx'))
router.post('/mtplx/stop', stopRoute('mtplx'))
router.post('/mtplx/install', installRoute('mtplx'))
router.post('/mtplx/uninstall', uninstallRoute('mtplx'))

router.get('/slotstream/status', statusRoute('slotstream'))
router.post('/slotstream/start', startRoute('slotstream'))
router.post('/slotstream/stop', stopRoute('slotstream'))
router.post('/slotstream/install', installRoute('slotstream'))
router.post('/slotstream/uninstall', uninstallRoute('slotstream'))

router.get('/splash/status', statusRoute('splash'))
router.post('/splash/install', bundleActionRoute('splash', 'install'))
router.post('/splash/upgrade', bundleActionRoute('splash', 'upgrade'))
router.post('/splash/cancel', bundleCancelRoute('splash'))
router.post('/splash/start', bundleActionRoute('splash', 'start'))
router.post('/splash/stop', bundleActionRoute('splash', 'stop'))
router.post('/splash/uninstall', bundleActionRoute('splash', 'uninstall'))

router.get('/mkserve/status', statusRoute('mkserve'))
router.post('/mkserve/install', bundleActionRoute('mkserve', 'install'))
router.post('/mkserve/upgrade', bundleActionRoute('mkserve', 'upgrade'))
router.post('/mkserve/cancel', bundleCancelRoute('mkserve'))
router.post('/mkserve/start', bundleActionRoute('mkserve', 'start'))
router.post('/mkserve/stop', bundleActionRoute('mkserve', 'stop'))
router.post('/mkserve/uninstall', bundleActionRoute('mkserve', 'uninstall'))

router.put('/splash/context', asyncHandler(async (req, res) => {
  const { contextWindow } = validateRequest(splashContextSchema, req.body ?? {})
  if (bundleOperations.has('splash')) {
    throw new ServerError('Splash already has an operation in progress.', { status: 409 })
  }
  res.json(await saveSplashContextWindow(contextWindow))
}))

// GET /api/local-llm/llama-server/update-status — optional package-manager and
// version metadata for the Local LLMs page. Keep it out of the lifecycle status
// request: a slow `brew info` / `winget list` or a backend-initializing
// `--version` probe must not delay ordinary runtime status and preset rendering.
router.get('/llama-server/update-status', asyncHandler(async (_req, res) => {
  res.json(await getLlamaServerUpdateStatus())
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
    onProgress: (frame) => emitToOperatorsOn(io, 'llamaServer:download', frame),
  })
  res.json(result)
}))

// POST /api/local-llm/llama-server/download-model/cancel — a download is
// server-owned so it survives navigation, but must still be explicitly
// stoppable to release its single transfer slot and remove its partial file.
router.post('/llama-server/download-model/cancel', asyncHandler(async (req, res) => {
  const { presetId, role } = validateRequest(localLlmSpecModelDownloadSchema, req.body)
  const cancelled = cancelSpecDecodeModelDownload({ presetId, role })
  res.json({ success: true, cancelled })
}))

// POST /api/local-llm/llama-server/download-model/remove — delete an already
// downloaded preset GGUF to free disk space for a method the user has decided
// not to use. removeSpecDecodeModel refuses on its own while llama-server is
// running that exact file, so unloading can't unlink weights out from under
// an active launch.
router.post('/llama-server/download-model/remove', asyncHandler(async (req, res) => {
  const { presetId, role } = validateRequest(localLlmSpecModelDownloadSchema, req.body)
  const result = await removeSpecDecodeModel({ presetId, role })
  res.json(result)
}))

// POST /api/local-llm/llama-server/upgrade — update a package-manager-installed
// llama.cpp binary, restarting a llama-server process PortOS owns with the same
// launch configuration. An externally-started process is left alone.
router.post('/llama-server/upgrade', asyncHandler(async (req, res) => {
  const io = req.app.get('io')
  const onProgress = (data) => emitToOperatorsOn(io, 'localLlm:progress', data)
  const result = await upgradeLlamaServer({ onProgress }).catch((err) => {
    onProgress({ event: 'error', message: `llama.cpp update failed: ${err.message}` })
    throw err
  })
  resetProviderReadinessCache()
  if (!result.success) {
    onProgress({ event: 'error', message: result.error || 'llama.cpp update failed' })
    throw new ServerError(result.error || 'llama.cpp update failed', { status: 502 })
  }
  onProgress({ event: 'complete', message: `llama.cpp updated${result.note ? ` — ${result.note}` : ''}` })
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
  const result = await pullMtplxModel({ model, onProgress: (frame) => emitToOperatorsOn(io, 'mtplx:download', frame) })
  if (!result.success) {
    throw new ServerError(result.error || 'MTPLX checkpoint pull failed', { status: 502, code: 'MTPLX_PULL_FAILED' })
  }
  // A cache that just went from empty to servable is exactly what the readiness
  // probes remember as "MTPLX setup incomplete".
  resetProviderReadinessCache()
  res.json(result)
  refreshRuntimeModels(req, 'mtplx')
}))

// POST /api/local-llm/mtplx/models/remove — delete one checkpoint from the cache
router.post('/mtplx/models/remove', asyncHandler(async (req, res) => {
  const { model } = validateRequest(localLlmMtplxRemoveSchema, req.body)
  const result = await removeMtplxModel(model)
  resetProviderReadinessCache()
  res.json(result)
  refreshRuntimeModels(req, 'mtplx')
}))

// POST /api/local-llm/slotstream/models/download — fetch one checkpoint into
// Slotstream's cache. Byte progress streams over `slotstream:download`, which
// is what the card's bar trusts: a 100 GB+ transfer outlives the request that
// started it, so a terminal frame — not the HTTP response — is what clears the
// bar and re-reads the cache. A start still never downloads anything; this is
// the explicit, separate action that does.
router.post('/slotstream/models/download', asyncHandler(async (req, res) => {
  const { model } = validateRequest(localLlmSlotstreamDownloadSchema, req.body)
  const io = req.app.get('io')
  const result = await downloadSlotstreamModel({ model, onProgress: (frame) => emitToOperatorsOn(io, 'slotstream:download', frame) })
  if (result.cancelled === true) {
    return res.json({ success: false, cancelled: true, model: result.model })
  }
  if (!result.success) {
    throw new ServerError(result.error || 'Slotstream checkpoint download failed', {
      status: result.status || 502,
      code: result.code || 'SLOTSTREAM_DOWNLOAD_FAILED',
    })
  }
  // A cache that just went from empty to servable is exactly what the readiness
  // probes remember as "Slotstream has no checkpoint".
  resetProviderReadinessCache()
  res.json(result)
  refreshRuntimeModels(req, 'slotstream')
}))

// POST /api/local-llm/slotstream/models/download/cancel — a checkpoint download
// is server-owned so it survives navigation, but a 100 GB+ transfer that is
// merely SLOW never trips the idle watchdog, and waiting one out is the only
// other way to release the single transfer slot. Partial files are kept, so a
// later download resumes rather than restarting.
router.post('/slotstream/models/download/cancel', asyncHandler(async (req, res) => {
  const { model } = validateRequest(localLlmSlotstreamDownloadSchema, req.body)
  res.json({ success: true, cancelled: cancelSlotstreamModelDownload({ model }) })
}))

// POST /api/local-llm/save-startup — `pm2 save`, so the PM2-managed local
// runtime servers currently running (llama-server, PortOS itself) are in the
// dump a boot-time `pm2 resurrect` replays. The privileged half — `pm2
// startup`, which writes the launchd/systemd unit — is deliberately blocked and
// stays a one-time operator command.
//
// Exclude runtimes that need not pin their checkpoints at boot. MTPLX and
// Slotstream can start on demand; Splash and mkserve start from their controls.
// The running processes are left alone; only this saved boot list changes.
router.post('/save-startup', asyncHandler(async (_req, res) => {
  res.json(await saveProcessList(null, { exclude: onDemandRuntimeAppNames() }))
}))

export default router
