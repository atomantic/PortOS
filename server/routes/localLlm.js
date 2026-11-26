import { loadedObservation } from '../services/localModelObservations.js';
import { observeModelMutations } from '../services/modelObservation.js';
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
import { jevPolicyPatchSchema, resolveUntrustedContentPolicy } from '../lib/untrustedContent.js'
import { readSettingsStrict, updateSettingsWith } from '../services/settings.js'
import { Router } from 'express'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import { validateRequest } from '../lib/validateRequest.js'
import {
  localLlmInstallSchema,
  localLlmModelTargetSchema,
  localLlmCatalogQuerySchema,
  localLlmLoadedQuerySchema,
  manualGuardScanSchema,
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
  localLlmAssessmentBenchmarkSchema,
  localLlmCapabilityTestSchema,
  localLlmCapabilityTestRunSchema,
  localLlmCapabilityTestDeleteSchema,
  localLlmLmStudioServiceSchema,
  localLlmDownloadPreflightSchema,
  localPersistentMindSetupApplySchema,
} from '../lib/mediaValidation.js'
import localLlmRuntimes from './localLlmRuntimes.js'
import { localLlmProgress as emitter } from './localLlmProgress.js'
import { previewSlotstreamDownload } from '../services/slotstreamModelManager.js'
import { previewMtplxPull } from '../services/mtplxModelManager.js'
import { previewSpecDecodeDownload } from '../services/specDecodeModels.js'
import { resetProviderReadinessCache } from '../services/provider/providerReadiness.js'
import { MODEL_ABUSE_GUARD } from '../lib/modelAbuseGuard.js'
import { JEV_MODEL, jevDecideRequestSchema } from '../lib/jev.js'
import { jevHeadActionRequestSchema, jevHeadTrainRequestSchema } from '../lib/jevHead.js'
import { getCatalog, searchCatalog } from '../lib/localLlmCatalog.js'
import { isAppleSilicon } from '../lib/platform.js'
import {
  captureSystemCapabilities,
  isHardwareCompatible,
  withHardwareCompatibility,
} from '../lib/systemCapabilities.js'
import { searchHuggingFaceModels, enrichCatalogWithVariants, applyMeasuredFit } from '../services/huggingFaceCatalog.js'
import { getMeasuredFits } from '../services/localModelAssessmentStore.js'
import { listEndpointRuntimeModels } from '../services/localRuntimeEndpoints.js'
import {
  getStatus, listModels, listVisionModels, listToolUseModels, listContextPlans, installModel, cancelModelInstall, previewInstallModel, deleteModel, switchBackend, migrateBackend, installBackend, upgradeBackend, controlOllamaServer,
  describeInstallProgress
} from '../services/localLlm.js'
import { getModelAbuseGuardStatus, installModelAbuseGuard, cancelModelAbuseGuardInstall, runModelAbuseScan } from '../services/modelAbuseGuard.js'
import { cancelJevInstall, decide, getJevStatus, installJev, stopJevSidecar } from '../services/jev.js'
import { readJevDecisionStats } from '../services/jevRouter.js'
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js'
import { getAssessmentReport, runAssessment, deleteAssessment } from '../services/localModelAssessments.js'
import { startSweep, getSweepStatus, cancelSweep } from '../services/localModelAssessmentSweep.js'
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js'
import { getCapabilityTestReport, getCapabilityTestResult, runCapabilityTest } from '../services/modelCapabilityTests.js'
import { deleteResult as deleteCapabilityTestResult } from '../services/modelCapabilityTestStore.js'
import { listUserModels } from '../services/audioModels.js'
import {
  describeLocalPersistentMindSetup,
  applyLocalPersistentMindSetup,
} from '../services/localPersistentMindSetup.js'
import { ENGINES } from '../services/pipeline/musicGen.js'
import { abortSignalFromResponse } from '../lib/requestAbort.js'
import { awaitWritableDrain } from '../lib/streamBackpressure.js'
import {
  unloadModel as unloadOllamaModel,
} from '../services/ollamaManager.js'
import {
  controlLmStudioServer,
} from '../services/lmStudioManager.js'

