/**
 * Local LLM orchestration — unifies the Ollama and LM Studio backends behind
 * one shape so the UI can list / search / install / delete models, move models
 * between backends, and pick the default backend. Both can be installed and
 * running at the same time; the "default" is just which one PortOS routes local
 * runs to.
 *
 * These two are the backends PortOS keeps a MODEL CATALOG for. They are not the
 * only local servers it runs: `llamaServerManager.js` and `mtplxServerManager.js`
 * own the two PM2-managed daemons (llama.cpp, MTPLX), and the LLMs page's
 * "Local Runtime Servers" card starts and stops all four through one surface.
 *
 * The default backend is recorded in `.env` as `LLM_BACKEND` (parallel to
 * `PGMODE`), so it survives restarts and is readable by the setup script. The
 * matching aiToolkit provider (`ollama` / `lmstudio`) is enabled whenever a
 * backend becomes the default (each provider stays independently enabled — we
 * never disable the other, so both remain usable concurrently).
 *
 * Cross-backend GGUF migration is implemented in localLlmMigration.js.
 */

import { emitToOperatorsOn } from './socketIo.js';
import { localBackendForProvider } from '../lib/modelPinMembership.js'
import { isLocalInstanceHost } from '../lib/localEndpoint.js'
import { localModelSafety } from '../lib/localModelSafety.js';
import { execFile } from '../lib/childProcess.js'
import { promisify } from 'util'
import { readPortosEnvValue, upsertPortosEnvLine } from '../lib/portosEnv.js'
import { ServerError } from '../lib/errorHandler.js'
import { assessDownloadPreflight, diskInsufficientError, DOWNLOAD_VERDICTS } from '../lib/downloadPreflight.js'
import { compareSemver } from '../lib/versionUtils.js'
import { getCatalog, isBackend, getOllamaImportSpec, catalogSizeBytes } from '../lib/localLlmCatalog.js'
import { LOCAL_LLM_PROVIDER_ID_BY_BACKEND } from '../lib/localLlmCapabilityBackends.js'
import { recommendEditorialModel, isVisionModel, isVisionCapableCliProvider, isToolUseModel } from '../lib/localModelHeuristics.js'
import { captureSystemCapabilities, withHardwareCompatibility } from '../lib/systemCapabilities.js'
// Disk-only read of the measured assessments (`localModelAssessmentStore.js` has no
// path to a provider, so this cannot turn a status poll into an LLM call), and
// no import cycle: the store deliberately does not import this module.
import { getMeasuredFits } from './localModelAssessmentStore.js'
import { commandExists } from '../lib/commandExists.js'
import * as ollamaManager from './ollamaManager.js'
import * as lmStudioManager from './lmStudioManager.js'
import { localModelInventoryRow } from '../lib/modelInventory.js'
import { recordModelInstall, recordModelUninstall } from './modelManifest.js'
import { getProviderById, getAllProviders, updateProvider, refreshProviderModelsBatch } from './provider/providers.js'
import { resolveModelFetcher } from '../lib/aiToolkit/internal/modelFetchers.js'
import { ollamaBaseFromProvider } from '../lib/aiToolkit/internal/ollamaBacked.js'
import { createSingleFlight } from '../lib/singleFlight.js'
import { getSettings } from './settings.js'
import { canAutoInstall, canAutoUpgrade, DOWNLOAD_URL, resolveLatestOllamaVersion } from './localLlmBackendInstall.js'
import { migrateLocalModels } from './localLlmMigration.js'

export { getLatestOllamaVersion, installBackend, upgradeBackend } from './localLlmBackendInstall.js'

const execFileAsync = promisify(execFile)
const DEFAULT_BACKEND = 'ollama'

// `lms get` blocks until the download finishes — generous but finite so a
// stalled connection (or an unexpected interactive prompt) can't hang the
// request forever. Large models on a slow link still fit comfortably.
const LMS_INSTALL_TIMEOUT_MS = 60 * 60 * 1000

// ---- active-backend marker (.env LLM_BACKEND) --------------------------------

/**
 * The active local-LLM backend, read fresh from `.env` each call.
 *
 * **Precedence (settled in `server/lib/portosEnv.js`):** an exported
 * `process.env` value is this run's decision and wins; the `.env` record is
 * durable memory and loses. Validate each source before falling through.
 */
export function getBackend() {
  const fromEnv = process.env.LLM_BACKEND
  if (isBackend(fromEnv)) return fromEnv
  const fromFile = readPortosEnvValue('LLM_BACKEND')
  if (isBackend(fromFile)) return fromFile
  return DEFAULT_BACKEND
}

async function writeBackend(backend) {
  await upsertPortosEnvLine('LLM_BACKEND', backend)
}

/**
 * Enable the aiToolkit provider that pairs with `backend`, so the active local
 * backend is actually usable for runs. Best-effort: a misconfigured provider
 * store must not crash a boot-time or migrate call.
 */
