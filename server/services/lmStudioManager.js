/**
 * LM Studio Manager Service
 *
 * Manages local LM Studio models for free local thinking.
 * Provides model discovery, loading, unloading, and downloading.
 */

import { homedir } from 'os'
import { join, basename, resolve, relative, isAbsolute, sep } from 'path'
import { existsSync } from 'fs'
import { readdir, stat, copyFile, link, rm, rmdir } from 'fs/promises'
import { dirSize, ensureDir } from '../lib/fileUtils.js'
import { cosEvents } from './cosEvents.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import {
  dirIsMlx, selectPrimaryGguf, selectProjectorGguf, isShardedGguf, lmStudioPublisherRepo
} from '../lib/localLlmDisk.js'
import { bufferedSpawn } from '../lib/bufferedSpawn.js'
import { findCommandOnPath } from '../lib/processEnv.js'

const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// Availability probe is short — if the local server is down we'd rather fail
// fast and degrade to "no LM Studio" than block 30s on every cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000
// `lms server start|stop` only asks the already-installed app to flip its
// listener — it never downloads anything, so a minute is generous.
const LMS_CONTROL_TIMEOUT_MS = 60_000
// `lms load` reads a multi-gigabyte GGUF off disk and allocates its KV cache;
// on a cold page cache that is minutes, not seconds.
const LMS_LOAD_TIMEOUT_MS = 300_000

// Default LM Studio configuration
const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')

const DEFAULT_CONFIG = {
  baseUrl: normalizeBaseUrl(process.env.LM_STUDIO_URL || 'http://localhost:1234'),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS,
  defaultThinkingModel: 'gpt-oss-20b'
}

// Cached state
let config = { ...DEFAULT_CONFIG }
let isAvailable = null
// null = not yet fetched; any array (even empty) = a cached result — mirrors
// availableModels below so an idle LM Studio (server up, 0 models loaded)
// doesn't re-hit /api/v0/models on every status poll.
let loadedModels = null
let lastLoadedModelsError = null
// null = not yet fetched; any array (even empty) = a cached result. Lets the
// catalog-overlay path (queried per keystroke) reuse the list instead of
// re-hitting /api/v0/models each time. Busted to null by resetCache().
let availableModels = null
// Last error from the model-LIST call (/api/v0/models), distinct from the
// availability probe (/v1/models): LM Studio can answer the probe yet fail the
// list, so this lets callers tell "0 models" from "couldn't list models".
let lastListError = null
let lastCheckAt = null
// Model id → the `lms load` flags PortOS loaded it with. An entry means that
// model is resident under a PortOS tuning; its absence means it is not, which is
// what lets an UNTUNED assessment tell "already at defaults, relaunch nothing"
// from "still carrying the last sweep's flags, reload without them". Without it
// a baseline reading is filed as "Backend defaults" while the model is loaded at
// the previous run's context length.
//
// Deliberately NOT cleared by `resetCache` (`runLms` resets the model caches
// after every command, including the load that just set this) and not by a
// failed availability probe either. A stale entry costs one reload nobody needed
// and still leaves the model untuned; a wrongly-dropped one silently restores
// the mislabeling this record exists to prevent. Only an unload clears it.
const tunedLoads = new Map()

// Status tracking
const status = {
  lastError: null,
  lastSuccessAt: null,
  consecutiveErrors: 0
}

/**
 * Make a request to LM Studio API
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Fetch options
 * @returns {Promise<*>} - Response data
 */