// The head store and the trainer are DEFERRED into their handlers, not
// imported at module scope: `jevTraining.js` reaches the sidecar lifecycle, the
// pinned model contract and the corpus builder's forge stack, and this route
// module sits in the static closure of a great many suites
// (`server/lib/importScoping.test.js`). Four endpoints nobody calls by default
// must not make every one of them pay for that subtree.
const jevHeadStore = () => import('../services/jevHeads.js')
const jevTrainer = () => import('../services/jevTraining.js')

const router = Router()
router.use(observeModelMutations('loaded-models', 'provider-readiness'));
const layaService = () => import('../services/layaMlx.js')

const layaFailureStatuses = new Map([
  ['laya-request-invalid', 400],
  ['laya-unsupported', 400],
  ['laya-context-too-long', 400],
  ['laya-disabled', 403],
  ['laya-busy', 409],
  ['laya-not-ready', 503],
])

router.get('/laya-mlx/status', asyncHandler(async (_req, res) => {
  res.json(await (await layaService()).getLayaStatus())
}))
router.post('/laya-mlx/install', asyncHandler(async (_req, res) => {
  const result = await (await layaService()).installLaya()
  if (result?.ok !== true) {
    const code = result?.code || 'laya-install-failed'
    const status = layaFailureStatuses.get(code) ?? 502
    throw new ServerError('Laya-MLX could not start installation.', { status, code })
  }
  res.status(202).json(result)
}))
router.post('/laya-mlx/score', asyncHandler(async (req, res) => {
  const { layaScoreRequestSchema } = await import('../lib/layaMlx.js')
  const input = validateRequest(layaScoreRequestSchema, req.body)
  const result = await (await layaService()).scoreLaya(input, abortSignalFromResponse(res))
  if (!result?.ok) {
    const code = result?.code || 'laya-scoring-failed'
    const status = layaFailureStatuses.get(code) ?? 502
    throw new ServerError('Laya-MLX could not score the request.', { status, code })
  }
  res.json(result)
}))

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

// GET /api/local-llm/vision-models — vision-capable installed models across
// both backends, tagged with the provider id that serves them. Powers the
// LoRA caption-model picker.
router.get('/vision-models', asyncHandler(async (_req, res) => {
  res.json({ models: await listVisionModels() })
}))