export async function ensureBackendProvider(backend) {
  const id = LOCAL_LLM_PROVIDER_ID_BY_BACKEND[backend]
  if (!id) return
  const provider = await getProviderById(id).catch(() => null)
  if (!provider) return

  const patch = {}
  if (!provider.enabled) patch.enabled = true
  // Ollama's OpenAI-compatible endpoint silently truncates to a ~4K context
  // window unless a per-request num_ctx is sent. Editorial passes feed the
  // whole manuscript (tens of thousands of tokens), so default a generous
  // window (override with OLLAMA_NUM_CTX). LM Studio sets context at model
  // load, so this only applies to Ollama.
  if (backend === 'ollama' && !(Number(provider.numCtx) > 0)) {
    patch.numCtx = Number(process.env.OLLAMA_NUM_CTX) || 32768
  }
  if (Object.keys(patch).length === 0) return

  const ok = await updateProvider(id, patch)
    .then(() => true)
    .catch((err) => {
      console.error(`⚠️ Failed to configure ${id} provider: ${err.message}`)
      return false
    })
  if (ok) console.log(`🔌 Configured ${id} provider for local LLM backend (${Object.keys(patch).join(', ')})`)
}

const manager = (backend) => (backend === 'ollama' ? ollamaManager : lmStudioManager)

/**
 * Start/stop the Ollama HTTP server from the UI. LM Studio is app-controlled,
 * so keep this intentionally narrow instead of inventing unreliable app-launch
 * behavior for every platform.
 */
export async function controlOllamaServer(action) {
  if (action === 'start') return ollamaManager.startServer()
  if (action === 'stop') return ollamaManager.stopServer()
  if (action === 'enable') return ollamaManager.startPersistentService()
  if (action === 'disable') return ollamaManager.stopPersistentService()
  return { success: false, error: `Unknown Ollama action: ${action}` }
}

// Ollama's /api/show reports capabilities in its own vocabulary
// (completion/tools/vision/embedding/thinking/insert). Map the ones that have
// a home onto the badge vocabulary the Models catalog cards already render
// (CAPABILITY_META in LocalLlmTab.jsx: chat/code/reasoning/vision/embeddings/
// tools/audio) so installed models can show the same icons. Only capabilities
// the daemon actually reported are surfaced — nothing is guessed here.
const OLLAMA_CAPABILITY_BADGES = {
  completion: 'chat',
  tools: 'tools',
  vision: 'vision',
  embedding: 'embeddings',
  thinking: 'reasoning'
}

/**
 * Ollama's reported capabilities → the badge vocabulary.
 *
 * `null` for a NON-ARRAY input, which is what `/api/tags` gives: that listing
 * carries no capability flags at all, so nothing was reported and nothing is
 * known. Returning `[]` there would collapse "not probed" into "claims
 * nothing" — the sentinel mistake root AGENTS.md forbids — which rendered an
 * empty badge row on the install catalog and made every capability test look
 * inapplicable. `/api/show` is what actually knows; an EMPTY array from it is a
 * real answer and stays `[]`.
 */
export function ollamaBadgeCapabilities(rawCapabilities) {
  if (!Array.isArray(rawCapabilities)) return null
  return rawCapabilities
    .map((c) => OLLAMA_CAPABILITY_BADGES[String(c).toLowerCase()])
    .filter(Boolean)
}

// LM Studio's native model list tags each model's `type` (`llm` / `vlm` /
// `embeddings`) — authoritative for chat/vision/embeddings. It reports no
// tool-calling flag, so fall back to the shared id heuristic for `tools`.
function lmStudioBadgeCapabilities(m) {
  const type = m?.type ? String(m.type).toLowerCase() : null
  const caps = type === 'embeddings' ? ['embeddings'] : ['chat']
  if (type === 'vlm') caps.push('vision')
  if (type !== 'embeddings' && isToolUseModel(m?.id)) caps.push('tools')
  return caps
}

/**
 * Add catalog-derived hardware metadata to a live model when PortOS knows its
 * identity. Unknown/custom models stay fail-open with an empty requirement set.
 */
function annotateInstalledModel(backend, rawModel, normalizedModel, capabilities) {
  const catalogEntry = getCatalog(backend, [rawModel.id]).find((entry) => entry.installed)
  return withHardwareCompatibility(
    { ...normalizedModel, ...localModelSafety(catalogEntry?.repository || rawModel.id) },
    capabilities,
    catalogEntry?.hardwareRequirements || rawModel.hardwareRequirements,
  )
}

/** Normalize each backend's installed-model shape into one card shape. */
function normalizeModels(backend, models, capabilities = captureSystemCapabilities()) {
  if (backend === 'ollama') {
    return models.map((m) => annotateInstalledModel(backend, m, {
        id: m.id, name: m.name, size: m.size ?? null,
        params: m.params || null, quantization: m.quantization || null, family: m.family || null,
        contextLength: m.contextLength ?? null,
        // Ollama's /api/tags doesn't tag vision capability, but /api/show does —
        // when the model has been enriched with a `capabilities` array (status
        // path, or the listVisionModels enrichment below) prefer it; otherwise
        // fall back to the id heuristic. Passing the object lets a vision-capable
        // MoE like `qwen3.6:35b` (no `vl`/`vision` token in its id) resolve true.
        vision: isVisionModel(Array.isArray(m.capabilities) ? { id: m.id, capabilities: m.capabilities } : m.id),
        capabilities: ollamaBadgeCapabilities(m.capabilities)
      }, capabilities))
  }
  return models.map((m) => annotateInstalledModel(backend, m, {
      id: m.id, name: m.id, size: null,
      params: null, quantization: m.quantization || null, family: m.arch || null,
      contextLength: m.maxContextLength ?? null,
      // LM Studio's native model list tags vision models `type: 'vlm'` — prefer
      // that over the id regex.
      vision: isVisionModel(m),
      capabilities: lmStudioBadgeCapabilities(m)
    }, capabilities))
}

