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
import { join, dirname } from 'path'
import { readdir, stat, link, mkdir } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readJSONFile, sha256File } from '../lib/fileUtils.js'
import {
  parseOllamaManifest, parseOllamaModelRef, ollamaManifestRelPath, digestToBlobFilename, buildModelfile
} from '../lib/localLlmDisk.js'

const execFileAsync = promisify(execFile)
const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// A pull streams progress as NDJSON; a transient network failure between Ollama
// and the registry/CDN surfaces mid-stream as an `{"error":"EOF"}` frame (or the
// response read rejecting outright). The `ollama` CLI silently retries these and
// the pull is resumable — partial blobs are kept — so a retry continues rather
// than restarts. Total attempts (1 initial + retries) and a linear backoff base.
const PULL_MAX_ATTEMPTS = 3
const PULL_RETRY_BASE_DELAY_MS = 1_000
// Short probe — degrade to "no Ollama" fast rather than block on a cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 12_000
const STOP_TIMEOUT_MS = 8_000
const SERVICE_COMMAND_TIMEOUT_MS = 20_000

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
let managedProcess = null
let managedProcessPid = null

const status = { lastError: null, lastSuccessAt: null, consecutiveErrors: 0 }

async function commandExists(cmd, args = ['--version']) {
  return execFileAsync(cmd, args, { timeout: 5_000 }).then(() => true).catch(() => false)
}

async function getServiceController() {
  if (process.platform === 'darwin' && await commandExists('brew', ['--version'])) {
    return {
      supported: true,
      manager: 'homebrew',
      start: ['brew', ['services', 'start', 'ollama']],
      stop: ['brew', ['services', 'stop', 'ollama']],
      list: ['brew', ['services', 'list']]
    }
  }
  if (process.platform === 'linux' && await commandExists('systemctl', ['--version'])) {
    return {
      supported: true,
      manager: 'systemd',
      start: ['systemctl', ['enable', '--now', 'ollama']],
      stop: ['systemctl', ['disable', '--now', 'ollama']],
      active: ['systemctl', ['is-active', 'ollama']],
      enabled: ['systemctl', ['is-enabled', 'ollama']]
    }
  }
  return { supported: false, manager: null }
}

async function getServiceStatus() {
  const controller = await getServiceController()
  if (!controller.supported) {
    return { supported: false, manager: null, running: false, runAtStartup: false, status: null }
  }

  if (controller.manager === 'homebrew') {
    const [cmd, args] = controller.list
    const { stdout } = await execFileAsync(cmd, args, { timeout: SERVICE_COMMAND_TIMEOUT_MS }).catch(() => ({ stdout: '' }))
    const line = stdout.split('\n').find((entry) => entry.trim().startsWith('ollama '))
    const serviceStatus = line?.trim().split(/\s+/)[1] || 'none'
    const running = serviceStatus === 'started'
    return {
      supported: true,
      manager: 'homebrew',
      running,
      runAtStartup: running,
      status: serviceStatus
    }
  }

  if (controller.manager === 'systemd') {
    const [activeCmd, activeArgs] = controller.active
    const [enabledCmd, enabledArgs] = controller.enabled
    const [{ stdout: activeOut }, { stdout: enabledOut }] = await Promise.all([
      execFileAsync(activeCmd, activeArgs, { timeout: SERVICE_COMMAND_TIMEOUT_MS }).catch(() => ({ stdout: '' })),
      execFileAsync(enabledCmd, enabledArgs, { timeout: SERVICE_COMMAND_TIMEOUT_MS }).catch(() => ({ stdout: '' })),
    ])
    const activeStatus = activeOut.trim() || 'inactive'
    const enabledStatus = enabledOut.trim() || 'disabled'
    const running = activeStatus === 'active'
    const runAtStartup = enabledStatus === 'enabled'
    return {
      supported: true,
      manager: 'systemd',
      running,
      runAtStartup,
      status: activeStatus,
      enabledStatus
    }
  }

  return { supported: false, manager: null, running: false, runAtStartup: false, status: null }
}

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
async function checkOllamaAvailable(forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && lastCheckAt && now - lastCheckAt < AVAILABILITY_CACHE_TTL_MS && isAvailable !== null) {
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

function resetAvailabilityCache() {
  isAvailable = null
  lastCheckAt = null
  installedModels = null
}

async function waitForAvailability(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await checkOllamaAvailable(true)) === expected) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return (await checkOllamaAvailable(true)) === expected
}

