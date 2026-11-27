/** Reads and updates Ollama model inventory, residency and embeddings, and presents runtime status. */

import { invalidateModelObservation } from '../modelObservation.js'
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js'
import { readResponseJson } from '../../lib/readResponseJson.js'
import { isEmbeddingModel } from '../../lib/localModelHeuristics.js'
import { OLLAMA_AGENT_MIN_CONTEXT } from '../../lib/ollamaContext.js'
import { getRuntimeContextLength } from './ollamaContextWindow.js'
import {
  checkOllamaAvailable,
  getAppliedContextLength,
  getAvailabilityErrors,
  getBaseUrl,
  getServiceStatus,
  getVersion,
  ollamaRequest,
  ollamaRequestAt,
} from './ollamaDaemon.js'
import { bustInstalledModelsCache, modelListCache } from './ollamaModelCache.js'

/**
 * List installed models from /api/tags.
 * @returns {Promise<Array<{ id, name, size, family, params, quantization, modifiedAt }>>}
 */
async function getInstalledModels(forceRefresh = false) {
  if (!forceRefresh && modelListCache.installedModels !== null) return modelListCache.installedModels
  if (!(await checkOllamaAvailable())) {
    modelListCache.lastInstalledModelsError = getAvailabilityErrors().lastError || 'Ollama is unavailable'
    return []
  }

  const data = await ollamaRequest('/api/tags').catch(() => null)
  if (!data?.models) {
    // Cache the empty result so a /api/tags failure while Ollama stays up for
    // /api/version (the availability probe) doesn't re-hit on every catalog
    // keystroke; a forceRefresh (status refresh / pull / delete) recovers it.
    modelListCache.lastInstalledModelsError = 'Ollama model list (/api/tags) returned no data'
    modelListCache.installedModels = []
    return modelListCache.installedModels
  }
  modelListCache.lastInstalledModelsError = null

  modelListCache.installedModels = data.models.map((m) => ({
    id: m.name || m.model,
    name: m.name || m.model,
    size: m.size ?? null,
    family: m.details?.family || null,
    params: m.details?.parameter_size || null,
    quantization: m.details?.quantization_level || null,
    modifiedAt: m.modified_at || null
  }))
  return modelListCache.installedModels
}

// A model's native context length and capability set are immutable for a given
// build, but Ollama's /api/tags listing carries neither — only /api/show does
// (one POST per model). Cache name → { contextLength, capabilities } so
// enriching the model list on every status poll doesn't re-hit /api/show.
// Busted alongside installedModels on delete (a deleted name shouldn't linger),
// but a re-pull of the same name yields the same details so we don't bust on pull.
const modelDetailsCache = new Map() // name -> { contextLength: number|null, capabilities: string[]|null }

/**
 * Fetch a model's native details (max context length + capability set) via
 * /api/show. Ollama nests context under `model_info["<arch>.context_length"]`
 * (the arch prefix varies by family so we scan for the suffix) and reports a
 * top-level `capabilities` array (`["completion","vision","tools",…]`). Cached;
 * returns nulls/null when the request fails, and nulls/empty when the daemon
 * answers without reporting a field. The distinction keeps a transient probe
 * failure from looking like an authoritative empty capability set.
 * @param {string} name
 * @returns {Promise<{ contextLength: number|null, capabilities: string[]|null }>}
 */