/**
 * Installed models for a backend, normalized.
 * @param {boolean} [forceRefresh] - bypass the Ollama installed-models cache.
 *   Default false so the catalog-overlay path (hit on every debounced keystroke)
 *   reuses the cache instead of spamming `/api/tags`. The cache is busted on
 *   pull/delete, so it stays accurate; force only for explicit refresh/migrate.
 */
export async function listModels(backend, forceRefresh = false) {
  if (!isBackend(backend)) return []
  const raw = backend === 'ollama'
    ? await ollamaManager.getInstalledModels(forceRefresh)
    : await lmStudioManager.getAvailableModels(forceRefresh)
  return normalizeModels(backend, raw)
}

/**
 * `listModels` plus the sentinel that tells "no models installed" apart from
 * "the list could not be read".
 *
 * Both managers cache an EMPTY array on a failed read rather than throwing, so
 * `[]` alone is ambiguous — and collapsing an unreadable list into "this
 * backend has no models" is exactly the failure the sentinel rule in AGENTS.md
 * forbids. **`error` is the authoritative signal, not `models`**: a failed read
 * comes back as `{ models: [], error: '<why>' }`, because that empty array is
 * genuinely what the manager is holding. A caller that must not treat a
 * transient daemon outage as an empty catalog checks `error` first and falls
 * back to whatever it had before.
 *
 * @param {string} backend - 'ollama' | 'lmstudio'
 * @returns {Promise<{ models: Array|null, error: string|null }>} A non-null
 *   `error` means the listing was not readable, whatever `models` holds;
 *   `models: null` additionally means there was no list to hold at all (the
 *   call threw, or the backend name is unknown).
 */
export async function listManagedBackendModels(backend, forceRefresh = false) {
  if (!isBackend(backend)) return { models: null, error: `unknown backend '${backend}'` }
  const models = await listModels(backend, forceRefresh).catch((err) => ({ error: err?.message || 'model list failed' }))
  if (!Array.isArray(models)) return { models: null, error: models.error }
  let error = backend === 'ollama'
    ? ollamaManager.getLastInstalledModelsError()
    : lmStudioManager.getLastListError()
  if (backend === 'lmstudio' && !error) {
    const status = await lmStudioManager.getStatus().catch(() => null)
    if (!status?.available) {
      error = status?.lastError || 'LM Studio is unavailable'
    }
  }
  return { models, error: error || null }
}

/**
 * Combined status for both backends plus the active marker.
 */
export async function getStatus() {
  const [ollamaStatus, ollamaCli, lmStudioStatus, lmsCli, lmStudioModels, latestOllama, settings, measuredOllama, measuredLmStudio] = await Promise.all([
    ollamaManager.getStatus(true),
    commandExists('ollama', ['--version']),
    lmStudioManager.getStatus(),
    commandExists('lms', ['version']),
    // forceRefresh: status/refresh path bypasses the list cache.
    listModels('lmstudio', true).catch(() => []),
    resolveLatestOllamaVersion(),
    getSettings(),
    // Measured evidence, so the editorial pick can prefer a model that PROVABLY
    // runs here over one whose name merely looks right. Disk-only; a status poll
    // must never trigger a measurement.
    getMeasuredFits('ollama').catch(() => ({})),
    getMeasuredFits('lmstudio').catch(() => ({}))
  ])

  const ollamaModels = normalizeModels('ollama', ollamaStatus.models)
  const lmStudioRecommendation = recommendEditorialModel(lmStudioModels, { measured: measuredLmStudio })
  // An update is "available" only when we know BOTH the installed version (Ollama
  // must be running for /api/version to answer) and the newest its updater can
  // install, and that is newer. canUpgrade (canAutoUpgrade) gates the in-app updater to the platforms
  // where upgradeBackend can actually drive an Ollama upgrade.
  const { latestVersion: latestOllamaVersion, latestVersionSource, upstreamAheadVersion, installChannel } = latestOllama
  const ollamaUpdateAvailable = Boolean(
    ollamaStatus.version && latestOllamaVersion && compareSemver(latestOllamaVersion, ollamaStatus.version) > 0
  )
  return {
    backend: getBackend(),
    installs: listActiveInstalls(),
    ollama: {
      disabled: Boolean(settings.localLlm?.ollama?.disabled),
      installed: ollamaCli || ollamaStatus.available,
      available: ollamaStatus.available,
      version: ollamaStatus.version,
      latestVersion: latestOllamaVersion,
      latestVersionSource,
      upstreamAheadVersion,
      // Kind and name only, never the resolved path.
      installChannel,
      updateAvailable: ollamaUpdateAvailable,
      canUpgrade: canAutoUpgrade('ollama'),
      baseUrl: ollamaStatus.baseUrl,
      modelCount: ollamaStatus.modelCount,
      models: ollamaModels,
      contextLength: ollamaStatus.contextLength,
      modelsError: ollamaManager.getLastInstalledModelsError(),
      // Best installed model for editorial review/editing, surfaced so the
      // manuscript editor can suggest it (and warn against the embedding model).
      recommendations: { editorial: recommendEditorialModel(ollamaModels, { measured: measuredOllama }) },
      canControl: ollamaCli || ollamaStatus.available,
      service: ollamaStatus.service,
      canAutoInstall: canAutoInstall('ollama'),
      downloadUrl: DOWNLOAD_URL.ollama
    },
    lmstudio: {
      disabled: Boolean(settings.localLlm?.lmstudio?.disabled),
      // macOS app bundle counts as installed even with no CLI / server stopped.
      installed: lmsCli || lmStudioStatus.available || lmStudioManager.isAppInstalled(),
      available: lmStudioStatus.available,
      hasCli: lmsCli,
      baseUrl: lmStudioStatus.baseUrl,
      modelCount: lmStudioModels.length,
      models: lmStudioModels,
      recommendations: { editorial: lmStudioRecommendation },
      // Non-null when LM Studio answered the availability probe but the model
      // list call failed — lets the UI tell "0 models" from "couldn't list".
      modelsError: lmStudioManager.getLastListError(),
      canAutoInstall: canAutoInstall('lmstudio'),
      downloadUrl: DOWNLOAD_URL.lmstudio
    }
  }
}

