/**
 * LM Studio Manager Service
 *
 * Manages local LM Studio models for free local thinking.
 * Provides model discovery, loading, unloading, and downloading.
 */

import { homedir } from 'os'
import { join, basename, resolve, relative, isAbsolute, sep } from 'path'
import { existsSync } from 'fs'
import { readdir, stat, mkdir, copyFile, link, rm, rmdir } from 'fs/promises'
import { cosEvents } from './cosEvents.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import {
  dirIsMlx, selectPrimaryGguf, selectProjectorGguf, isShardedGguf, lmStudioPublisherRepo
} from '../lib/localLlmDisk.js'

const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// Availability probe is short — if the local server is down we'd rather fail
// fast and degrade to "no LM Studio" than block 30s on every cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000

// Default LM Studio configuration
const DEFAULT_CONFIG = {
  baseUrl: (process.env.LM_STUDIO_URL || 'http://localhost:1234').replace(/\/+$/, '').replace(/\/v1$/, ''),
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
// null = not yet fetched; any array (even empty) = a cached result. Lets the
// catalog-overlay path (queried per keystroke) reuse the list instead of
// re-hitting /api/v0/models each time. Busted to null by resetCache().
let availableModels = null
// Last error from the model-LIST call (/api/v0/models), distinct from the
// availability probe (/v1/models): LM Studio can answer the probe yet fail the
// list, so this lets callers tell "0 models" from "couldn't list models".
let lastListError = null
let lastCheckAt = null

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
async function lmStudioRequest(endpoint, options = {}) {
  const url = `${config.baseUrl}${endpoint}`
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

/**
 * Check if LM Studio is available
 * @returns {Promise<boolean>} - True if available
 */
async function checkLMStudioAvailable() {
  const now = Date.now()

  // Use cached result if recent (within AVAILABILITY_CACHE_TTL_MS)
  if (lastCheckAt && now - lastCheckAt < AVAILABILITY_CACHE_TTL_MS && isAvailable !== null) {
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
 * Get currently loaded models
 * @param {boolean} forceRefresh - Force refresh from API
 * @returns {Promise<Array>} - Loaded models
 */
async function getLoadedModels(forceRefresh = false) {
  if (!forceRefresh && loadedModels !== null) {
    return loadedModels
  }

  const available = await checkLMStudioAvailable()
  if (!available) {
    // Don't cache — unavailable is transient, so the next call re-probes.
    return []
  }

  // Use native REST API for richer model info (type, state, architecture)
  const nativeModels = await lmStudioRequest('/api/v0/models').catch(() => null)
  if (nativeModels?.data) {
    loadedModels = nativeModels.data
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
      }))
    return loadedModels
  }

  // Fallback to OpenAI-compat endpoint
  const response = await lmStudioRequest('/v1/models').catch(() => null)
  if (response?.data) {
    loadedModels = response.data.map(model => ({
      id: model.id,
      object: model.object,
      created: model.created,
      ownedBy: model.owned_by
    }))
    return loadedModels
  }

  // Both list endpoints failed — return empty WITHOUT caching (loadedModels
  // stays null) so the next call retries instead of pinning a bogus empty.
  return []
}

/**
 * Get all downloaded models (loaded and not-loaded).
 * @param {boolean} [forceRefresh] - bypass the cache (callers that read live
 *   per-model `state`, e.g. embedding-model discovery, should force).
 * @returns {Promise<Array>} - All downloaded models with state info
 */
async function getAvailableModels(forceRefresh = false) {
  if (!forceRefresh && availableModels !== null) return availableModels
  const available = await checkLMStudioAvailable()
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

const normalizeRepoKey = (s) => String(s || '')
  .split('/').pop()
  .trim()
  .toLowerCase()
  .replace(/[-.]gguf$/i, '')
  .replace(/[-.]mlx[-.].*$/i, '')

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
  const r = await mkdir(destDir, { recursive: true })
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
  getLoadedModels,
  getAvailableModels,
  downloadModel,
  loadModel,
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
  resolveLocalModel,
  importModelFromGguf,
  deleteModel,
  DEFAULT_CONFIG
}