function rememberManagedProcess(child) {
  managedProcess = child
  managedProcessPid = child.pid
  child.on('exit', () => {
    if (managedProcessPid === child.pid) {
      managedProcess = null
      managedProcessPid = null
    }
  })
}

async function terminateManagedProcess() {
  const pid = managedProcessPid
  if (!pid) return false
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch { return false }
  }
  return true
}

/**
 * Start the Ollama HTTP server via the local CLI.
 * @returns {Promise<{ success: boolean, running?: boolean, alreadyRunning?: boolean, pid?: number, error?: string }>}
 */
async function startServer() {
  if (await checkOllamaAvailable(true)) {
    return { success: true, running: true, alreadyRunning: true }
  }

  let spawnError = null
  const stderr = []
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env
  })
  rememberManagedProcess(child)
  child.stderr?.on('data', (chunk) => {
    stderr.push(chunk.toString())
    if (stderr.join('').length > 2000) stderr.shift()
  })
  child.on('error', (err) => { spawnError = err })
  child.unref()

  const running = await waitForAvailability(true, START_TIMEOUT_MS)
  if (running) {
    console.log(`▶️ Started Ollama server (pid ${child.pid})`)
    return { success: true, running: true, pid: child.pid }
  }

  const detail = spawnError?.message || stderr.join('').trim()
  return {
    success: false,
    running: false,
    error: `Ollama did not become reachable${detail ? `: ${detail}` : ''}`
  }
}

async function startPersistentService() {
  const controller = await getServiceController()
  if (!controller.supported) {
    return { success: false, running: await checkOllamaAvailable(true), error: 'No supported Ollama background service manager found.' }
  }

  const [cmd, args] = controller.start
  resetAvailabilityCache()
  const result = await execFileAsync(cmd, args, { timeout: SERVICE_COMMAND_TIMEOUT_MS })
    .then(() => ({ success: true }))
    .catch((err) => ({ success: false, error: err.stderr?.trim() || err.stdout?.trim() || err.message }))

  const running = await waitForAvailability(true, START_TIMEOUT_MS)
  const service = await getServiceStatus().catch(() => ({
    supported: true,
    manager: controller.manager,
    running,
    runAtStartup: running,
    status: running ? 'started' : 'unknown'
  }))

  if (result.success && running) {
    console.log(`▶️ Started Ollama via ${controller.manager} service`)
    return { success: true, running: true, persistent: true, service }
  }

  return {
    success: false,
    running,
    persistent: false,
    service,
    error: result.error || 'Ollama service started, but the API did not become reachable.'
  }
}

async function stopPersistentService() {
  const controller = await getServiceController()
  if (!controller.supported) {
    return { success: false, running: await checkOllamaAvailable(true), error: 'No supported Ollama background service manager found.' }
  }

  const [cmd, args] = controller.stop
  const result = await execFileAsync(cmd, args, { timeout: SERVICE_COMMAND_TIMEOUT_MS })
    .then(() => ({ success: true }))
    .catch((err) => ({ success: false, error: err.stderr?.trim() || err.stdout?.trim() || err.message }))

  const stopped = await waitForAvailability(false, STOP_TIMEOUT_MS)
  if (stopped) resetAvailabilityCache()
  const service = await getServiceStatus().catch(() => ({
    supported: true,
    manager: controller.manager,
    running: !stopped,
    runAtStartup: !stopped,
    status: stopped ? 'stopped' : 'unknown'
  }))

  if (result.success && stopped) {
    console.log(`⏹️ Stopped Ollama ${controller.manager} service`)
    return { success: true, running: false, persistent: false, service }
  }

  return {
    success: false,
    running: !stopped,
    persistent: service.runAtStartup,
    service,
    error: result.error || 'Ollama service stopped, but the API still appears reachable.'
  }
}