// Compare the actual configured transports before using a manager's inventory.
// Provider ids/names alone do not identify a daemon (they can target a peer).
function modelEndpointIdentity(endpoint) {
  if (!URL.canParse(endpoint)) return null
  const url = new URL(endpoint)
  const host = isLocalInstanceHost(url.hostname) ? 'loopback' : url.hostname
  return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}${url.search}`
}

function providerUsesBackend(provider, backend) {
  const baseUrl = backend === 'ollama' ? ollamaManager.getBaseUrl() : lmStudioManager.getBaseUrl()
  const identity = modelEndpointIdentity(provider?.endpoint)
  return provider?.type === 'api' && identity !== null && identity === modelEndpointIdentity(baseUrl)
}

async function listVisionBackendModels(backend) {
  const provider = await getProviderById(LOCAL_LLM_PROVIDER_ID_BY_BACKEND[backend]).catch(() => null)
  if (!providerUsesBackend(provider, backend)) return []
  return listModels(backend).catch(() => [])
}

/**
 * Vision-capable installed models across both local backends, tagged with the
 * aiToolkit provider id (`ollama` / `lmstudio`) that serves them, PLUS
 * vision-capable CLI providers (codex / claude-code) whose model reads images
 * via a file. Powers the caption-model picker and the captioner's
 * auto-resolution of a default vision model. Each entry:
 * `{ providerId, backend, id, name, vision: true }`.
 */
export async function listVisionModels() {
  // Cache-first for both backends (the model-list caches are busted on
  // install/delete, so they stay accurate) — the picker doesn't need a forced
  // round-trip on every dataset-page load.
  const [ollama, lmstudio] = await Promise.all([
    listVisionBackendModels('ollama'),
    listVisionBackendModels('lmstudio')
  ])
  // Probe every model: a family name cannot override reported text-only metadata.
  const ollamaVision = await Promise.all(ollama.map(async (m) => {
    const capabilities = await ollamaManager.getModelCapabilities(m.id).catch(() => null)
    return { ...m, vision: isVisionModel({ id: m.id, capabilities }) }
  }))
  const tag = (backend, models) => models
    .filter((m) => m.vision)
    .map((m) => ({ providerId: LOCAL_LLM_PROVIDER_ID_BY_BACKEND[backend], backend, id: m.id, name: m.name || m.id, vision: true }))
  return [
    ...tag('ollama', ollamaVision),
    ...tag('lmstudio', lmstudio),
    ...await listVisionCliModels(),
  ]
}

/**
 * Tool-use (function-calling) capable installed models across both local
 * backends, tagged with the aiToolkit provider id (`ollama` / `lmstudio`) that
 * serves them. Each entry: `{ providerId, backend, id, name, toolUse: true }`.
 *
 * Powers the AGENT model pickers' tool-use annotation, whose client-side
 * `isToolUseModel` id regex is a positive allowlist that goes stale every time a
 * new function-calling family ships — so a genuinely tool-capable model whose id
 * the regex doesn't know (`phi4-mini`, a newer function-calling Gemma build) got
 * flagged "⚠ no known tool use" while the Local LLMs tab's "Agents" badge, which
 * reads these same authoritative capabilities, said otherwise.
 *
 * Deliberately NOT a mirror of `listVisionModels`' CLI expansion: a CLI provider
 * has no enumerable per-model capability, and its tool-calling comes from the CLI
 * harness rather than the model, so there is nothing authoritative to report.
 * Callers union this with the id regex, so an unlisted model still falls back to
 * the regex rather than being asserted incapable.
 */
export async function listToolUseModels() {
  // Cache-first for both backends — same rationale as listVisionModels: the
  // model-list caches are busted on install/delete, so they stay accurate.
  const [ollama, lmstudio] = await Promise.all([
    listModels('ollama').catch(() => []),
    listModels('lmstudio').catch(() => [])
  ])
  // Ollama's /api/tags carries no capability flags at all, so `normalizeModels`
  // could only regex-guess. /api/show reports an authoritative `tools`
  // capability (cached per model), which is what makes this endpoint worth more
  // than the client's own regex — consult it for every model. Unlike the vision
  // path there is no id short-circuit: an id-regex hit is exactly the case the
  // client can already decide for itself, so skipping the round-trip would leave
  // this list adding nothing beyond what the caller already knows.
  const ollamaToolUse = await Promise.all(ollama.map(async (m) => {
    const capabilities = await ollamaManager.getModelCapabilities(m.id).catch(() => null)
    // `isToolUseModel` treats a NON-EMPTY capabilities array as authoritative in
    // both directions; null/empty (probe failed or daemon didn't report) falls
    // back to the id regex.
    return { ...m, toolUse: isToolUseModel({ id: m.id, capabilities }) }
  }))
  // LM Studio reports no tool-calling flag, so `lmStudioBadgeCapabilities`
  // already resolved `tools` from the shared id heuristic — read that rather
  // than re-deriving it, so this endpoint and the Local LLMs tab's badges can
  // never disagree about the same model.
  const lmStudioToolUse = lmstudio.map((m) => ({
    ...m,
    toolUse: (m.capabilities || []).includes('tools')
  }))
  const tag = (backend, models) => models
    .filter((m) => m.toolUse)
    .map((m) => ({ providerId: LOCAL_LLM_PROVIDER_ID_BY_BACKEND[backend], backend, id: m.id, name: m.name || m.id, toolUse: true }))
  return [
    ...tag('ollama', ollamaToolUse),
    ...tag('lmstudio', lmStudioToolUse),
  ]
}

/**
 * Vision-capable CLI providers (codex / claude-code), expanded to one entry per
 * configured model so the caption picker can offer e.g. "codex / gpt-5" or
 * "claude-code / claude-opus-5". A disabled provider is skipped. Each entry
 * mirrors the local-backend shape with `backend: 'cli'`. Best-effort: a load
 * failure yields no CLI entries rather than breaking the whole picker.
 */
async function listVisionCliModels() {
  const { providers } = await getAllProviders().catch(() => ({ providers: [] }))
  const entries = []
  for (const p of providers || []) {
    if (p.enabled === false) continue
    if (!isVisionCapableCliProvider(p)) continue
    const models = Array.isArray(p.models) && p.models.length ? p.models : [p.defaultModel].filter(Boolean)
    for (const id of models) {
      entries.push({ providerId: p.id, backend: 'cli', id, name: `${p.name || p.id} / ${id}`, vision: true })
    }
  }
  return entries
}

// ---- provider catalog sync ---------------------------------------------------

// Bound at boot (bootstrap.js) rather than imported, so this module adds no
// socket.js edge to the suites that reach it.
let providersIo = null
export function bindLocalLlmIo(io) {
  providersIo = io
}

const BACKEND_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' }

// `host:port` of a daemon URL, with every spelling of this machine folded into
// `localhost`, so `127.0.0.1:1234/v1` and `localhost:1234` name one daemon.
function daemonKey(url) {
  try {
    const { hostname, port } = new URL(url)
    return `${isLocalInstanceHost(hostname) ? 'localhost' : hostname}:${port}`
  } catch {
    return null
  }
}

// Which managed backend serves this provider's model refresh. API records are
// matched by id/name/local port; CLI/TUI wrappers by the MODEL_FETCHERS row the
// toolkit would refresh them through.
function catalogBackendForProvider(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return localBackendForProvider(provider)
  const key = resolveModelFetcher(provider)?.key
  return key === 'ollama' || key === 'lmstudio' ? key : null
}

function providerDaemonUrl(backend, provider) {
  return backend === 'ollama'
    ? ollamaBaseFromProvider(provider)
    : provider.endpoint || 'http://localhost:1234'
}

const catalogSyncFlight = createSingleFlight()
// backend -> { targetsKey, signature } of the last installed set every target
// was refreshed against (or found already matching). `null` until a first look.
const lastCatalogSync = { ollama: null, lmstudio: null }

const sortedKey = (ids) => [...ids].sort().join('\n')

// Judged per provider, never on the union: one record holding the full set
// must not hide a stale sibling. An Ollama CLI/TUI wrapper stores only the
// tool-capable subset, which can't be told apart without probing, so it
// matches when it lists nothing that was removed and is not left empty.
function storedCatalogMatches(backend, targets, installed) {
  const installedSet = new Set(installed)
  return targets.every((p) => {
    const stored = new Set(p.models || [])
    if (![...stored].every((id) => installedSet.has(id))) return false
    const toolFiltered = backend === 'ollama' && (p.type === 'cli' || p.type === 'tui')
    return toolFiltered ? stored.size > 0 || installedSet.size === 0 : stored.size === installedSet.size
  })
}

async function syncBackendProviderModels(backend, { force, providers }) {
  const localDaemon = daemonKey(manager(backend).getBaseUrl())
  // A managed daemon on another host could stall a list read for its whole
  // probe timeout; only install/delete (which already talked to it) go there.
  if (!force && !localDaemon?.startsWith('localhost:')) return false
  const all = providers ?? (await getAllProviders()).providers
  const targets = (all || []).filter((p) => (force || p.enabled !== false)
    && catalogBackendForProvider(p) === backend
    && daemonKey(providerDaemonUrl(backend, p)) === localDaemon)
  if (targets.length === 0) return false

  const listing = await listManagedBackendModels(backend, true)
  // An unreachable daemon or unreadable list is not evidence the set changed.
  if (listing.error && !force) return false
  const installed = listing.error ? null : listing.models.map((m) => m.id)
  const record = installed && { targetsKey: sortedKey(targets.map((p) => p.id)), signature: sortedKey(installed) }
  if (!force) {
    const previous = lastCatalogSync[backend]
    const unchanged = previous?.targetsKey === record.targetsKey
      ? previous.signature === record.signature
      : storedCatalogMatches(backend, targets, installed)
    if (unchanged) {
      lastCatalogSync[backend] = record
      return false
    }
  }

  const label = BACKEND_LABEL[backend]
  const groups = await refreshProviderModelsBatch(targets.map((p) => p.id))
  for (const group of groups) {
    if (group.status === 'failed') {
      console.error(`⚠️ Failed to refresh models for ${group.ids.length} ${label}-backed provider(s) via ${group.leadId}: ${group.error?.message}`)
    } else if (group.status === 'missing') {
      // The lead was deleted between listing the providers and probing it.
      // Say so — silently dropping the group would leave its siblings stale
      // with no trace of why.
      console.error(`⚠️ Skipped refreshing ${group.ids.length} ${label}-backed provider(s): lead provider ${group.leadId} no longer exists`)
    }
  }
  // A failed or skipped group leaves the signature unrecorded so the next read
  // retries it; any update still reports true so the route re-reads.
  if (record && groups.every((group) => group.status === 'updated')) lastCatalogSync[backend] = record
  return groups.some((group) => group.status === 'updated')
}

/**
 * Bring every provider backed by a managed local backend (Ollama, LM Studio) up
 * to date with the models that daemon has installed, so a model added or
 * removed — through the Local LLMs tab, `ollama pull`, `lms get` or LM Studio's
 * own UI — reaches every provider/model picker without "Refresh Models".
 *
 * Targets are the providers whose refresh resolves to that backend on the
 * daemon PortOS manages; a remote endpoint's catalog says nothing about this
 * daemon's installs and keeps its own "Refresh Models".
 *
 * Two callers:
 * - every provider list read (`GET /api/providers`, `/catalog`) awaits it
 *   before answering. It costs one loopback model list per backend with an
 *   enabled target, and runs `refreshProviderModelsBatch` (one probe per daemon
 *   and probe shape, one `providers.json` write) only when the installed set
 *   changed — on a first look, when it differs from the stored catalogs.
 * - install/delete pass `force` to refresh every target unconditionally.
 *
 * Probes list models only: no generation, no spawn. Single-flight per backend
 * and mode. Never rejects. Resolves true when a catalog was rewritten, after
 * broadcasting `providers:changed` (this write bypasses the provider routes
 * that announce one).
 *
 * @param {{ backend?: 'ollama'|'lmstudio', force?: boolean, providers?: object[] }} [opts]
 *   `backend` omitted syncs both. `providers`: the list the caller already
 *   read, to skip a second read.
 * @returns {Promise<boolean>}
 */
export async function syncLocalProviderModels({ backend, force = false, providers } = {}) {
  const backends = backend ? [backend] : ['ollama', 'lmstudio']
  const results = await Promise.all(backends.map((b) =>
    catalogSyncFlight.run(`${b}:${force ? 'force' : 'read'}`, () =>
      syncBackendProviderModels(b, { force, providers }).catch((err) => {
        console.error(`⚠️ Failed to sync ${BACKEND_LABEL[b]} provider models: ${err.message}`)
        return false
      }))))
  const changed = results.some(Boolean)
  if (changed) emitToOperatorsOn(providersIo, 'providers:changed')
  return changed
}

// ---- install / delete --------------------------------------------------------

/**
 * One-line label for an install progress frame, or null for a frame with nothing
 * to say. Shared by every consumer of `installModel`'s `onProgress` (the install
 * route and `migrateBackend`) so a new frame kind — `retrying`, `finalizing`, or
 * whatever comes next — reaches all of them without another per-call-site edit.
 * @param {{ status?: string, percent?: number|null }} [p]
 * @returns {string|null}
 */
export function describeInstallProgress(p) {
  if (p?.percent != null) return `${p.status || 'downloading'} ${p.percent}%`
  return p?.status || null
}

/**
 * Install (pull/download) a model on a backend.
 * @param {(p) => void} [onProgress] - streaming progress (Ollama only)
 * @param {{ force?: boolean }} [opts] - when true, evict existing LM Studio
 *   files first so `lms get` actually re-fetches in-place GGUF replacements.
 *   Ollama's pull already re-checks the registry digest, so force is a no-op there.
 */
async function localInstallDest(backend) {
  return backend === 'ollama' ? ollamaManager.getModelsDir() : lmStudioManager.getModelsDir()
}

// A "Redownload" of a model already on disk transfers little to nothing in
// practice — Ollama's pull re-checks the registry digest and dedupes
// unchanged layers, and LM Studio's own `lms get` skips files already
// present — so sizing it against the FULL catalog size (like a genuine
// net-new install) can refuse a redownload the real transfer would have
// completed in seconds. `expectedBytes: 0` matches this feature's existing
// "can't size it, don't block it" convention for that case.
async function expectedInstallBytes(backend, modelId) {
  const installed = await listModels(backend).catch(() => [])
  if (installed.some((m) => m.id === modelId)) return 0
  return catalogSizeBytes(backend, modelId)
}

export async function previewInstallModel(backend, modelId) {
  if (!isBackend(backend)) {
    throw new ServerError(`Unknown backend: ${backend}`, { status: 400 })
  }
  const destPath = await localInstallDest(backend)
  const installed = await listModels(backend).catch(() => [])
  const alreadyDownloaded = installed.some((m) => m.id === modelId)
  // 0 for a free-text/uncurated model id (e.g. a bare Ollama tag the user
  // typed) — the preflight already treats that as "unknown, never refuse."
  const preflight = await assessDownloadPreflight({
    destPath,
    expectedBytes: alreadyDownloaded ? 0 : catalogSizeBytes(backend, modelId),
  })
  return {
    kind: 'install',
    backend,
    modelId,
    ...preflight,
    destPath,
    alreadyDownloaded,
  }
}

async function performInstallModel(backend, modelId, onProgress, { force = false, signal } = {}) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  // Resolve-not-throw: every other failure this function can hit (unknown
  // backend, OLLAMA_OUTDATED, ...) resolves `{ success: false, error }` —
  // migrateBackend's per-model loop is written against that contract with no
  // try/catch of its own, so a throw here would abort the whole migration on
  // model N instead of recording one more `status: 'failed'` row and moving on.
  const preflight = await assessDownloadPreflight({
    destPath: await localInstallDest(backend),
    expectedBytes: await expectedInstallBytes(backend, modelId),
  })
  if (preflight.verdict === DOWNLOAD_VERDICTS.INSUFFICIENT) {
    return { success: false, error: diskInsufficientError(preflight).message, code: 'DISK_INSUFFICIENT' }
  }
  if (backend === 'ollama') {
    const importSpec = getOllamaImportSpec(modelId)
    const result = importSpec
      ? await (await import('./ollamaSafetensorsImport.js')).importModelFromHfSafetensors(importSpec, onProgress)
      : await ollamaManager.pullModel(modelId, onProgress, { signal })
    if (result.success) void syncLocalProviderModels({ backend: 'ollama', force: true })
    return result
  }
  // `lms get` skips files already on disk. A force redownload has to evict the
  // matching GGUF (or the whole repo folder) first, or the "new" weights never land.
  if (force) {
    const evicted = await lmStudioManager.evictDownloadedQuant(modelId)
    if (!evicted.success) return { success: false, error: evicted.error, modelId }
  }
  // LM Studio: prefer the `lms` CLI (real, blocking download), fall back to the
  // REST hook.
  if (await commandExists('lms', ['version'])) {
    // `lms get` streams substantial progress to stdout; the default 1MB
    // maxBuffer overflows and surfaces as a false install failure (see
    // voice/bootstrap.js which uses the same 64MB ceiling for `lms get`).
    const r = await execFileAsync('lms', ['get', '-y', modelId], { timeout: LMS_INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal })
      .then(() => ({ ok: true })).catch((err) => ({ _err: err.stderr || err.message }))
    if (signal?.aborted) return installCanceled(modelId)
    if (r._err) return { success: false, error: r._err, modelId }
    lmStudioManager.resetCache()
    void syncLocalProviderModels({ backend: 'lmstudio', force: true })
    return { success: true, modelId }
  }
  // REST fallback only *queues* the download — LM Studio pulls it in the
  // background and the call returns immediately. Flag it `pending` so callers
  // don't claim the model is installed before it actually is.
  const r = await lmStudioManager.downloadModel(modelId)
  return r.success ? { ...r, pending: true } : r
}

/**
 * Delete an installed model from a backend.
 */
async function performDeleteModel(backend, modelId) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    const loaded = await ollamaManager.getLoadedModels()
    if (ollamaManager.getLastLoadedModelsError()) {
      return { success: false, error: 'Could not verify Ollama model residency; refresh the backend before deleting.', modelId }
    }
    if (loaded.some((model) => model.id === modelId || model.name === modelId)) {
      return { success: false, error: 'Model is loaded; unload it before deleting.', modelId }
    }
    const result = await ollamaManager.deleteModel(modelId)
    if (result.success) void syncLocalProviderModels({ backend: 'ollama', force: true })
    return result
  }
  const loaded = await lmStudioManager.getLoadedModels(true)
  if (lmStudioManager.getLastLoadedModelsError()) {
    return { success: false, error: 'Could not verify LM Studio model residency; refresh the backend before deleting.', modelId }
  }
  if (loaded.some((model) => lmStudioManager.modelIdsReferToSameRepo(model.id, modelId))) {
    return { success: false, error: 'Model is loaded; unload it before deleting.', modelId }
  }
  // LM Studio has no delete in its REST API and the `lms` CLI has no `rm`
  // command — deleteModel removes the model's on-disk folder directly.
  const result = await lmStudioManager.deleteModel(modelId)
  if (result.success) void syncLocalProviderModels({ backend: 'lmstudio', force: true })
  return result
}

// Both backends' installs and deletes have several success and failure exits
// each (preflight refusal, a forced evict that failed, the `lms` CLI vs the REST
// fallback, a residency check that could not be verified). Recording the manifest
// at every one of those is how a later exit gets added without one — so the two
// public entry points wrap a single internal function and record once, off its
// one contractual `{ success }` result.
//
// A `pending` LM Studio install is deliberately NOT recorded: the REST fallback
// only QUEUES the download, so the weights are not on disk yet and the next
// reconcile is what adopts them.
/**
 * Install a model into a backend, recording it in the model manifest on success.
 *
 * @param {string} backend
 * @param {string} modelId
 * @param {Function} [onProgress]
 * @param {Object} [options]
 * @param {boolean} [options.force] Re-download even when the weights are present
 * @returns {Promise<Object>} `{ success, ... }` — never throws (see performInstallModel)
 */
// In-flight installs, one per backend + model, so Cancel can reach the pull a
// request started. In-memory on purpose: a restart ends every pull anyway.
const activeInstalls = new Map()
const installKey = (backend, modelId) => `${backend}:${modelId}`
const installCanceled = (modelId) => ({ success: false, canceled: true, code: 'INSTALL_CANCELED', error: 'Download canceled', modelId })

/** The model downloads this process is running now, for the status payload. */
export function listActiveInstalls() {
  return [...activeInstalls.values()].map(({ backend, modelId, startedAt, cancelable }) => ({ backend, modelId, startedAt, cancelable }))
}

/**
 * Stop an in-flight install. The install itself resolves `INSTALL_CANCELED`
 * and removes what it had partly downloaded.
 */
export function cancelModelInstall(backend, modelId) {
  const entry = activeInstalls.get(installKey(backend, modelId))
  if (!entry) return { success: false, code: 'INSTALL_NOT_RUNNING', error: `No download of ${modelId} is running on ${backend}` }
  // An Ollama Safetensors import stages the checkpoint and then runs `ollama create`
  // under its own staging lifecycle, which takes no signal; answering success here
  // would leave it running behind a "canceled" banner.
  if (!entry.cancelable) {
    return { success: false, code: 'INSTALL_NOT_CANCELABLE', error: `${modelId} is an Ollama import and can't be canceled once started` }
  }
  console.log(`🛑 Local LLM: canceling ${backend} download of ${modelId}`)
  entry.controller.abort()
  return { success: true }
}

