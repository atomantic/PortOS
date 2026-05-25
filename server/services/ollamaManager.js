/**
 * Ollama Manager Service
 *
 * Manages a local Ollama install over its native HTTP API (default
 * http://localhost:11434). Mirrors lmStudioManager.js so server/services/
 * localLlm.js can treat both backends through one shape: availability probe,
 * installed-model listing, streaming pulls, and deletes.
 *
 * Ollama's REST surface (not OpenAI-compatible):
 *   GET    /api/version  → { version }
 *   GET    /api/tags     → { models: [{ name, size, details, modified_at }] }
 *   GET    /api/ps       → { models: [...] }  (loaded into memory)
 *   POST   /api/pull     → NDJSON stream { status, total?, completed? }
 *   DELETE /api/delete   → { name }
 */

import { homedir } from 'os'
import { join } from 'path'
import { readdir, stat } from 'fs/promises'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readJSONFile } from '../lib/fileUtils.js'
import {
  parseOllamaManifest, parseOllamaModelRef, ollamaManifestRelPath, digestToBlobFilename, buildModelfile
} from '../lib/localLlmDisk.js'

const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// Short probe — degrade to "no Ollama" fast rather than block on a cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000

const DEFAULT_CONFIG = {
  // Ollama uses OLLAMA_HOST (host:port, no scheme) by convention; also accept
  // an explicit OLLAMA_URL. Normalize to a scheme + no trailing slash + no /v1.
  baseUrl: normalizeBaseUrl(process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434'),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`
  return url || 'http://localhost:11434'
}

let config = { ...DEFAULT_CONFIG }
let isAvailable = null
// null = not yet fetched; an array (even empty) = a cached fetch result. Using a
// null sentinel (not `.length`) lets a genuine "0 models installed" result cache
// too — otherwise the catalog-overlay path re-hits /api/tags on every keystroke.
let installedModels = null
let lastCheckAt = null

const status = { lastError: null, lastSuccessAt: null, consecutiveErrors: 0 }

async function ollamaRequest(endpoint, options = {}) {
  const { timeout, headers, ...rest } = options
  const response = await fetchWithTimeout(`${config.baseUrl}${endpoint}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers }
  }, timeout ?? config.timeout)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  return response.json()
}

/**
 * Check if Ollama is reachable (cached for AVAILABILITY_CACHE_TTL_MS).
 */
async function checkOllamaAvailable() {
  const now = Date.now()
  if (lastCheckAt && now - lastCheckAt < AVAILABILITY_CACHE_TTL_MS && isAvailable !== null) {
    return isAvailable
  }
  try {
    await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS })
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
 * List installed models from /api/tags.
 * @returns {Promise<Array<{ id, name, size, family, params, quantization, modifiedAt }>>}
 */
async function getInstalledModels(forceRefresh = false) {
  if (!forceRefresh && installedModels !== null) return installedModels
  if (!(await checkOllamaAvailable())) return []

  const data = await ollamaRequest('/api/tags').catch(() => null)
  if (!data?.models) {
    // Cache the empty result so a /api/tags failure while Ollama stays up for
    // /api/version (the availability probe) doesn't re-hit on every catalog
    // keystroke; a forceRefresh (status refresh / pull / delete) recovers it.
    installedModels = []
    return installedModels
  }

  installedModels = data.models.map((m) => ({
    id: m.name || m.model,
    name: m.name || m.model,
    size: m.size ?? null,
    family: m.details?.family || null,
    params: m.details?.parameter_size || null,
    quantization: m.details?.quantization_level || null,
    modifiedAt: m.modified_at || null
  }))
  return installedModels
}

async function getVersion() {
  const data = await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS }).catch(() => null)
  return data?.version || null
}

/**
 * Pull a model, streaming progress. Resolves once the pull finishes.
 * @param {string} modelId
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number }) => void} [onProgress]
 * @returns {Promise<{ success: boolean, modelId: string, error?: string }>}
 */
async function pullModel(modelId, onProgress) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  console.log(`📥 Ollama pull: ${modelId}`)

  // No timeout — multi-GB pulls take minutes; the stream is the lifecycle.
  const response = await fetchWithTimeout(`${config.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: true })
  }, 0).catch((err) => ({ _err: err.message }))

  if (response._err || !response.ok || !response.body) {
    const error = response._err || `pull failed: ${response.status} ${response.statusText}`
    console.error(`⚠️ Ollama pull failed for ${modelId}: ${error}`)
    return { success: false, error, modelId }
  }

  const lastError = await streamNdjson(response, (frame) => {
    if (typeof onProgress === 'function') {
      const percent = frame.total > 0 && frame.completed >= 0
        ? Math.round((frame.completed / frame.total) * 100)
        : null
      onProgress({ status: frame.status || '', percent, completed: frame.completed, total: frame.total })
    }
  })

  if (lastError) {
    return { success: false, error: lastError, modelId }
  }
  installedModels = null  // bust cache so the new model shows on next list
  console.log(`✅ Ollama pull complete: ${modelId}`)
  return { success: true, modelId }
}

