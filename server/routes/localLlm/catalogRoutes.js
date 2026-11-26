import os from 'os'
import { Router } from 'express'
import { asyncHandler } from '../../lib/errorHandler.js'
import { validateRequest } from '../../lib/validateRequest.js'
import { localLlmCatalogQuerySchema, localLlmHuggingFaceSearchSchema } from '../../lib/mediaValidation.js'
import { MODEL_ABUSE_GUARD } from '../../lib/modelAbuseGuard.js'
import { JEV_MODEL } from '../../lib/jev.js'
import { getCatalog, searchCatalog } from '../../lib/localLlmCatalog.js'
import { isAppleSilicon } from '../../lib/platform.js'
import { captureSystemCapabilities, isHardwareCompatible, withHardwareCompatibility } from '../../lib/systemCapabilities.js'
import { searchHuggingFaceModels, enrichCatalogWithVariants, applyMeasuredFit } from '../../services/huggingFaceCatalog.js'
import { getMeasuredFits } from '../../services/localModelAssessmentStore.js'
import { listModels, listVisionModels, listToolUseModels, listContextPlans } from '../../services/localLlm.js'
import { listUserModels } from '../../services/audioModels.js'
import { ENGINES } from '../../services/pipeline/musicGen.js'

const router = Router()

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

export default router