export async function installModel(backend, modelId, onProgress, options = {}) {
  const key = installKey(backend, modelId)
  if (activeInstalls.has(key)) {
    return { success: false, code: 'INSTALL_IN_PROGRESS', error: `${modelId} is already downloading on ${backend}`, modelId }
  }
  const controller = new AbortController()
  const cancelable = !(backend === 'ollama' && getOllamaImportSpec(modelId))
  activeInstalls.set(key, { backend, modelId, controller, cancelable, startedAt: new Date().toISOString() })
  const result = await performInstallModel(backend, modelId, onProgress, { ...options, signal: controller.signal })
    .finally(() => activeInstalls.delete(key))
  if (controller.signal.aborted && !result?.success) return installCanceled(modelId)
  if (result?.success && !result.pending) {
    // The row comes from the shared builder the SCAN uses, so a tracked model and
    // a scanned one carry the same size semantics, cleanup warning and delete
    // action. Size is left unset: neither backend reports the installed bytes, and
    // the next reconcile measures it off disk.
    await recordModelInstall({
      ...localModelInventoryRow({ backend, modelId }),
      source: 'download',
    })
    if (backend === 'ollama') await applyRecommendedContextWindow(modelId).catch((err) => console.warn(`⚠️ Context window for ${modelId} not set: ${err.message}`))
  }
  return result
}