/**
 * Consume an Ollama NDJSON progress stream (used by /api/pull and /api/create).
 * Returns the last `{ error }` seen, or null on a clean stream. Reads via
 * getReader() to match the codebase's streaming convention; try/finally releases
 * the reader even if a read rejects mid-stream (avoids leaking the connection).
 * Flushes the decoder + trailing buffer so a final frame that wasn't newline-
 * terminated (notably a terminal `{"error":...}`) isn't silently dropped.
 * @param {Response} response - a fetch Response with a readable body
 * @param {(frame: object) => void} [onFrame]
 * @returns {Promise<string|null>} last error message, or null
 */
async function streamNdjson(response, onFrame) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastError = null

  const handleFrame = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const frame = safeParse(trimmed)
    if (!frame) return
    if (frame.error) lastError = frame.error
    if (typeof onFrame === 'function') onFrame(frame)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handleFrame(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    buffer += decoder.decode()
    handleFrame(buffer)
  } finally {
    reader.releaseLock()
  }
  return lastError
}

function safeParse(line) {
  try { return JSON.parse(line) } catch { return null }
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
  installedModels = null
  console.log(`🗑️ Ollama deleted: ${modelId}`)
  return { success: true, modelId }
}

// ---- local-disk introspection / import (migrate fast-path) ------------------

/** Ollama's models root: `$OLLAMA_MODELS` or `~/.ollama/models`. */
function getModelsDir() {
  return process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')
}

const fileExists = (p) => stat(p).then((s) => s.isFile()).catch(() => false)
const readManifest = (p) => readJSONFile(p, null, { logError: false })

// The canonical manifest path covers registry-pulled models; fall back to a
// shallow scan of manifests/<registry>/<namespace>/<name>/<tag> for custom
// registries/namespaces we didn't guess.
async function findManifest(modelsDir, ref) {
  const direct = await readManifest(join(modelsDir, ...ollamaManifestRelPath(ref).split('/')))
  if (direct) return direct
  const manifestsDir = join(modelsDir, 'manifests')
  const registries = await readdir(manifestsDir).catch(() => [])
  for (const registry of registries) {
    const namespaces = await readdir(join(manifestsDir, registry)).catch(() => [])
    for (const ns of namespaces) {
      const candidate = join(manifestsDir, registry, ns, ref.name, ref.tag)
      const m = await readManifest(candidate)
      if (m) return m
    }
  }
  return null
}

/**
 * Locate an installed Ollama model's weight files on disk (no network).
 * @returns {Promise<{ ggufPath: string, projectorPath: string|null, isMlx: false, isSharded: false }|null>}
 */
async function resolveLocalModel(modelId) {
  const modelsDir = getModelsDir()
  const manifest = await findManifest(modelsDir, parseOllamaModelRef(modelId))
  if (!manifest) return null
  const { modelDigest, projectorDigest } = parseOllamaManifest(manifest)
  if (!modelDigest) return null
  const ggufPath = join(modelsDir, 'blobs', digestToBlobFilename(modelDigest))
  if (!(await fileExists(ggufPath))) return null
  // Only report a projector the manifest references AND that's actually on disk
  // — a missing/corrupt projector blob shouldn't flag the model multimodal (and
  // block the fast path) or fail an LM Studio copy mid-way.
  let projectorPath = projectorDigest ? join(modelsDir, 'blobs', digestToBlobFilename(projectorDigest)) : null
  if (projectorPath && !(await fileExists(projectorPath))) projectorPath = null
  return { ggufPath, projectorPath, isMlx: false, isSharded: false }
}

/**
 * Register a local GGUF file as an Ollama model via `/api/create` (no download).
 * @param {{ name: string, ggufPath: string }} args
 * @returns {Promise<{ success: boolean, modelId?: string, error?: string }>}
 */
async function importModelFromGguf({ name, ggufPath }) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available' }
  }
  console.log(`📦 Ollama import (local): ${name} ← ${ggufPath}`)
  // No timeout — create copies the (multi-GB) blob into the store.
  const response = await fetchWithTimeout(`${config.baseUrl}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, modelfile: buildModelfile(ggufPath), stream: true })
  }, 0).catch((err) => ({ _err: err.message }))

  if (response._err || !response.ok || !response.body) {
    const error = response._err || `create failed: ${response.status} ${response.statusText}`
    return { success: false, error }
  }
  const lastError = await streamNdjson(response)
  if (lastError) return { success: false, error: lastError }
  installedModels = null
  console.log(`✅ Ollama import complete: ${name}`)
  return { success: true, modelId: name }
}

/**
 * Aggregate status for the unified local-LLM UI.
 */
async function getStatus() {
  const available = await checkOllamaAvailable()
  const models = available ? await getInstalledModels(true) : []
  return {
    available,
    baseUrl: config.baseUrl,
    version: available ? await getVersion() : null,
    modelCount: models.length,
    models,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

export {
  getInstalledModels,
  pullModel,
  deleteModel,
  getStatus,
  resolveLocalModel,
  importModelFromGguf
}