// GET /api/local-llm/context-plans — per installed Ollama model: KV-cache size at each
// window step under the daemon's cache type, what fits this host, and the recommended window.
router.get('/context-plans', asyncHandler(async (_req, res) => {
  res.json(await listContextPlans())
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
// Scalars only: a repeated key (`?backend=a&backend=b`) is a 400, while `backend` itself keeps its own check below.

router.get('/catalog', asyncHandler(async (req, res) => {
  const { backend, q, variants } = validateRequest(localLlmCatalogQuerySchema, req.query)
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
  // Total system memory drives both the hardware gate and the RAM-aware
  // recommended quant. Unified memory on Apple Silicon also backs the GPU, so a
  // big box can default to higher fidelity.
  const systemMemoryBytes = os.totalmem()
  const capabilities = captureSystemCapabilities({
    appleSilicon: isAppleSilicon(),
    totalMemoryBytes: systemMemoryBytes,
  })
  // Native MLX entries are meaningful only on Apple Silicon. Keep this gate at
  // the route boundary so the pure catalog remains useful to tests and other
  // callers while the user-facing picker never offers an un-runnable format.
  const catalogOptions = { appleSilicon: capabilities.appleSilicon }
  const catalog = q
    ? searchCatalog(backend, q, installedRaw, catalogOptions)
    : getCatalog(backend, installedRaw, catalogOptions)
  // Keep the full compatibility fact on each visible row for callers that want
  // to explain a recommendation, but hide only definitive mismatches. Unknown
  // memory/probe states remain visible and fail open.
  const models = catalog
    .map((model) => withHardwareCompatibility(model, capabilities, model.hardwareRequirements))
    .filter((model) => isHardwareCompatible(model.hardwareCompatibility))
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
  res.json({
    backend,
    models,
    // Prompt Guard is a managed classifier, not a chat model. Keep it beside
    // the catalog response so the UI can highlight the safety recommendation
    // without making it selectable in any normal provider/model picker.
    securityGuards: [MODEL_ABUSE_GUARD],
    // Same guarantee, separate key: jev is a managed entailment scorer, not a
    // chat model. Neither descriptor is ever merged into `models`, so no
    // provider/model picker can offer either one.
    decisionScorers: [JEV_MODEL],
    systemMemoryGb: Math.round(systemMemoryBytes / 1024 ** 3),
  })
}))

// The model-abuse guard has its own lifecycle: it is a pinned, offline
// classifier and must never be installed through the general chat-model path.
// `ready` covers only the Prompt Guard classifier. GitHub contribution
// assessment also needs a provider and model, reported separately so a green
// guard cannot hide a coordinator that can never assess a pull request.
router.get('/security-guard/status', asyncHandler(async (_req, res) => {
  const { getContributionAssessmentReadiness } = await import('../services/untrustedContent.js')
  const [status, contributionAssessment] = await Promise.all([
    getModelAbuseGuardStatus(),
    getContributionAssessmentReadiness(),
  ])
  res.json({ ...status, contributionAssessment })
}))

// Explicit operator action: the default host-control write gate applies. This
// runs only the local abuse scan, not a GitHub contribution assessment.
router.post('/security-guard/scan', asyncHandler(async (req, res) => {
  const { content } = validateRequest(manualGuardScanSchema, req.body ?? {})
  const result = await runModelAbuseScan({ content })
  if (result?.ok !== true || typeof result.safe !== 'boolean') throw new ServerError('The abuse guard could not complete the scan. Check its setup and try again.', { status: 503, code: result?.code || 'security-guard-scan-failed' })
  res.json({ safe: result.safe, code: result.code, layers: result.layers, findings: result.findings || [] })
}))

router.post('/security-guard/install', asyncHandler(async (req, res) => {
  const emit = emitter(req)
  const result = await installModelAbuseGuard({
    onEvent: ({ event, message, stage }) => emit(event, message, { scope: 'security-guard', stage }),
  })
  if (!result?.ok) {
    const code = result?.code || 'security-guard-install-failed'
    const message = code === 'security-guard-huggingface-token-required'
      ? 'Add a Hugging Face read token before installing Prompt Guard.'
      : code === 'security-guard-huggingface-access-required'
        ? 'Hugging Face has not granted Prompt Guard access yet. Submit the usage request on its model card, then retry.'
        : code === 'security-guard-python-unavailable'
          ? 'Install Python 3.10 or newer on this machine, restart PortOS if needed to detect it, then refresh Abuse Guard status.'
          : code === 'security-guard-self-test-failed'
            ? 'Prompt Guard could not complete its local verification. Repair the dedicated runtime from Models > LLMs > Abuse Guard before retrying.'
            : code === 'security-guard-runtime-install-failed'
              ? 'Classifier package installation failed. Check internet access and Python compatibility, then retry from Models > LLMs > Abuse Guard.'
        : code
    const detail = result?.diagnostic
    const actionableMessage = detail ? `${message} ${detail.message} ${detail.action}` : message
    emit('error', actionableMessage, { scope: 'security-guard', stage: detail?.stage })
    throw new ServerError(actionableMessage, { status: 502, code })
  }
  res.json(result)
}))

router.post('/security-guard/install/cancel', asyncHandler(async (_req, res) => {
  cancelModelAbuseGuardInstall()
  res.json({ cancelled: true })
}))

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

// POST /api/local-llm/test/stream — run one installed local model with a prompt and
// stream the model's output token-by-token as newline-delimited JSON (NDJSON) so the playground
// can render live. Frames: `{ type: 'token', delta, kind }` per chunk (kind is
// 'content' or 'reasoning' so the client can render thinking separately), then a
// terminal `{ type: 'result', result }` carrying the run object
// (text, speed metrics, runId, and any error). `runLocalLlmTest` resolves rather than
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

// GET /api/local-llm/runtime-models — the models each bare-endpoint runtime (llama.cpp, MTPLX,
// Splash, ...) serves, for the Playground picker. Lists only; never generates, so it is safe on page load.
router.get('/runtime-models', asyncHandler(async (_req, res) => {
  res.json({ runtimes: await listEndpointRuntimeModels() })
}))

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
    onChange: (state) => io?.emit('localLlm:sweep:changed', state),
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
    onProgress: (frame) => io?.emit('localLlm:progress', frame),
    onChange: (state) => io?.emit('localLlm:sweep:changed', state),
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

router.use(localLlmRuntimes)

export default router