/**
 * List installed Ollama models with their context plans (KV size per window, recommended window).
 * @returns {Promise<{ budgetBytes: number|null, cacheType: string, cacheTypeSource: string, plans: object[] }>}
 */
export async function listContextPlans() {
  const { planInstalledModels } = await import('./contextMemoryPlanner.js')
  const models = await listModels('ollama').catch(() => [])
  return planInstalledModels(models)
}

/**
 * Give a newly installed Ollama model the largest window that fits this host
 * (its native maximum when memory allows), as a per-model num_ctx on the
 * built-in Ollama provider. Leaves an override the user already set alone.
 */
async function applyRecommendedContextWindow(modelId) {
  const provider = await getProviderById('ollama')
  if (!provider || provider.modelNumCtx?.[modelId]) return null
  const { planModelContext, resolveContextPlanHost } = await import('./contextMemoryPlanner.js')
  const model = (await listModels('ollama', true).catch(() => [])).find((m) => m.id === modelId) || { id: modelId }
  // planModelContext returns no recommendation when the host budget is unknown and the cache is reserved.
  const plan = await planModelContext(model, await resolveContextPlanHost())
  if (!plan.recommended) return null
  await updateProvider('ollama', { modelNumCtx: { ...(provider.modelNumCtx || {}), [modelId]: plan.recommended } })
  console.log(`📏 ${modelId}: per-model num_ctx set to ${plan.recommended} (largest window that fits this host)`)
  return plan.recommended
}