async function getModelDetails(name, requestOptions = {}) {
  const miss = { contextLength: null, capabilities: null }
  if (!name) return miss
  if (modelDetailsCache.has(name)) return modelDetailsCache.get(name)
  // /api/show documents the id under `model`; current Ollama also accepts the
  // legacy `name`, so send both (extra fields are ignored) for cross-version safety.
  const data = await ollamaRequest('/api/show', { ...requestOptions, method: 'POST', body: JSON.stringify({ model: name, name }) }).catch(() => null)
  // A transient /api/show failure must NOT be cached — that would pin the model
  // with no context label / wrong vision flag until restart. Only cache when the
  // daemon actually answered; a present-but-missing field legitimately caches
  // its empty default. Mirrors the null-vs-empty sentinel rule used by the
  // installed-model caches.
  if (!data) return miss
  let contextLength = null
  for (const [key, value] of Object.entries(data.model_info || {})) {
    if (key.endsWith('.context_length') && Number.isFinite(value)) { contextLength = value; break }
  }
  const details = {
    contextLength,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    // Layout keys for context-memory planning (lib/contextMemoryPlan.js).
    modelInfo: data.model_info && typeof data.model_info === 'object' ? data.model_info : null,
    runner: typeof data.details?.runner === 'string' ? data.details.runner : null
  }
  modelDetailsCache.set(name, details)
  return details
}

/**
 * A model's capability set (`["completion","vision","tools",…]`) from /api/show.
 * Lets vision detection see capabilities that the /api/tags id can't reveal —
 * e.g. a vision-capable MoE like `qwen3.6:35b` whose id has no `vl`/`vision`
 * token. Cached; returns `null` when the per-model probe fails and `[]` when
 * the daemon answers without reporting capabilities.
 * @param {string} name
 * @returns {Promise<string[]|null>}
 */
async function getModelCapabilities(name, requestOptions = {}) {
  return (await getModelDetails(name, requestOptions)).capabilities
}

/**
 * A model's `model_info` layout keys and runner (`mlx` or null) from /api/show, cached with the other details.
 * @param {string} name
 * @returns {Promise<{ modelInfo: object|null, runner: string|null }>}
 */
async function getModelLayout(name, requestOptions = {}) {
  const { modelInfo = null, runner = null } = await getModelDetails(name, requestOptions)
  return { modelInfo, runner }
}

/** Add `contextLength` + `capabilities` to each model (parallel, cached). */
async function enrichWithModelDetails(models) {
  return Promise.all(models.map(async (m) => {
    const { contextLength, capabilities } = await getModelDetails(m.id || m.name)
    return { ...m, contextLength, capabilities }
  }))
}

/**
 * Get embeddings for `text` from a loaded Ollama model.
 *
 * Mirrors lmStudioManager.getEmbeddings shape — returns
 * `{ success, embedding, model, dimensions }` so server/services/embeddings.js
 * can route either backend through one interface.
 *
 * Ollama 0.2+ exposes `POST /api/embed` with `{ model, input }` → `{ embeddings: [[...]] }`.
 * Older daemons only have `POST /api/embeddings` with `{ model, prompt }` → `{ embedding: [...] }`.
 * We try the modern endpoint first, fall back on a 404/400.
 *
 * Auto-discovery: when `options.model` is omitted, scan installed models
 * for a name matching a known embedding-model heuristic (embed/bge/nomic/mxbai)
 * since Ollama tags don't carry a "type=embedding" flag.
 */