async function lmStudioRequestAt(baseUrl, endpoint, options = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${endpoint}`
  const { timeout, headers, ...rest } = options

  const response = await fetchWithTimeout(url, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  }, timeout || config.timeout)

  if (!response.ok) {
    throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

async function lmStudioRequest(endpoint, options = {}) {
  return lmStudioRequestAt(config.baseUrl, endpoint, options)
}

/**
 * Check if LM Studio is available
 * @returns {Promise<boolean>} - True if available
 */
async function checkLMStudioAvailable(forceRefresh = false) {
  const now = Date.now()

  // Use cached result if recent (within AVAILABILITY_CACHE_TTL_MS).
  if (!forceRefresh && lastCheckAt && now - lastCheckAt < AVAILABILITY_CACHE_TTL_MS && isAvailable !== null) {
    return isAvailable
  }

  try {
    await lmStudioRequest('/v1/models', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS })
    isAvailable = true
    status.lastSuccessAt = now
    status.consecutiveErrors = 0
    status.lastError = null
    lastCheckAt = now
    return true
  } catch (err) {
    isAvailable = false
    status.lastError = err.message
    status.consecutiveErrors++
    lastCheckAt = now
    return false
  }
}

/**
 * Read residency from a specific provider endpoint without touching the global
 * manager's availability cache or error state.
 * @returns {Promise<{models:Array,error:string|null}>}
 */
async function getLoadedModelsAt(baseUrl) {
  // Use native REST API for richer model info (type, state, architecture)
  const nativeModels = await lmStudioRequestAt(baseUrl, '/api/v0/models').catch((err) => ({ _err: err.message }))
  if (Array.isArray(nativeModels?.data)) {
    return {
      models: nativeModels.data
        .filter(model => model.state === 'loaded')
        .map(model => ({
        id: model.id,
        object: model.object || 'model',
        type: model.type,
        arch: model.arch,
        quantization: model.quantization,
        state: model.state,
        maxContextLength: model.max_context_length,
        ownedBy: model.publisher
        })),
      error: null
    }
  }

  // Fallback to OpenAI-compat endpoint
  const response = await lmStudioRequestAt(baseUrl, '/v1/models').catch((err) => ({ _err: err.message }))
  if (Array.isArray(response?.data)) {
    return {
      models: response.data.map(model => ({
        id: model.id,
        object: model.object,
        created: model.created,
        ownedBy: model.owned_by
      })),
      error: null
    }
  }

  return {
    models: [],
    error: nativeModels?._err || response?._err || 'LM Studio loaded-model endpoints returned no data'
  }
}

/**
 * Get currently loaded models from the configured LM Studio server.
 * @param {boolean} forceRefresh - Force refresh from API
 * @returns {Promise<Array>} - Loaded models
 */
async function getLoadedModels(forceRefresh = false) {
  if (!forceRefresh && loadedModels !== null) {
    return loadedModels
  }

  const available = await checkLMStudioAvailable(forceRefresh)
  if (!available) {
    // Don't cache — unavailable is transient, so the next call re-probes.
    lastLoadedModelsError = status.lastError || 'LM Studio is unavailable'
    return []
  }

  const result = await getLoadedModelsAt(config.baseUrl)
  lastLoadedModelsError = result.error
  if (result.error) return []
  loadedModels = result.models
  return loadedModels
}

/** Last loaded-model probe error (null only after a trustworthy list). */
function getLastLoadedModelsError() {
  return lastLoadedModelsError
}

/**
 * Get all downloaded models (loaded and not-loaded).
 * @param {boolean} [forceRefresh] - bypass the cache (callers that read live
 *   per-model `state`, e.g. embedding-model discovery, should force).
 * @returns {Promise<Array>} - All downloaded models with state info
 */
async function getAvailableModels(forceRefresh = false) {
  if (!forceRefresh && availableModels !== null) return availableModels
  const available = await checkLMStudioAvailable(forceRefresh)
  if (!available) {
    // Unreachable is surfaced by the availability probe (`available`), not here.
    lastListError = null
    return []
  }

  const response = await lmStudioRequest('/api/v0/models').catch((err) => ({ _err: err.message }))
  if (response?.data) {
    lastListError = null
    availableModels = response.data.map(model => ({
      id: model.id,
      type: model.type,
      arch: model.arch,
      publisher: model.publisher,
      quantization: model.quantization,
      state: model.state,
      maxContextLength: model.max_context_length
    }))
    return availableModels
  }

  // Reachable (the /v1/models probe passed) but the native model-list call
  // failed or returned no data — record it so callers can distinguish this from
  // a genuinely empty list. Fall back to loaded models for a best-effort list.
  lastListError = response?._err || 'LM Studio model list (/api/v0/models) returned no data'
  return getLoadedModels(true)
}

/** Last `/api/v0/models` list error (null if the most recent list succeeded). */
function getLastListError() {
  return lastListError
}

/**
 * Download a model from LM Studio catalog
 * @param {string} modelId - Model identifier to download
 * @returns {Promise<Object>} - Download result
 */
async function downloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  console.log(`📥 Downloading model: ${modelId}`)
  cosEvents.emit('lmstudio:downloadRequested', { modelId })

  const response = await lmStudioRequest('/api/v1/models/download', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 10000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to start download for ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  return { success: true, modelId, ...response }
}

/**
 * Load a model into LM Studio memory
 * @param {string} modelId - Model identifier (publisher/model-name format)
 * @returns {Promise<Object>} - Load result
 */
async function loadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  // Use the native REST API load endpoint
  const response = await lmStudioRequest('/api/v1/models/load', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 60000 // Loading can take a while
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to load model ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  // Refresh loaded models
  await getLoadedModels(true)

  console.log(`📦 Model loaded: ${modelId}`)
  cosEvents.emit('lmstudio:modelLoaded', { modelId })

  return { success: true, modelId, ...response }
}

/**
 * Reload a model through the `lms` CLI with explicit load-time settings.
 *
 * LM Studio's context length, GPU offload, and parallelism are chosen when a
 * model is LOADED — no request field changes them, and the REST load endpoint
 * takes only a model id. `lms load` is the one path that carries them, so a
 * tuned measurement of an LM Studio model goes through here or it is measuring
 * whatever the app happened to be holding.
 *
 * The model is unloaded first: `lms load` on an already-resident model returns
 * the existing instance rather than re-loading it at the new settings, which
 * would report success for a tuning that never applied.
 *
 * An EMPTY `args` is the opposite request: reload the model with no tuning flags
 * at all, so an untuned assessment measures a model that is actually untuned
 * rather than whatever the previous sweep loaded. It is a no-op when PortOS did
 * not load this model with flags — reloading anyway would cold-load the weights
 * and the first sample would time the page-in.
 *
 * Resolves rather than throws (mirrors `controlServer`) so a caller can record
 * the refusal alongside the reading it describes.
 *
 * @param {string} modelId
 * @param {string[]} args - rendered flags, e.g. `['--context-length', '8192']`
 * @returns {Promise<{ success: boolean, unchanged?: boolean, error?: string }>}
 *   `unchanged: true` means nothing needed reloading — not a refusal.
 */
async function loadModelWithArgs(modelId, args = []) {
  if (!modelId) return { success: false, error: 'No model was named to load.' }

  const signature = args.join(' ')
  const carried = tunedLoads.get(modelId) || null
  if (!signature && !carried) return { success: true, unchanged: true }

  // `lms load` on an already-RESIDENT model returns the existing instance rather
  // than re-loading it at the new settings, so the model has to be out of memory
  // before the load or the call reports success for a configuration that never
  // applied. That makes a refused unload fatal in both directions: a tuned load
  // would file the previous configuration's throughput under the requested
  // tuning, and a clear would file it as backend defaults.
  //
  // Gated on residency, not merely on availability. `unloadModel` also resolves
  // `{ success: false }` for a model that simply is not loaded — the ordinary
  // state before a first assessment — and reading that as a refusal would fail
  // every first run and never record its tuning. Both probes are FORCED: a
  // cached `false` availability, or a stale loaded-models list, would skip the
  // unload and hand back exactly the stale instance this guards against.
  if (await checkLMStudioAvailable(true)) {
    const resident = await getLoadedModels(true).catch(() => [])
    // `[]` from `getLoadedModels` means "nothing is loaded" OR "both list
    // endpoints failed" — the null-vs-empty sentinel trap in root AGENTS.md, and
    // `getLastLoadedModelsError` is the module's own way out of it. An
    // untrustworthy list must not read as "not resident": that skips the unload,
    // `lms load` hands back the existing instance, and the previous
    // configuration's throughput is filed under this call's. Assume resident and
    // try — a wasted unload attempt is recoverable, a stale instance is not.
    const listTrusted = getLastLoadedModelsError() === null
    const loaded = !listTrusted
      || resident.some((m) => m?.id === modelId || modelIdsReferToSameRepo(m?.id, modelId))
    const unloaded = loaded
      ? await unloadModel(modelId).catch((err) => ({ success: false, error: err?.message }))
      : { success: true }
    // Checked BEFORE the load: once `lms load` has run, a refusal is no longer
    // the whole story — the flags may genuinely be in effect.
    if (!unloaded.success) {
      return {
        success: false,
        error: unloaded.error
          || `LM Studio would not unload ${modelId}, so it is still loaded with ${carried || 'its previous settings'}`,
      }
    }
  }

  // `-y` because there is no one at a terminal to answer the model-picker prompt
  // `lms load` opens when a key matches more than one download.
  //
  // `runLms` resets the model caches, so the next reader refetches lazily —
  // forcing a refresh here would pay two loopback round trips for a value
  // nothing reads between the load and the first sample.
  const result = await runLms(['load', modelId, '-y', ...args], { timeoutMs: LMS_LOAD_TIMEOUT_MS })
  if (!result.success) return result

  if (signature) tunedLoads.set(modelId, signature)
  else tunedLoads.delete(modelId)
  console.log(`📦 LM Studio loaded ${modelId}${signature ? ` (${signature})` : ` without ${carried}`}`)
  cosEvents.emit('lmstudio:modelLoaded', { modelId })
  return { success: true }
}

/**
 * Unload a model from LM Studio memory
 * @param {string} modelId - Model identifier to unload
 * @returns {Promise<Object>} - Unload result
 */
async function unloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  const response = await lmStudioRequest('/api/v1/models/unload', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 15000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to unload model ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  // Refresh loaded models
  await getLoadedModels(true)

  // Whatever flags it was loaded with left with it.
  tunedLoads.delete(modelId)
  console.log(`📤 Model unloaded: ${modelId}`)
  cosEvents.emit('lmstudio:modelUnloaded', { modelId })

  return { success: true, modelId }
}

/**
 * Get the recommended thinking model
 * @returns {Promise<string|null>} - Model ID or null if none available
 */
async function getRecommendedThinkingModel() {
  const models = await getLoadedModels()

  if (models.length === 0) {
    return null
  }

  // Prefer specific thinking-optimized models
  const preferredModels = [
    'gpt-oss-20b',
    'deepseek-r1',
    'qwen2.5-coder',
    'codellama',
    'mistral',
    'llama'
  ]

  for (const preferred of preferredModels) {
    const match = models.find(m =>
      m.id.toLowerCase().includes(preferred.toLowerCase())
    )
    if (match) return match.id
  }

  // Return first available model
  return models[0]?.id || null
}

/**
 * Make a quick completion request for local thinking
 * @param {string} prompt - Prompt text
 * @param {Object} options - Completion options
 * @returns {Promise<Object>} - Completion result
 */
async function quickCompletion(prompt, options = {}) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  const model = options.model || await getRecommendedThinkingModel()
  if (!model) {
    return { success: false, error: 'No model available' }
  }

  try {
    const response = await lmStudioRequest('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [
          ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        max_tokens: options.maxTokens || 512,
        temperature: options.temperature ?? 0.7,
        stream: false
      }),
      timeout: options.timeout || 30000
    })

    const content = response.choices?.[0]?.message?.content || ''

    return {
      success: true,
      content,
      model,
      usage: response.usage
    }
  } catch (err) {
    return { success: false, error: err.message, model }
  }
}

/**
 * Get embeddings from local model
 * @param {string} text - Text to embed
 * @param {Object} options - Embedding options
 * @returns {Promise<Object>} - Embedding result
 */
async function getEmbeddings(text, options = {}) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  // Auto-discover an embedding model if none specified
  let model = options.model
  if (!model) {
    const models = await getAvailableModels(true) // need live per-model state
    const embeddingModel = models.find(m => m.type === 'embeddings' && m.state === 'loaded')
      || models.find(m => m.type === 'embeddings')
    if (embeddingModel) {
      // Load it if not already loaded
      if (embeddingModel.state !== 'loaded') {
        await loadModel(embeddingModel.id)
      }
      model = embeddingModel.id
    } else {
      return { success: false, error: 'No embedding model available in LM Studio' }
    }
  }

  const response = await lmStudioRequest('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model, input: text }),
    timeout: options.timeout || 10000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    return { success: false, error: response._err, model }
  }

  const embedding = response.data?.[0]?.embedding || []

  return {
    success: true,
    embedding,
    model,
    dimensions: embedding.length
  }
}

/**
 * Get LM Studio status
 * @returns {Promise<Object>} - Status information
 */
async function getStatus() {
  const available = await checkLMStudioAvailable()
  const models = available ? await getLoadedModels() : []

  return {
    available,
    baseUrl: config.baseUrl,
    loadedModels: models.length,
    models: models.map(m => m.id),
    recommendedThinkingModel: available ? await getRecommendedThinkingModel() : null,
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
    lastSuccessAt: status.lastSuccessAt ? new Date(status.lastSuccessAt).toISOString() : null,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

/**
 * Live base URL — reflects runtime `updateConfig()` patches, not just startup
 * env. Used by sibling services (e.g. the local code-review endpoint) so a
 * relocated LM Studio install doesn't desync between the catalog UI and the
 * code path that actually talks to the server.
 */
function getBaseUrl() {
  return config.baseUrl
}

/**
 * Update configuration
 * @param {Object} newConfig - New configuration
 * @returns {Object} - Updated configuration
 */
function updateConfig(newConfig) {
  if (newConfig.baseUrl) {
    config.baseUrl = newConfig.baseUrl
    isAvailable = null // Force recheck
    lastCheckAt = null
  }

  if (newConfig.timeout) {
    config.timeout = newConfig.timeout
  }

  if (newConfig.defaultThinkingModel) {
    config.defaultThinkingModel = newConfig.defaultThinkingModel
  }

  return { ...config }
}

/**
 * Reset cached state
 */
function resetCache() {
  isAvailable = null
  loadedModels = null
  lastLoadedModelsError = null
  availableModels = null
  lastListError = null
  lastCheckAt = null
}

// LM Studio can be installed as a macOS app without the `lms` CLI on PATH and
// without the local server running — mirror scripts/setup-llm.js so status
// doesn't report "Not installed" (and offer a redundant install) in that case.
function isAppInstalled() {
  return process.platform === 'darwin' && existsSync('/Applications/LM Studio.app')
}

/**
 * Run one `lms` subcommand, resolving to `{ success }` or `{ success: false, error }`.
 *
 * Every `lms` call shares the same three failure shapes — the CLI is not on
 * PATH, the process timed out, or it exited non-zero — and the same rule for
 * pulling a human line out of the result (last line of stderr, else stdout).
 * They live here once so the "run \`lms bootstrap\`" instruction and the
 * error-line rule cannot be fixed for one caller and not the other.
 *
 * Resolves rather than throws (mirrors `controlOllamaServer`) so a route can
 * turn a refusal into a 502, and a measurement can record it, with the reason
 * intact.
 *
 * @param {string[]} args
 * @param {{ timeoutMs: number }} options
 */
async function runLms(args, { timeoutMs }) {
  const binary = findCommandOnPath('lms')
  if (!binary) {
    return {
      success: false,
      error: "LM Studio's `lms` CLI is not on PortOS's PATH. Open LM Studio once and run `lms bootstrap`, or use the app's Developer tab."
    }
  }
  // Name the SUBCOMMAND in the error, not the whole argv — a flag's value
  // ("8192") is not a flag and would otherwise land in the message as if it were
  // part of the command the user should run.
  const flagAt = args.findIndex((a) => a.startsWith('-'))
  const label = `\`lms ${args.slice(0, flagAt === -1 ? args.length : flagAt).join(' ')}\``
  const result = await bufferedSpawn(binary, args, { timeoutMs, shell: false })
  resetCache()
  if (result.timedOut) return { success: false, error: `${label} timed out after ${Math.round(timeoutMs / 1000)}s` }
  if (!result.success) {
    const detail = result.error?.message || String(result.stderr || result.stdout || '').trim().split(/\r?\n/).pop()
    return { success: false, error: detail || `${label} exited with code ${result.code}` }
  }
  return { success: true }
}