/**
 * Delete an installed model from a backend, clearing it from the model manifest.
 *
 * @param {string} backend
 * @param {string} modelId
 * @returns {Promise<Object>} `{ success, ... }`
 */
export async function deleteModel(backend, modelId) {
  const result = await performDeleteModel(backend, modelId)
  if (result?.success) await recordModelUninstall({ backend, key: modelId })
  return result
}

// ---- switch backend --------------------------------------------------------

/**
 * Flip the active backend without moving any models.
 */
export async function switchBackend(to) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  const override = process.env.LLM_BACKEND
  if (isBackend(override) && override !== to) {
    return {
      success: false,
      code: 'BACKEND_OVERRIDE_CONFLICT',
      error: `LLM_BACKEND is exported as ${override}. Change or unset that environment override and restart PortOS before setting ${to} as the default.`,
    }
  }
  await writeBackend(to)
  await ensureBackendProvider(to)
  console.log(`🔀 Active local LLM backend → ${to}`)
  return { success: true, backend: to }
}

/**
 * Migrate the other backend's models without changing the default backend.
 * Pass the façade's inventory and model install paths so migration shares their state.
 * @param {string} to - target backend
 * @param {{ mode?: 'link'|'copy', onProgress?: (p: { event: string, message: string }) => void }} [options]
 */
export async function migrateBackend(to, options = {}) {
  return migrateLocalModels({ listManagedBackendModels, installModel, describeInstallProgress }, to, options)
}