async function getEmbeddings(text, options = {}) {
  const available = await checkOllamaAvailable()
  if (!available) {
    return { success: false, error: 'Ollama not available' }
  }

  let model = options.model
  if (!model) {
    const models = await getInstalledModels()
    const guess = models.find((m) => isEmbeddingModel(m.id || m.name || ''))
    if (!guess) {
      return { success: false, error: 'No embedding model installed in Ollama' }
    }
    model = guess.id || guess.name
  }

  const tryEndpoint = async (endpoint, body) => {
    const response = await fetchWithTimeout(`${getBaseUrl()}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, options.timeout ?? 30_000).catch((err) => ({ _err: err.message }))
    if (response._err) return { ok: false, error: response._err }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: errBody.slice(0, 200) }
    }
    return { ok: true, data: await readResponseJson(response) }
  }

  // Modern endpoint: `/api/embed` returns `{ embeddings: [[...]] }`
  let result = await tryEndpoint('/api/embed', { model, input: text })
  let embedding = result.ok ? (result.data?.embeddings?.[0] || []) : null

  // Fallback for older Ollama: `/api/embeddings` returns `{ embedding: [...] }`
  if (!result.ok || !embedding?.length) {
    const fallback = await tryEndpoint('/api/embeddings', { model, prompt: text })
    if (!fallback.ok) {
      return { success: false, error: result.error || fallback.error, model }
    }
    embedding = fallback.data?.embedding || []
  }

  return {
    success: true,
    embedding,
    model,
    dimensions: embedding.length
  }
}

/**
 * Read residency from a specific provider endpoint without touching the global
 * manager's availability cache or error state.
 * @returns {Promise<{models:Array<{id,name,size,sizeVram,expiresAt}>,error:string|null}>}
 */
async function getLoadedModelsAt(baseUrl, options = {}) {
  const data = await ollamaRequestAt(baseUrl, '/api/ps', options).catch((err) => ({ _err: err.message }))
  if (!Array.isArray(data?.models)) {
    return { models: [], error: data?._err || 'Ollama residency endpoint returned no model list' }
  }
  return {
    models: data.models.map((m) => ({
      id: m.name || m.model,
      name: m.name || m.model,
      size: m.size ?? null,
      sizeVram: m.size_vram ?? null,
      expiresAt: m.expires_at || null
    })),
    error: null
  }
}

/**
 * List models currently loaded into VRAM/unified memory on the configured
 * Ollama daemon. Distinct from getInstalledModels(): a model on disk doesn't
 * occupy memory until it's referenced by a request.
 * @returns {Promise<Array<{ id, name, size, sizeVram, expiresAt }>>}
 */
async function getLoadedModels(options = {}) {
  if (!(await checkOllamaAvailable())) {
    modelListCache.lastLoadedModelsError = getAvailabilityErrors().lastError || 'Ollama is unavailable'
    return []
  }
  const result = await getLoadedModelsAt(getBaseUrl(), options)
  modelListCache.lastLoadedModelsError = result.error
  return result.models
}

/** Last `/api/tags` error (null only after a trustworthy installed list). */
function getLastInstalledModelsError() {
  return modelListCache.lastInstalledModelsError
}

/** Last `/api/ps` error (null only after a trustworthy residency list). */
function getLastLoadedModelsError() {
  return modelListCache.lastLoadedModelsError
}

/**
 * Force Ollama to evict a specific model from memory immediately.
 * Uses the documented `keep_alive: 0` trick — issuing any generate/chat
 * request with keep_alive=0 expires the model the moment the request
 * resolves. We send an empty prompt so no tokens are generated.
 *
 * Precondition: only fires the evict when the model is currently resident
 * per `/api/ps`. Without the check, `/api/generate` against a non-loaded
 * model triggers Ollama to LOAD it from disk (potentially many GB) just
 * to immediately evict — a thrash/DoS-amplification footgun reachable
 * from any LAN client once `/api/local-llm/unload` is wired.
 * @returns {Promise<{ unloaded: true, model: string } | { unloaded: false, reason: string }>}
 */
async function unloadModel(modelName) {
  if (typeof modelName !== 'string' || modelName.length === 0) {
    return { unloaded: false, reason: 'missing model name' }
  }
  if (!(await checkOllamaAvailable())) {
    return { unloaded: false, reason: 'Ollama unreachable' }
  }
  const loaded = await getLoadedModels()
  if (getLastLoadedModelsError()) {
    return { unloaded: false, reason: 'Could not verify whether the model is loaded' }
  }
  if (!loaded.some((m) => m.id === modelName || m.name === modelName)) {
    return { unloaded: false, reason: 'not loaded' }
  }
  // Native fetch does NOT auto-stringify object bodies — pass JSON.stringify
  // so the wire body is valid JSON, not "[object Object]".
  const body = JSON.stringify({ model: modelName, prompt: '', keep_alive: 0, stream: false })
  const result = await ollamaRequest('/api/generate', { method: 'POST', body }).catch((err) => ({ _err: err }))
  if (result && result._err) {
    return { unloaded: false, reason: result._err.message || 'request failed' }
  }
  console.log(`🧹 ollama: unloaded ${modelName} (keep_alive=0)`)
  invalidateModelObservation('loaded-models')
  return { unloaded: true, model: modelName }
}

/**
 * Make `modelName` resident so the next request doesn't pay a cold load.
 * The inverse of `unloadModel`: an empty-prompt `/api/generate` with a
 * non-zero `keep_alive` loads the weights and returns without generating
 * tokens (Ollama answers with `done_reason: "load"`).
 *
 * Unlike the unload path there is deliberately NO "already resident" guard
 * here — the caller checks `/api/ps` first because re-warming is merely
 * wasteful, whereas an unguarded UNLOAD-shaped request against a cold model
 * would load many GB just to evict it.
 * @returns {Promise<{ warmed: true, model: string } | { warmed: false, reason: string }>}
 */
async function warmModel(modelName, keepAlive = '30m') {
  if (typeof modelName !== 'string' || modelName.length === 0) {
    return { warmed: false, reason: 'missing model name' }
  }
  if (!(await checkOllamaAvailable())) {
    return { warmed: false, reason: 'Ollama unreachable' }
  }
  const body = JSON.stringify({ model: modelName, prompt: '', keep_alive: keepAlive, stream: false })
  const result = await ollamaRequest('/api/generate', { method: 'POST', body }).catch((err) => ({ _err: err }))
  if (result && result._err) {
    return { warmed: false, reason: result._err.message || 'request failed' }
  }
  return { warmed: true, model: modelName }
}

/**
 * Delete an installed model (DELETE /api/delete).
 */
async function deleteModel(modelId) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  const result = await ollamaRequest('/api/delete', {
    method: 'DELETE',
    body: JSON.stringify({ name: modelId }),
    timeout: 15_000
  }).then(() => ({ ok: true })).catch((err) => ({ _err: err.message }))

  if (result._err) {
    return { success: false, error: result._err, modelId }
  }
  bustInstalledModelsCache()
  modelDetailsCache.delete(modelId)
  console.log(`🗑️ Ollama deleted: ${modelId}`)
  return { success: true, modelId }
}

/**
 * Aggregate status for the unified local-LLM UI.
 */
async function getStatus(forceRefresh = false) {
  const available = await checkOllamaAvailable(forceRefresh)
  const baseModels = available ? await getInstalledModels(true) : []
  // Enrich with native context length + capabilities (cached /api/show per
  // model) so the model cards + selector dropdowns can show each model's window
  // and so vision-capable models are detected from their reported capabilities.
  const models = available ? await enrichWithModelDetails(baseModels) : baseModels
  const service = await getServiceStatus().catch(() => ({ supported: false, manager: null, running: false, runAtStartup: false, status: null }))
  return {
    available,
    baseUrl: getBaseUrl(),
    version: available ? await getVersion() : null,
    modelCount: models.length,
    models,
    service,
    // The window resident models were actually loaded at (null when nothing is
    // resident — Ollama has not committed to one yet), plus the window PortOS
    // handed this daemon. Surfaced so the Local LLM page can show why an agent
    // harness overflowed at 32K on a 256K-capable model.
    contextLength: {
      runtime: available ? await getRuntimeContextLength().catch(() => null) : null,
      applied: available ? getAppliedContextLength() : null,
      agentMinimum: OLLAMA_AGENT_MIN_CONTEXT
    },
    ...getAvailabilityErrors()
  }
}

export {
  deleteModel,
  getEmbeddings,
  getInstalledModels,
  getLastInstalledModelsError,
  getLastLoadedModelsError,
  getLoadedModels,
  getLoadedModelsAt,
  getModelCapabilities,
  getModelLayout,
  getStatus,
  unloadModel,
  warmModel
}