/**
 * Start or stop LM Studio's local OpenAI-compatible server via its own `lms` CLI.
 *
 * `lms` is LM Studio's CLI shim, installed by `lms bootstrap` from the app.
 * Without it there is no headless way to drive the server, and pretending
 * otherwise would report a success the user cannot see — so that case is a
 * refusal naming the one command that fixes it.
 *
 * Resolves rather than throws (mirrors `controlOllamaServer`) so the route can
 * turn a refusal into a 502 with the reason intact.
 *
 * @param {'start'|'stop'} action
 */
async function controlServer(action) {
  if (action !== 'start' && action !== 'stop') {
    return { success: false, error: `Unknown LM Studio action: ${action}` }
  }
  const result = await runLms(['server', action], { timeoutMs: LMS_CONTROL_TIMEOUT_MS })
  if (!result.success) return result
  console.log(`📦 LM Studio server ${action === 'start' ? 'started' : 'stopped'}`)
  return { success: true }
}

// ---- local-disk introspection / import (migrate fast-path) ------------------

const dirExists = (p) => stat(p).then((s) => s.isDirectory()).catch(() => false)

/** LM Studio's models root — first of the two known locations that exists. */
async function getModelsDir() {
  const candidates = [
    process.env.LM_STUDIO_MODELS_DIR,
    join(homedir(), '.lmstudio', 'models'),
    join(homedir(), '.cache', 'lm-studio', 'models')
  ].filter(Boolean)
  for (const dir of candidates) {
    if (await dirExists(dir)) return dir
  }
  return candidates[1] // sensible default even if it doesn't exist yet
}