async function ensureRunning({ preferPersistent = false } = {}) {
  if (await checkOllamaAvailable(true)) {
    return { success: true, running: true, alreadyRunning: true, service: await getServiceStatus().catch(() => null) }
  }
  if (preferPersistent) {
    const serviceResult = await startPersistentService()
    if (serviceResult.success) return serviceResult
    console.warn(`⚠️ Failed to start Ollama as a background service: ${serviceResult.error}`)
  }
  return startServer()
}

function isOllamaProvider(provider) {
  const endpoint = String(provider?.endpoint || '')
  return provider?.id === 'ollama' ||
    /ollama/i.test(provider?.name || '') ||
    /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(endpoint)
}

async function ensureProviderReady(provider, options = {}) {
  if (!isOllamaProvider(provider)) return { success: true, skipped: true }
  return ensureRunning({ preferPersistent: options.preferPersistent !== false })
}

/**
 * Stop the Ollama HTTP server. Prefer the PortOS-managed process when we
 * started it; otherwise terminate the local `ollama` process by executable name.
 */
async function stopServer() {
  if (!(await checkOllamaAvailable(true))) {
    return { success: true, running: false, alreadyStopped: true }
  }

  const service = await getServiceStatus().catch(() => null)
  if (service?.runAtStartup) {
    const stoppedService = await stopPersistentService()
    if (stoppedService.success || !(await checkOllamaAvailable(true))) return stoppedService
  }

  await terminateManagedProcess()
  if (await waitForAvailability(false, STOP_TIMEOUT_MS)) {
    resetAvailabilityCache()
    console.log('⏹️ Stopped PortOS-managed Ollama server')
    return { success: true, running: false }
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const killed = await execFileAsync('pkill', ['-TERM', '-x', 'ollama'], { timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (killed && await waitForAvailability(false, STOP_TIMEOUT_MS)) {
      resetAvailabilityCache()
      console.log('⏹️ Stopped Ollama server')
      return { success: true, running: false }
    }
  }

  return {
    success: false,
    running: true,
    error: 'Ollama is running, but PortOS could not stop the local process automatically.'
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
    const guess = models.find((m) => /embed|bge|nomic|mxbai|gte|e5/i.test(m.id || m.name || ''))
    if (!guess) {
      return { success: false, error: 'No embedding model installed in Ollama' }
    }
    model = guess.id || guess.name
  }

  const tryEndpoint = async (endpoint, body) => {
    const response = await fetchWithTimeout(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, options.timeout ?? 30_000).catch((err) => ({ _err: err.message }))
    if (response._err) return { ok: false, error: response._err }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      return { ok: false, status: response.status, error: errBody.slice(0, 200) }
    }
    return { ok: true, data: await response.json() }
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
 * List models currently loaded into VRAM/unified memory (Ollama's `/api/ps`).
 * Distinct from getInstalledModels(): a model on disk doesn't occupy memory
 * until it's referenced by a request.
 * @returns {Promise<Array<{ id, name, size, sizeVram, expiresAt }>>}
 */
async function getLoadedModels() {
  if (!(await checkOllamaAvailable())) return []
  const data = await ollamaRequest('/api/ps').catch(() => null)
  if (!Array.isArray(data?.models)) return []
  return data.models.map((m) => ({
    id: m.name || m.model,
    name: m.name || m.model,
    size: m.size ?? null,
    sizeVram: m.size_vram ?? null,
    expiresAt: m.expires_at || null
  }))
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
  return { unloaded: true, model: modelName }
}

/**
 * Pull a model, streaming progress. Resolves once the pull finishes.
 * During a transient-error backoff the callback fires with `retrying: true`
 * (and `percent: null`) so the UI can show a "retrying" banner instead of stalling.
 * @param {string} modelId
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number, retrying?: boolean }) => void} [onProgress]
 * @returns {Promise<{ success: boolean, modelId: string, error?: string }>}
 */
async function pullModel(modelId, onProgress) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  console.log(`📥 Ollama pull: ${modelId}`)

  let lastError = null
  for (let attempt = 1; attempt <= PULL_MAX_ATTEMPTS; attempt++) {
    const result = await attemptOllamaPull(modelId, onProgress)
    if (result.success) {
      installedModels = null  // bust cache so the new model shows on next list
      console.log(`✅ Ollama pull complete: ${modelId}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`)
      return { success: true, modelId }
    }
    lastError = result.error
    // Bad model name / missing manifest etc. won't fix themselves — only retry
    // the transient network class, and only while attempts remain.
    if (attempt >= PULL_MAX_ATTEMPTS || !isTransientPullError(lastError)) break
    const delayMs = PULL_RETRY_BASE_DELAY_MS * attempt
    console.warn(`🔁 Ollama pull ${modelId} hit transient error "${lastError}" (attempt ${attempt}/${PULL_MAX_ATTEMPTS}); retrying in ${delayMs}ms`)
    if (typeof onProgress === 'function') onProgress({ status: 'retrying after network error', percent: null, retrying: true })
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  console.error(`⚠️ Ollama pull failed for ${modelId}: ${lastError}`)
  const code = isOllamaOutdatedError(lastError) ? 'OLLAMA_OUTDATED' : undefined
  return { success: false, error: lastError, modelId, ...(code ? { code } : {}) }
}

/**
 * Detect Ollama's "model requires a newer version" 412 response surfaced in the
 * NDJSON stream. The registry returns it when a new model format (e.g. a fresh
 * GGUF feature) lands before the local Ollama binary supports it; the fix is to
 * upgrade the Ollama install. The error string we see looks like:
 *   "pull model manifest: 412: The model you are attempting to pull requires
 *    a newer version of Ollama. Please download the latest version at: …"
 * Match on the "newer version of Ollama" phrase plus the 412 status code so a
 * benign 412 from an unrelated path can't slip through.
 * @param {string|null|undefined} error
 */
function isOllamaOutdatedError(error) {
  if (!error) return false
  const str = String(error)
  return /\b412\b/.test(str) && /newer version of ollama/i.test(str)
}

/**
 * A single pull attempt. Returns `{ success }` or `{ success: false, error }`.
 * A read that rejects mid-stream (dropped connection) is caught and returned as
 * an error string so the caller's retry loop can classify it like an `{error}`
 * frame rather than letting it throw out of the request lifecycle.
 * @param {string} modelId
 * @param {(p: object) => void} [onProgress]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function attemptOllamaPull(modelId, onProgress) {
  // No timeout — multi-GB pulls take minutes; the stream is the lifecycle.
  const response = await fetchWithTimeout(`${config.baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: true })
  }, 0).catch((err) => ({ _err: describeFetchError(err) }))

  if (response._err || !response.ok || !response.body) {
    return { success: false, error: response._err || `pull failed: ${response.status} ${response.statusText}` }
  }

  const lastError = await streamNdjson(response, (frame) => {
    if (typeof onProgress === 'function') {
      const percent = frame.total > 0 && frame.completed >= 0
        ? Math.round((frame.completed / frame.total) * 100)
        : null
      onProgress({ status: frame.status || '', percent, completed: frame.completed, total: frame.total })
    }
  }).catch((err) => err?.message || String(err))

  return lastError ? { success: false, error: lastError } : { success: true }
}

/**
 * Flatten a thrown fetch error into a single descriptive string, walking the
 * `cause` chain. Node/undici reports network failures as `TypeError: fetch
 * failed` with the real reason (ECONNRESET, ETIMEDOUT, ...) tucked into
 * `err.cause` (and sometimes nested deeper). Without this, the transient
 * classifier only sees "fetch failed" and misclassifies retryable failures as
 * fatal. Includes each level's `.code` so `isTransientPullError()` can match.
 * @param {unknown} err
 * @returns {string}
 */
function describeFetchError(err) {
  const parts = []
  let node = err
  const seen = new Set()
  // Bound the walk in case of a self-referential cause chain.
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    if (seen.has(node)) break
    seen.add(node)
    if (node.code) parts.push(String(node.code))
    if (node.message) parts.push(String(node.message))
    node = node.cause
  }
  if (typeof node === 'string') parts.push(node)
  return parts.join(': ') || String(err)
}

/**
 * Classify a pull/stream error string as a transient network failure worth
 * retrying (Ollama↔registry EOF, connection reset, undici "terminated", etc.).
 * Non-transient errors — invalid model name, "file does not exist" — return
 * false so the retry loop gives up immediately.
 * @param {string|null|undefined} error
 * @returns {boolean}
 */
function isTransientPullError(error) {
  if (!error) return false
  return /\beof\b|connection reset|reset by peer|broken pipe|socket hang up|other side closed|terminated|i\/o timeout|\btimeout\b|tls handshake|temporary failure|network is unreachable|connection refused|econnreset|etimedout|epipe/i.test(String(error))
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
 * Pre-place the source GGUF as a hardlink at `blobs/sha256-<hash>` so the
 * subsequent `/api/create` reuses the existing (content-addressed) blob instead
 * of copying the multi-GB weights — zero extra disk, the file is shared with the
 * source backend's copy. Best-effort: a cross-filesystem hardlink (EXDEV) or any
 * error returns false and the caller's `/api/create` just copies as usual.
 * @returns {Promise<boolean>} whether the blob is now hardlinked
 */
async function prelinkBlob(ggufPath) {
  const hex = await sha256File(ggufPath)
  const blobPath = join(getModelsDir(), 'blobs', digestToBlobFilename(`sha256:${hex}`))
  if (await fileExists(blobPath)) return true // already present (content-addressed dedup)
  await mkdir(dirname(blobPath), { recursive: true })
  await link(ggufPath, blobPath)
  return true
}

/**
 * Register a local GGUF file as an Ollama model via `/api/create` (no download).
 * In `link` mode the blob is hardlinked into Ollama's store first so create
 * dedups against it (shared on disk); `copy` mode lets create copy the blob.
 * @param {{ name: string, ggufPath: string, mode?: 'link'|'copy' }} args
 * @returns {Promise<{ success: boolean, modelId?: string, linked?: boolean, error?: string }>}
 */
async function importModelFromGguf({ name, ggufPath, mode = 'copy' }) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available' }
  }
  const linked = mode === 'link' ? await prelinkBlob(ggufPath).catch(() => false) : false
  console.log(`📦 Ollama import (${linked ? 'hardlink' : 'copy'}): ${name} ← ${ggufPath}`)
  // No timeout — create may copy the (multi-GB) blob into the store (skipped
  // when we pre-hardlinked a matching blob above).
  const response = await fetchWithTimeout(`${config.baseUrl}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, modelfile: buildModelfile(ggufPath), stream: true })
  }, 0).catch((err) => ({ _err: describeFetchError(err) }))

  if (response._err || !response.ok || !response.body) {
    const error = response._err || `create failed: ${response.status} ${response.statusText}`
    return { success: false, error }
  }
  const lastError = await streamNdjson(response)
  if (lastError) return { success: false, error: lastError }
  installedModels = null
  console.log(`✅ Ollama import complete: ${name}${linked ? ' (hardlinked blob — no extra disk)' : ''}`)
  return { success: true, modelId: name, linked }
}

/**
 * Live base URL — reflects runtime config patches, not just startup env.
 * Used by sibling services (e.g. the local code-review endpoint) so the
 * catalog UI and the code-review path can't desync.
 */
function getBaseUrl() {
  return config.baseUrl
}

/**
 * Aggregate status for the unified local-LLM UI.
 */
async function getStatus(forceRefresh = false) {
  const available = await checkOllamaAvailable(forceRefresh)
  const models = available ? await getInstalledModels(true) : []
  const service = await getServiceStatus().catch(() => ({ supported: false, manager: null, running: false, runAtStartup: false, status: null }))
  return {
    available,
    baseUrl: config.baseUrl,
    version: available ? await getVersion() : null,
    modelCount: models.length,
    models,
    service,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

export {
  getInstalledModels,
  getLoadedModels,
  unloadModel,
  pullModel,
  deleteModel,
  getStatus,
  getBaseUrl,
  resolveLocalModel,
  importModelFromGguf,
  startServer,
  stopServer,
  startPersistentService,
  stopPersistentService,
  ensureRunning,
  ensureProviderReady,
  isOllamaProvider,
  getServiceStatus,
  getEmbeddings
}