/**
 * Enumerate the exact `<publisher>/<repo>` folders LM Studio can delete.
 * This is disk-native so a stopped daemon does not erase downloaded inventory,
 * and one row always represents the whole repo folder (including every quant).
 */
async function listStoredModels() {
  const modelsDir = await getModelsDir()
  const root = await stat(modelsDir).then((entry) => entry.isDirectory(), (err) => {
    if (err?.code === 'ENOENT') return false
    throw err
  })
  if (!root) return []

  const publishers = (await readdir(modelsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  const nested = await Promise.all(publishers.map(async (publisher) => {
    const publisherDir = join(modelsDir, publisher.name)
    const repos = (await readdir(publisherDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
    return Promise.all(repos.map(async (repo) => {
      const id = `${publisher.name}/${repo.name}`
      return {
        id,
        publisher: publisher.name,
        name: repo.name,
        size: await dirSize(join(publisherDir, repo.name), { strict: true }),
      }
    }))
  }))
  return nested.flat().sort((a, b) => b.size - a.size)
}

const normalizeRepoKey = (s) => String(s || '')
  .split('/').pop()
  .trim()
  .toLowerCase()
  .replace(/[-.]gguf$/i, '')
  .replace(/[-.]mlx[-.].*$/i, '')

function modelIdsReferToSameRepo(left, right) {
  const leftKey = normalizeRepoKey(left)
  const rightKey = normalizeRepoKey(right)
  return Boolean(leftKey && rightKey && leftKey === rightKey)
}

// `lms get` skips files that already exist, so a publisher replacing a GGUF in
// place (Unsloth Dynamic 3.0, etc.) never lands unless we evict first. Strip the
// backend-specific install wrapper down to the on-disk `<publisher>/<repo>` id.
function repoIdFromInstallId(modelId) {
  return String(modelId || '')
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/^hf\.co\//i, '')
    .replace(/@[^/@]+$/, '')
    .replace(/:([^:/]+)$/, '')
}

function quantFromInstallId(modelId) {
  const s = String(modelId || '').trim()
  const at = s.match(/@([^/@]+)$/)
  if (at) return at[1]
  const colon = s.match(/:([^:/]+)$/)
  return colon ? colon[1] : null
}

function trailingGgufQuant(filename) {
  const stem = String(filename || '').split('/').pop()
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
  // Same trailing-token rule as huggingFaceCatalog.quantFromFilename: UD-Q4_K_M
  // and Q4_K_M are distinct, so a suffix match would evict the wrong file.
  const match = stem.match(/(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16))$/i)
  return match?.[1] || null
}

function ggufMatchesQuant(filename, quant) {
  const parsed = trailingGgufQuant(filename)
  return parsed != null && parsed.toLowerCase() === String(quant).toLowerCase()
}

/**
 * Remove on-disk LM Studio files so a subsequent `lms get` actually re-fetches
 * them. A quant-tagged id (`repo@UD-Q4_K_M` / `hf.co/repo:UD-Q4_K_M`) evicts
 * only matching GGUFs and leaves sibling quants alone. A bare repo id fails —
 * we cannot name the file to replace, and wiping the folder would drop sibling
 * quants. Missing files are success (`missing: true`) so a first-time install
 * can share this path. Ambiguous ids refuse, same as deleteModel.
 * @returns {Promise<{ success: boolean, modelId: string, missing?: boolean, error?: string }>}
 */
async function evictDownloadedQuant(modelId) {
  const repoId = repoIdFromInstallId(modelId)
  const quant = quantFromInstallId(modelId)
  // A bare `publisher/repo` cannot name the GGUF to replace. Evicting the whole
  // folder would drop sibling quants; leaving files in place makes `lms get`
  // skip them and report a fake success. Callers must pass `repo@QUANT`.
  if (!quant) {
    return {
      success: false,
      error: 'Redownload needs a quantization tag (e.g. repo@UD-Q4_K_M). A bare repo id would skip existing GGUFs without replacing them.',
      modelId
    }
  }
  const modelsDir = await getModelsDir()
  const matches = await findDeletableModelDirs(modelsDir, repoId)
  if (matches === null) return { success: false, error: `Invalid model id "${modelId}".`, modelId }
  if (matches.length === 0) return { success: true, missing: true, modelId }
  if (matches.length > 1) {
    return { success: false, error: `Ambiguous model id "${modelId}" matches ${matches.length} folders — redownload by exact "publisher/repo".`, modelId }
  }
  const dir = matches[0]
  if (!isModelLeafDir(modelsDir, dir)) {
    return { success: false, error: `Refusing to evict "${dir}" — not a model folder under ${modelsDir}.`, modelId }
  }

  if (await checkLMStudioAvailable()) await unloadModel(modelId).catch(() => {})

  const files = await readdir(dir)
  const targets = files.filter((name) => /\.gguf$/i.test(name) && !/mmproj/i.test(name) && ggufMatchesQuant(name, quant))
  if (targets.length === 0) return { success: true, missing: true, modelId }
  for (const name of targets) {
    await rm(join(dir, name), { force: true })
  }
  resetCache()
  console.log(`🗑️ LM Studio evicted ${targets.length} ${quant} file(s) for redownload: ${modelId}`)
  return { success: true, modelId }
}

async function findModelDir(modelsDir, modelId) {
  // Reject `.`/`..` traversal segments before joining — mirrors the stricter
  // findDeletableModelDirs guard so the read path can't resolve outside the
  // models tree either (trusted ids today, but defense-in-depth parity).
  const segments = String(modelId || '').split('/').map((s) => s.trim()).filter(Boolean)
  if (segments.some((s) => s === '.' || s === '..')) return null
  const direct = join(modelsDir, ...segments)
  if (await dirExists(direct)) return direct

  const wanted = normalizeRepoKey(modelId)
  if (!wanted) return null
  const publishers = await readdir(modelsDir).catch(() => [])
  for (const publisher of publishers) {
    const publisherDir = join(modelsDir, publisher)
    if (!(await dirExists(publisherDir))) continue
    const repos = await readdir(publisherDir).catch(() => [])
    const repo = repos.find((name) => normalizeRepoKey(name) === wanted)
    if (repo) return join(publisherDir, repo)
  }
  return null
}

/**
 * Locate an installed LM Studio model's files on disk (no network). The model
 * id usually maps directly onto the `<publisher>/<repo>` folder, but LM Studio
 * can report an API id that differs from the downloaded repo. Fall back to a
 * normalized repo-name scan so `openai/gpt-oss-20b` can still resolve the local
 * `lmstudio-community/gpt-oss-20b-GGUF` folder. MLX models (safetensors, no
 * GGUF) return `{ isMlx: true, ggufPath: null }` so the caller routes them to
 * re-pull instead of a (impossible) file copy.
 * @returns {Promise<{ ggufPath: string|null, projectorPath: string|null, isMlx: boolean, isSharded: boolean }|null>}
 */
async function resolveLocalModel(modelId) {
  const modelsDir = await getModelsDir()
  const dir = await findModelDir(modelsDir, modelId)
  if (!dir) return null
  const files = await readdir(dir).catch(() => [])
  if (dirIsMlx(files)) return { ggufPath: null, projectorPath: null, isMlx: true, isSharded: false }
  const primary = selectPrimaryGguf(files)
  if (!primary) return null
  const projector = selectProjectorGguf(files)
  return {
    ggufPath: join(dir, primary),
    projectorPath: projector ? join(dir, projector) : null,
    isMlx: false,
    isSharded: isShardedGguf(primary)
  }
}

/**
 * Resolve which on-disk folder(s) a delete request maps to. Unlike
 * resolveLocalModel (a best-effort fuzzy first-match for READS), deletion is
 * destructive (`rm -rf`), so this is deliberately stricter: it only ever returns
 * concrete `<publisher>/<repo>` folders (LM Studio's invariant layout), rejects
 * `.`/`..` traversal segments, and returns ALL normalized-scan matches so an
 * ambiguous id (e.g. a `-GGUF` and a `-MLX-*` variant that normalize to the same
 * key) can refuse instead of guessing the wrong one.
 * @returns {Promise<string[]|null>} matched dirs, or null for an invalid id
 */
async function findDeletableModelDirs(modelsDir, modelId) {
  const segments = String(modelId || '').split('/').map((s) => s.trim()).filter(Boolean)
  if (segments.some((s) => s === '.' || s === '..')) return null
  // Exact `<publisher>/<repo>` match takes precedence over the fuzzy scan.
  if (segments.length === 2) {
    const direct = join(modelsDir, segments[0], segments[1])
    if (await dirExists(direct)) return [direct]
  }
  const wanted = normalizeRepoKey(modelId)
  if (!wanted) return []
  const matches = []
  const publishers = await readdir(modelsDir).catch(() => [])
  for (const publisher of publishers) {
    const publisherDir = join(modelsDir, publisher)
    if (!(await dirExists(publisherDir))) continue
    const repos = await readdir(publisherDir).catch(() => [])
    for (const name of repos) {
      const repoDir = join(publisherDir, name)
      if (normalizeRepoKey(name) === wanted && await dirExists(repoDir)) matches.push(repoDir)
    }
  }
  return matches
}

/** True only when `dir` is a `<publisher>/<repo>` folder strictly under modelsDir. */
function isModelLeafDir(modelsDir, dir) {
  const rel = relative(resolve(modelsDir), resolve(dir))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  return rel.split(sep).length === 2
}

/**
 * Delete an installed LM Studio model. The `lms` CLI has no remove command, and
 * LM Studio's REST API exposes no delete — so we remove the model's on-disk
 * `<publisher>/<repo>/` folder directly and prune the publisher dir if empty.
 * Best-effort unloads the model first so the running app isn't left serving
 * files that no longer exist.
 * @returns {Promise<{ success: boolean, modelId: string, error?: string }>}
 */
async function deleteModel(modelId) {
  const modelsDir = await getModelsDir()
  const matches = await findDeletableModelDirs(modelsDir, modelId)
  if (matches === null) return { success: false, error: `Invalid model id "${modelId}".`, modelId }
  if (matches.length === 0) {
    return { success: false, error: `Model files not found on disk for "${modelId}".`, modelId }
  }
  if (matches.length > 1) {
    return { success: false, error: `Ambiguous model id "${modelId}" matches ${matches.length} folders — delete by exact "publisher/repo".`, modelId }
  }
  const dir = matches[0]
  // Defense-in-depth: never rm the models root, a publisher dir, or anything
  // outside modelsDir — only a concrete `<publisher>/<repo>` leaf.
  if (!isModelLeafDir(modelsDir, dir)) {
    return { success: false, error: `Refusing to delete "${dir}" — not a model folder under ${modelsDir}.`, modelId }
  }
  // Unload first if the app is up and holding it (no-op/harmless otherwise).
  if (await checkLMStudioAvailable()) await unloadModel(modelId).catch(() => {})
  const removed = await rm(dir, { recursive: true, force: true })
    .then(() => ({ ok: true })).catch((err) => ({ _err: err.message }))
  resetCache() // disk may have changed even on a partial failure — re-list fresh
  if (removed._err) return { success: false, error: removed._err, modelId }
  // Prune the now-empty publisher dir (rmdir fails harmlessly if not empty).
  await rmdir(join(dir, '..')).catch(() => {})
  console.log(`🗑️ LM Studio deleted: ${modelId} (${dir})`)
  cosEvents.emit('lmstudio:modelDeleted', { modelId })
  return { success: true, modelId }
}

/**
 * Place a local GGUF into LM Studio's model tree (no download). LM Studio indexes
 * loose GGUF files dropped under `<publisher>/<repo>/` on its next scan. In `link`
 * mode the file is hardlinked (shared on disk with the source backend's copy);
 * `copy` mode duplicates it. Link falls back to copy on any error (notably EXDEV
 * across filesystems).
 * @param {{ lmstudioId: string, ggufPath: string, projectorPath?: string|null, mode?: 'link'|'copy' }} args
 * @returns {Promise<{ success: boolean, modelId?: string, linked?: boolean, error?: string }>}
 */
async function importModelFromGguf({ lmstudioId, ggufPath, projectorPath, mode = 'copy' }) {
  const modelsDir = await getModelsDir()
  const { publisher, repo } = lmStudioPublisherRepo(lmstudioId)
  const destDir = join(modelsDir, publisher, repo)
  // Report the actual on-disk id (sanitized) rather than the raw input, so
  // migrate results / follow-up ops match where the file really landed.
  const resolvedId = `${publisher}/${repo}`
  // Hardlink when asked; fall back to copy on any link error. Returns whether
  // the file ended up hardlinked (so the caller can report disk-sharing).
  const place = async (src, dest) => {
    if (mode === 'link' && await link(src, dest).then(() => true).catch(() => false)) return true
    await copyFile(src, dest)
    return false
  }
  let linked = false
  const r = await ensureDir(destDir)
    .then(async () => {
      const base = basename(ggufPath)
      const destName = /\.gguf$/i.test(base) ? base : `${repo}.gguf`
      linked = await place(ggufPath, join(destDir, destName))
      if (projectorPath) {
        const projBase = basename(projectorPath)
        await place(projectorPath, join(destDir, /\.gguf$/i.test(projBase) ? projBase : `${repo}-mmproj.gguf`))
      }
    })
    .then(() => ({ ok: true }))
    .catch((err) => ({ _err: err.message }))
  if (r._err) return { success: false, error: r._err, modelId: resolvedId }
  resetCache()
  console.log(`📦 LM Studio import (${linked ? 'hardlink' : 'copy'}): ${resolvedId} ← ${ggufPath}`)
  return { success: true, modelId: resolvedId, linked }
}

export {
  checkLMStudioAvailable,
  controlServer as controlLmStudioServer,
  getLoadedModels,
  getLoadedModelsAt,
  getLastLoadedModelsError,
  getAvailableModels,
  downloadModel,
  loadModel,
  loadModelWithArgs,
  unloadModel,
  getRecommendedThinkingModel,
  quickCompletion,
  getEmbeddings,
  getStatus,
  getBaseUrl,
  updateConfig,
  resetCache,
  isAppInstalled,
  getLastListError,
  getModelsDir,
  listStoredModels,
  modelIdsReferToSameRepo,
  resolveLocalModel,
  importModelFromGguf,
  deleteModel,
  evictDownloadedQuant,
  DEFAULT_CONFIG
}
