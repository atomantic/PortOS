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

import { homedir, tmpdir } from 'os'
import { join, dirname } from 'path'
import { createWriteStream } from 'fs'
import { readdir, stat, link, unlink, mkdtemp, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { execFile, spawn } from '../lib/childProcess.js';import { promisify } from 'util'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { describeFetchError } from '../lib/fetchErrorChain.js'
import { readJSONFile, sha256File, safeJSONParse, ensureDir, atomicWrite, sleep } from '../lib/fileUtils.js'
import {
  parseOllamaManifest, parseOllamaModelRef, ollamaManifestRelPath, digestToBlobFilename, buildModelfile,
  manifestBlobRefs, huggingFaceRegistryBase
} from '../lib/localLlmDisk.js'
import { buildHfAuthHeaders, buildHfResolveUrl, HF_API } from '../lib/huggingfaceLora.js'
import { isEmbeddingModel } from '../lib/localModelHeuristics.js'
import { commandExists } from '../lib/commandExists.js'
import {
  OLLAMA_AGENT_MIN_CONTEXT, resolveOllamaContextLength, withOllamaContextEnv
} from '../lib/ollamaContext.js'
import { compareSemver } from '../lib/versionUtils.js'
import { isSafeHfRepoRelativePath } from '../lib/hfCache.js'

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
// Hugging Face can be pathologically slow serving the tiny (≈500 byte) *config*
// blob of a large GGUF repo — a cold CDN miss regularly takes 50-60s, well past
// Ollama's internal per-request deadline. The weight layers all reach 100%, then
// the pull dies with "context deadline exceeded" and no manifest is written, so
// the model vanishes even though ~30GB of verified blobs are on disk. Ollama
// itself doesn't resume that step, and every retry re-races the same deadline.
// So when a pull fails that way we finish it ourselves: fetch the manifest +
// missing blobs with a generous timeout, verify each digest, and write the
// manifest Ollama would have written. See isPullDeadlineError().
const HF_FINALIZE_TIMEOUT_MS = 180_000
// Only complete blobs small enough to hold in memory and hash in one shot — the
// config/params/template layers this recovery exists for are bytes-to-kilobytes.
// A missing multi-GB weight layer is a real download, not a stalled hiccup, so
// we bail and let the error surface rather than silently re-downloading it here.
const HF_FINALIZE_MAX_BLOB_BYTES = 4 * 1024 * 1024
// Short probe — degrade to "no Ollama" fast rather than block on a cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 12_000
const STOP_TIMEOUT_MS = 8_000
const SERVICE_COMMAND_TIMEOUT_MS = 20_000
const PROCESS_IDENTITY_TIMEOUT_MS = 2_000
const HF_IMPORT_METADATA_TIMEOUT_MS = 180_000

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
let lastLoadedModelsError = null
// Why /api/tags last returned nothing. `getInstalledModels` deliberately caches
// an empty list on failure (see its comment), so `[]` alone cannot distinguish
// "Ollama has no models installed" from "the list could not be read" — callers
// that must not present a failed read as an empty backend consult this.
// Mirrors lmStudioManager's `getLastListError`.
let lastInstalledModelsError = null
let lastCheckAt = null
let managedProcess = null
let managedProcessPid = null
// The OLLAMA_CONTEXT_LENGTH PortOS handed the daemon that is up right now —
// whether by spawning it or by restarting its launch-at-login service. Cleared
// when the daemon goes away, so it always describes the live process.
//
// It is what stops `ensureContextWindow` from restarting in a loop: Ollama is
// free to load a model at less than the requested window (it fits the KV cache
// to VRAM), and re-reading a smaller `/api/ps` value as "not applied yet" would
// bounce the daemon before every single agent spawn. Once a window has been
// handed over, that request is done.
let appliedContextLength = null
// PID set for the daemon that received the context-window handoff. An empty
// /api/ps response is normal after model eviction and immediately after a
// restart, so model absence cannot invalidate the latch. When the host can
// identify the Ollama process, a changed PID set is reliable evidence that the
// daemon was replaced behind PortOS's back. A missing identity is deliberately
// treated as "no evidence" so an unavailable process probe cannot create a
// restart loop.
let appliedDaemonIdentity = null
// Signature of the FULL launch env the live daemon was started with, so a second
// request for the same tuning is a no-op instead of another restart. A sweep
// measures every model under one tuning; without this it would stop, start, and
// cold-load the daemon once per model, and every first sample would be timing a
// fresh page-in rather than the model.
let appliedLaunchEnv = null
// The variable NAMES behind `appliedLaunchEnv`, kept alongside the signature
// rather than re-derived from a string. Longer-lived than `appliedLaunchEnv` on
// purpose: that latch answers "does the daemon that is up right now hold this
// env?", so losing sight of the daemon clears it. This answers "what has PortOS
// put in front of Ollama that has not been cleared yet?", which a clear needs
// even when the daemon it was applied to is gone.
let appliedLaunchEnvKeys = []
// The subset of those that went into the launchd DOMAIN via `launchctl setenv`
// (the homebrew launch-at-login path). Tracked separately because a domain
// variable outlives every daemon: every job started afterwards inherits it, so
// clearing means unsetting it BY NAME. Omitting it from the next start does
// nothing. Emptied only by a successful unset.
let launchdExportedKeys = []
// The env object behind `appliedLaunchEnv`, kept so a tuning can capture the
// configuration it displaces rather than only its signature.
let appliedLaunchEnvValues = null
// The launch env the daemon carried BEFORE an assessment tuning went on it.
// `null` means no tuning is outstanding.
//
// The baseline an untuned assessment restores is what THIS INSTALL runs by
// default, not an empty environment — `ensureContextWindow` puts the user's
// configured agent context window on the same `OLLAMA_CONTEXT_LENGTH` a tuning
// uses, and stripping it in the name of measuring "backend defaults" would
// silently undo a setting the user chose on the LLMs page. Same rule as
// `llamaServerManager`'s `preTuningConfig`, for the same reason.
let preTuningEnv = null

const envSignature = (env) => Object.entries(env || {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`)
  .join(',')

/**
 * Record the launch env the daemon that is up right now was started with.
 *
 * `identity` is the process identity to latch against — a spawned child's PID,
 * or the probed identity of a service PortOS restarted. Both latches are set
 * together and cleared together, so "which env" and "which process" can never
 * describe two different daemons.
 */
function rememberAppliedEnv(env, identity) {
  // `null` (nothing recorded), never `''` — the latch below tests
  // `appliedLaunchEnv !== null` to mean "we know what this daemon holds", and an
  // empty-string stand-in for "unknown" would claim knowledge we do not have.
  appliedLaunchEnv = env ? envSignature(env) : null
  // Only a NAMED env updates the key record. `null` means "we no longer know
  // which daemon is up", which says nothing about whether the variables PortOS
  // exported are still in the launchd domain — and forgetting them there would
  // strand a tuning nothing can clear.
  if (env) {
    appliedLaunchEnvKeys = Object.keys(env)
    appliedLaunchEnvValues = { ...env }
  }
  // A restart that named no window leaves Ollama on its VRAM-based auto-pick,
  // which is not a window PortOS can claim — so the context latch is cleared
  // rather than crediting the new process with the old one's window.
  appliedContextLength = resolveOllamaContextLength(null, env || {})
  appliedDaemonIdentity = identity || null
}

const status = { lastError: null, lastSuccessAt: null, consecutiveErrors: 0 }

async function getServiceController() {
  if (process.platform === 'darwin' && await commandExists('brew', ['--version'])) {
    return {
      supported: true,
      manager: 'homebrew',
      start: ['brew', ['services', 'start', 'ollama']],
      stop: ['brew', ['services', 'stop', 'ollama']],
      restart: ['brew', ['services', 'restart', 'ollama']],
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

async function ollamaRequestAt(baseUrl, endpoint, options = {}) {
  const { timeout, headers, ...rest } = options
  const response = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}${endpoint}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers }
  }, timeout ?? config.timeout)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  return readResponseJson(response)
}

async function ollamaRequest(endpoint, options = {}) {
  return ollamaRequestAt(config.baseUrl, endpoint, options)
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
    // The daemon we handed a window to is gone; whatever comes up next has to
    // be re-checked rather than credited with that window or that launch env.
    appliedContextLength = null
    appliedDaemonIdentity = null
    appliedLaunchEnv = null
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
  lastLoadedModelsError = null
}

async function waitForAvailability(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await checkOllamaAvailable(true)) === expected) return true
    await sleep(400)
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
 *
 * `env` carries every launch-time knob PortOS can hand the daemon —
 * `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, … —
 * because the process environment is the ONLY lever that reaches them. Claude
 * Code and OpenCode talk to Ollama directly, and its OpenAI-compatible endpoint
 * drops unknown body fields, so PortOS cannot attach a per-request `num_ctx` the
 * way the toolkit runner does for `api` providers. There is deliberately no
 * second, context-only parameter: two spellings of one variable would need a
 * precedence rule, and the latches below would have to read both.
 *
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<{ success: boolean, running?: boolean, alreadyRunning?: boolean, pid?: number, error?: string }>}
 */
async function startServer({ env = null } = {}) {
  if (await checkOllamaAvailable(true)) {
    return { success: true, running: true, alreadyRunning: true }
  }

  const contextLength = resolveOllamaContextLength(null, env || {})
  let spawnError = null
  const stderr = []
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...(env || {}) }
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
    // A daemon PortOS just started carries exactly `env` and nothing else, so
    // there is no earlier tuning left to undo. `restartWithEnv` re-asserts its
    // own baseline after this returns — see the note there. Mirrors
    // `llamaServerManager`'s `startLlamaServer`.
    preTuningEnv = null
    rememberAppliedEnv(env, String(child.pid))
    const window = contextLength ? ` (context ${contextLength})` : ''
    console.log(`▶️ Started Ollama server (pid ${child.pid})${window}`)
    return { success: true, running: true, pid: child.pid }
  }

  const detail = spawnError?.message || stderr.join('').trim()
  return {
    success: false,
    running: false,
    error: `Ollama did not become reachable${detail ? `: ${detail}` : ''}`
  }
}

/**
 * `brew services start` shells out to `launchctl bootstrap gui/<uid> …plist`,
 * which fails with `Bootstrap failed: 5: Input/output error` when a service is
 * already bootstrapped in that domain — a stale launchd registration left over
 * from a prior `ollama serve`, an interrupted start, or a Homebrew upgrade. The
 * job is loaded but `start` refuses to re-bootstrap it. Booting it out
 * (`brew services stop`, i.e. `launchctl bootout`) clears the registration so
 * the retry can bootstrap cleanly.
 */
function isBootstrapConflictError(message) {
  const m = String(message || '').toLowerCase()
  // "already loaded/bootstrapped" unambiguously means a stale registration.
  if (/already (?:loaded|bootstrapped)/.test(m)) return true
  // Otherwise require the failure to actually be about a launchctl *bootstrap*
  // before trusting the EIO / exit-5 signal — so an unrelated brew failure that
  // merely mentions "input/output error" (a disk EIO, a permissions error)
  // can't trip the bootout-and-retry recovery. The two real-world shapes both
  // name bootstrap: launchctl's own "Bootstrap failed: 5: Input/output error"
  // and brew's wrapper "…launchctl bootstrap … exited with 5".
  if (!/bootstrap/.test(m)) return false
  return /bootstrap failed: 5\b/.test(m) ||
    /\binput\/output error\b/.test(m) ||
    /exited with 5\b/.test(m) ||
    /\bbootstrap failed\b/.test(m)
}

async function runServiceStart(controller) {
  const [cmd, args] = controller.start
  return execFileAsync(cmd, args, { timeout: SERVICE_COMMAND_TIMEOUT_MS })
    .then(() => ({ success: true }))
    .catch((err) => ({ success: false, error: err.stderr?.trim() || err.stdout?.trim() || err.message }))
}

async function startPersistentService() {
  const controller = await getServiceController()
  if (!controller.supported) {
    // `unsupported` marks an expected platform capability gap (Windows ships no
    // brew/systemd; so does a Linux box without systemd) rather than a failed
    // start attempt, so `ensureRunning` can fall back to a foreground
    // `ollama serve` quietly instead of warning on every boot.
    return { success: false, unsupported: true, running: await checkOllamaAvailable(true), error: 'No supported Ollama background service manager found.' }
  }

  resetAvailabilityCache()
  let result = await runServiceStart(controller)

  // Recover from a stale launchd registration: bootstrap reported the job is
  // already loaded, so boot it out and retry once. systemd's `enable --now` is
  // idempotent and never hits this, so the recovery is homebrew-only.
  if (!result.success && controller.manager === 'homebrew' && isBootstrapConflictError(result.error)) {
    console.warn(`♻️ Ollama service start hit a stale launchd registration (${result.error}); booting out and retrying`)
    const [stopCmd, stopArgs] = controller.stop
    await execFileAsync(stopCmd, stopArgs, { timeout: SERVICE_COMMAND_TIMEOUT_MS }).catch(() => {})
    result = await runServiceStart(controller)
  }

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
    // Mirrors startPersistentService — same capability gap, same flag, so a
    // caller can tell "nothing to stop on this platform" from a real failure.
    return { success: false, unsupported: true, running: await checkOllamaAvailable(true), error: 'No supported Ollama background service manager found.' }
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
    // Only a real start FAILURE deserves a warning. `unsupported` just means
    // this platform has no service manager to try — the normal case on Windows,
    // where warning made every boot look broken. The `startServer()` fallback
    // below is the intended path there, not a degraded one.
    if (!serviceResult.unsupported) {
      console.warn(`⚠️ Failed to start Ollama as a background service: ${serviceResult.error}`)
    }
  }
  return startServer()
}

/**
 * Identify the live Ollama server process without using model residency as a
 * proxy for daemon identity. `ps` is available on macOS/Linux; tasklist gives
 * us the equivalent PID set on Windows. A failed/unsupported probe returns
 * null, which is intentionally treated as no evidence by the context latch.
 */
async function getOllamaProcessIdentity() {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', 'IMAGENAME eq ollama.exe', '/FO', 'CSV', '/NH'],
      { timeout: PROCESS_IDENTITY_TIMEOUT_MS },
    ).catch(() => ({ stdout: '' }))
    const pids = stdout.split('\n')
      .map((line) => {
        const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1])
        return fields[1] ? Number(fields[1]) : null
      })
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .sort((a, b) => a - b)
    return pids.length ? pids.join(',') : null
  }

  const { stdout } = await execFileAsync(
    'ps',
    ['-Ao', 'pid=,command='],
    { timeout: PROCESS_IDENTITY_TIMEOUT_MS },
  ).catch(() => ({ stdout: '' }))
  const pids = stdout.split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/)
      return match && /\bollama(?:\.exe)?\s+serve\b/i.test(match[2]) ? Number(match[1]) : null
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .sort((a, b) => a - b)
  return pids.length ? pids.join(',') : null
}

async function getRuntimeModels() {
  if (!(await checkOllamaAvailable())) return null
  const data = await ollamaRequest('/api/ps').catch(() => null)
  return Array.isArray(data?.models) ? data.models : []
}

const modelNames = (model) => [model?.name, model?.model]
  .filter((name) => typeof name === 'string' && name.trim())
  .map((name) => name.trim())

/**
 * The context window the daemon actually loaded at, read from `/api/ps`.
 * Ollama reports it per resident model. When a model is selected, only that
 * model is considered; without a selection, the smallest resident window is
 * used so a large sibling model cannot hide a smaller model's limit.
 *
 * If a selected model is not resident yet, the fallback is the smallest window
 * among all resident models: every relevant resident model must meet the target
 * before the daemon can be treated as safe. `null` means no model is resident.
 * @param {string|null} [selectedModel]
 * @returns {Promise<number|null>}
 */
async function getRuntimeContextLength(selectedModel = null) {
  const models = await getRuntimeModels()
  if (models == null) return null
  const wanted = typeof selectedModel === 'string' ? selectedModel.trim() : ''
  const selected = wanted
    ? models.filter((model) => modelNames(model).includes(wanted))
    : []
  const resident = selected.length ? selected : models
  const windows = resident
    .map((model) => Number(model?.context_length))
    .filter((n) => Number.isFinite(n) && n > 0)
  return windows.length ? Math.min(...windows) : null
}

/**
 * Hold the Ollama daemon at (at least) `contextLength` tokens, reloading it with
 * that window when it is running at a smaller one.
 *
 * Reloading a daemon is disruptive, so it happens at most once per daemon per
 * window (the `appliedContextLength` latch) and never when a resident model is
 * already at or above the target. It DOES happen when nothing is resident: an
 * idle daemon has not committed to a window yet, and the one it will pick is
 * the VRAM-based default `numCtx` exists to override.
 *
 * @param {number|null} contextLength
 * @param {string|null} [selectedModel] - model the next request will use
 * @returns {Promise<{ applied: boolean, reason: string, contextLength: number|null, runtimeContextLength?: number|null, error?: string }>}
 */
async function ensureContextWindow(contextLength, selectedModel = null) {
  const target = Number(contextLength) > 0 ? Math.floor(Number(contextLength)) : null
  if (!target) return { applied: false, reason: 'not-configured', contextLength: null }
  const env = withOllamaContextEnv({}, target)
  if (!(await checkOllamaAvailable(true))) {
    return { ...(await restartWithEnv(env, { tuning: false })), contextLength: target }
  }

  if (Number(appliedContextLength) >= target) {
    // Availability alone cannot identify an Ollama process: an external
    // restart can become reachable before PortOS observes a failed probe. A
    // changed process identity is the positive live evidence needed to
    // invalidate the old process's latch. An empty /api/ps response is not
    // evidence — normal model eviction and a just-completed restart both make
    // it empty.
    const currentIdentity = await getOllamaProcessIdentity()
    if (!appliedDaemonIdentity || !currentIdentity || currentIdentity === appliedDaemonIdentity) {
      return { applied: false, reason: 'already-applied', contextLength: target, runtimeContextLength: appliedContextLength }
    }
    rememberAppliedEnv(null, null)
  }

  // `runtime == null` means nothing is resident, which is the NORMAL idle state
  // between runs — not a reason to skip. The window Ollama will pick when the
  // harness loads its model is its VRAM-based default, i.e. exactly the one the
  // user set `numCtx` to override, so leaving it alone here would make the
  // setting a no-op in the common case. Apply it; the `appliedContextLength`
  // latch keeps this to one reload per daemon.
  const runtime = await getRuntimeContextLength(selectedModel)
  if (runtime != null && runtime >= target) {
    return { applied: false, reason: 'already-large-enough', contextLength: target, runtimeContextLength: runtime }
  }

  console.log(`🪟 Reloading Ollama at a ${target}-token context window (was ${runtime ?? 'unknown'})`)

  // The restart ladder itself — including the rule that a launch-at-login daemon
  // is restarted in place rather than un-registered — lives in `restartWithEnv`.
  // The checks ABOVE are what is specific to a context window: a resident model
  // already big enough, and the >= latch that keeps an agent spawn from bouncing
  // the daemon. Everything below was the same ladder written twice.
  return { ...(await restartWithEnv(env, { tuning: false })), contextLength: target, runtimeContextLength: runtime }
}

/**
 * Restart a launch-at-login-registered Ollama carrying `env`, WITHOUT
 * un-registering it.
 *
 * macOS: `launchctl setenv` writes into the user's launchd domain, which every
 * job launched afterwards inherits — so setting the variables and then
 * `brew services restart ollama` carries them into a plist PortOS cannot edit
 * (Homebrew regenerates it from the formula on every start). The variables are
 * scoped to Ollama's behavior, so exporting them session-wide is harmless.
 *
 * Linux: the equivalent is a `systemctl edit ollama` drop-in, which needs root.
 * PortOS reports what to do rather than tearing the unit down to work around it.
 *
 * @param {{ manager: string }} service
 * @param {Record<string, string>} env - never empty; `restartWithEnv` routes an
 *   empty env to `clearLaunchEnv` instead, which UNSETS what was set.
 */
async function restartServiceWithEnv(service, env) {
  const entries = Object.entries(env || {})

  if (service.manager !== 'homebrew') {
    const lines = entries.map(([k, v]) => `Environment="${k}=${v}"`).join(' ')
    return {
      applied: false,
      reason: 'service-managed',
      error: `Ollama runs as a ${service.manager} service, which PortOS can't hand launch settings. ` +
        `Add them with: sudo systemctl edit ollama → [Service] ${lines}, then restart it.`
    }
  }

  for (const [key, value] of entries) {
    const setenv = await runLaunchctl(['setenv', key, String(value)])
    // A key PortOS did NOT manage to set is not PortOS's to unset — the name may
    // belong to a variable the user exported themselves. Only a successful
    // setenv makes it ours.
    if (!setenv.success) return { applied: false, reason: 'setenv-failed', error: setenv.error }
    // Recorded as we go, not after the restart: it is already in the domain, and
    // a bounce that fails later must not leave it untracked and unclearable.
    if (!launchdExportedKeys.includes(key)) launchdExportedKeys.push(key)
  }

  const bounced = await bounceService()
  if (!bounced.ok) return bounced.failure
  rememberAppliedEnv(env, await getOllamaProcessIdentity())
  console.log(`▶️ Restarted the Ollama ${service.manager} service with ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  return { applied: true, reason: 'service-restarted' }
}

const runLaunchctl = (args) => execFileAsync('launchctl', args, { timeout: SERVICE_COMMAND_TIMEOUT_MS })
  .then(() => ({ success: true }))
  .catch((err) => ({ success: false, error: err.stderr?.trim() || err.message }))

/**
 * Take variables back OUT of the launchd domain, by name.
 *
 * Reached only for keys `restartServiceWithEnv` put there, so `launchctl` is
 * always the right tool — the domain exists on macOS and nowhere else.
 */
async function unsetLaunchdKeys(keys) {
  for (const key of keys) {
    const unsetenv = await runLaunchctl(['unsetenv', key])
    if (!unsetenv.success) return { success: false, error: unsetenv.error }
  }
  return { success: true }
}

/**
 * Restart the service controller's Ollama and wait for the API to come back.
 * `{ ok: false, failure }` carries the caller's return value verbatim, so the
 * set and clear paths above cannot drift on how a bounce failure is reported.
 */
async function bounceService() {
  const controller = await getServiceController()
  resetAvailabilityCache()
  const [cmd, args] = controller.restart
  const restarted = await execFileAsync(cmd, args, { timeout: SERVICE_COMMAND_TIMEOUT_MS })
    .then(() => ({ success: true }))
    .catch((err) => ({ success: false, error: err.stderr?.trim() || err.stdout?.trim() || err.message }))
  if (!restarted.success) return { ok: false, failure: { applied: false, reason: 'restart-failed', error: restarted.error } }

  if (!(await waitForAvailability(true, START_TIMEOUT_MS))) {
    return {
      ok: false,
      failure: { applied: false, reason: 'restart-unreachable', error: 'Ollama restarted, but the API did not become reachable.' }
    }
  }
  return { ok: true }
}

/**
 * Restart the local Ollama daemon so it picks up `env` — the launch-time knobs
 * (`OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_CONTEXT_LENGTH`, …)
 * that reach Ollama ONLY through its process environment.
 *
 * Ollama's OpenAI-compatible endpoint silently drops unknown body fields, so
 * there is no per-request spelling of any of these: a tuned measurement either
 * restarts the daemon or is measuring the previous configuration. This resolves
 * rather than throws, and reports `applied: false` with a reason when it could
 * not — the caller records that instead of filing the reading under a tuning
 * that never took effect.
 *
 * An EMPTY `env` is the opposite request: drop a tuning PortOS applied earlier
 * and put the daemon back on the env it had before. An untuned assessment needs
 * that — otherwise it samples the previous sweep's tuning and the reading is
 * filed as "Backend defaults". When no tuning is outstanding, nothing restarts.
 *
 * @param {Record<string, string>} env
 * @param {{ tuning?: boolean }} [options] `tuning: false` marks a restart that
 *   changes the install's REAL configuration (`ensureContextWindow` handing the
 *   daemon the user's agent context window) rather than a temporary assessment
 *   tuning. It is not undoable, and it becomes the baseline a later clear
 *   restores — without it, measuring "backend defaults" would strip a setting
 *   the user chose on the LLMs page.
 * @returns {Promise<{ applied: boolean|null, reason: string, error?: string }>}
 *   `applied: null` means nothing needed to change — not a refusal.
 */
async function restartWithEnv(env, { tuning = true } = {}) {
  const entries = Object.entries(env || {})
  if (entries.length === 0) {
    return tuning ? clearLaunchEnv() : { applied: false, reason: 'nothing-to-apply' }
  }

  // A TUNING is temporary and has to be undoable, so the first one records the
  // env it displaces; a second must not overwrite that with the first one's.
  // `appliedLaunchEnv === null` is the module's "we do not know what this daemon
  // holds" sentinel — an unknown baseline is `{}` (PortOS knows of no env to put
  // back), never a stale record of some earlier daemon's.
  const before = preTuningEnv
  const captured = preTuningEnv
    ?? (appliedLaunchEnv !== null && appliedLaunchEnvValues ? { ...appliedLaunchEnvValues } : {})

  const result = await applyLaunchEnv(env, entries)
  // Asserted AFTER the restart, never before: `startServer`/`stopServer` drop
  // the baseline as a matter of course (a daemon PortOS just started is untuned
  // by construction), so anything written up front would be wiped mid-call.
  //
  // A restart that did not happen changed nothing, so the bookkeeping must not
  // move either. A non-tuning restart that DID happen is the install's real
  // configuration changing, which leaves nothing to undo.
  if (result.applied === false) preTuningEnv = before
  else preTuningEnv = tuning ? captured : null
  return result
}

// The restart itself, with `restartWithEnv` owning the baseline bookkeeping
// around it so no exit below has to remember to unwind it.
async function applyLaunchEnv(env, entries) {
  // The daemon that is up may already BE this tuning — a sweep measures every
  // model under one knob set, and restarting per model would cold-load each one
  // and time the page-in as if it were the model's throughput. Same evidence
  // rule as the context latch: only a CHANGED process identity invalidates it,
  // because an unreadable identity is not evidence of replacement.
  if (appliedLaunchEnv !== null && appliedLaunchEnv === envSignature(env) && await checkOllamaAvailable(true)) {
    const currentIdentity = await getOllamaProcessIdentity()
    if (!appliedDaemonIdentity || !currentIdentity || currentIdentity === appliedDaemonIdentity) {
      return { applied: true, reason: 'already-applied' }
    }
    rememberAppliedEnv(null, null)
  }

  // A key the PREVIOUS env exported into the launchd domain and this one does
  // not name is STILL set, and every job started afterwards inherits it — so the
  // daemon would come back carrying half the old configuration. Omitting a
  // variable is not clearing it. Done here rather than in the service path
  // alone, because a spawned daemon started while a service is registered
  // inherits the same domain.
  const stale = launchdExportedKeys.filter((key) => !(key in env))
  if (stale.length) {
    const cleared = await unsetLaunchdKeys(stale)
    if (!cleared.success) return { applied: false, reason: 'unsetenv-failed', error: cleared.error }
    launchdExportedKeys = launchdExportedKeys.filter((key) => key in env)
  }

  console.log(`🔧 Restarting Ollama with ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`)

  if (!(await checkOllamaAvailable(true))) {
    const started = await startServer({ env })
    return started.success
      ? { applied: true, reason: 'started' }
      : { applied: false, reason: 'start-failed', error: started.error }
  }

  // A daemon the user registered to launch at login must keep that registration:
  // `stopServer` would route through `brew services stop` / `systemctl disable`,
  // which un-registers it. Restart it in place instead.
  const service = await getServiceStatus().catch(() => null)
  if (service?.runAtStartup) return restartServiceWithEnv(service, env)

  const stopped = await stopServer()
  if (!stopped.success) return { applied: false, reason: 'stop-failed', error: stopped.error }
  const started = await startServer({ env })
  return started.success
    ? { applied: true, reason: 'restarted' }
    : { applied: false, reason: 'start-failed', error: started.error }
}

/**
 * Put the daemon back on the env it carried before PortOS tuned it.
 *
 * This is the half of the tuning contract that keeps a BASELINE measurement
 * honest. An untuned assessment records `tuningKey: ''` and renders as "Backend
 * defaults"; if the daemon is still carrying the last sweep's
 * `OLLAMA_FLASH_ATTENTION=1`, that label describes a configuration that never
 * ran, and `compareTunings` then ranks every real tuning against it.
 *
 * "Before PortOS tuned it" is `preTuningEnv`, NOT an empty environment — see the
 * note there. Only when that baseline is itself empty does this tear the launch
 * env down to nothing.
 */
async function clearLaunchEnv() {
  // Variables PortOS exported are outstanding even when no tuning reached the
  // daemon — a `setenv` that landed before its restart failed. They sit in the
  // launchd domain, so the daemon that came up NEXT inherited them and is tuned
  // however this record reads. Taking them out is not enough: that daemon holds
  // them in its own process environment and has to be restarted too, which is
  // exactly what an empty baseline already means here.
  const baseline = preTuningEnv ?? (launchdExportedKeys.length ? {} : null)
  // Nothing outstanding at all. `null` — not `false` — because no request was
  // refused: the daemon already serves the configuration being asked for.
  if (baseline === null) return { applied: null, reason: 'already-untuned' }

  const keys = [...new Set([...appliedLaunchEnvKeys, ...launchdExportedKeys])]
  console.log(`🔧 Clearing the Ollama tuning PortOS applied (${keys.join(', ')})`)
  preTuningEnv = null

  // A non-empty baseline is just "restart under this env", which the normal
  // path already does — including taking the tuning's leftover launchd
  // variables back out of the domain. It is not an APPLICATION though: the run
  // asked for no tuning, so a success records `null`.
  if (Object.keys(baseline).length > 0) {
    const restored = await restartWithEnv(baseline, { tuning: false })
    if (restored.applied === false) {
      preTuningEnv = baseline
      return restored
    }
    return { ...restored, applied: null }
  }

  const exported = launchdExportedKeys
  // Domain variables come out FIRST, and regardless of whether a daemon is up:
  // they outlive the process that read them, so a login-launched Ollama would
  // otherwise come back tuned long after this run recorded "backend defaults".
  if (exported.length) {
    const unset = await unsetLaunchdKeys(exported)
    if (!unset.success) {
      preTuningEnv = baseline
      return { applied: false, reason: 'unsetenv-failed', error: unset.error }
    }
    launchdExportedKeys = []
  }

  const running = await checkOllamaAvailable(true)
  const service = await getServiceStatus().catch(() => null)

  // Nothing to restart. The domain is already clear and a daemon PortOS spawns
  // inherits the PortOS process environment, so whatever comes up next is
  // untuned either way.
  if (!running) {
    rememberAppliedEnv({}, null)
    return { applied: null, reason: 'not-running' }
  }

  // Every failure below leaves the daemon still tuned, so the baseline goes back
  // on the books for a later run to retry.
  const failed = (result) => {
    preTuningEnv = baseline
    return result
  }

  // A daemon the user registered to launch at login must keep that
  // registration: `stopServer` would un-register it. Restart it in place.
  if (service?.runAtStartup) {
    if (service.manager !== 'homebrew') {
      return failed({
        applied: false,
        reason: 'service-managed',
        error: `Ollama runs as a ${service.manager} service, which PortOS can't hand launch settings. ` +
          `Remove them with: sudo systemctl edit ollama → delete the Environment= lines for ${keys.join(', ')}, then restart it.`
      })
    }
    const bounced = await bounceService()
    if (!bounced.ok) return failed(bounced.failure)
    rememberAppliedEnv({}, await getOllamaProcessIdentity())
    console.log(`▶️ Ollama no longer carries ${keys.join(', ')}`)
    return { applied: null, reason: 'service-restarted-untuned' }
  }

  const stopped = await stopServer()
  if (!stopped.success) return failed({ applied: false, reason: 'stop-failed', error: stopped.error })
  // `env: {}`, not an omitted `env` — `startServer` records the env it launched
  // with, and an empty object is the positive statement "this daemon holds no
  // PortOS tuning". Omitting it records nothing, and the NEXT untuned run would
  // bounce the daemon again to clear a tuning that is already gone.
  const started = await startServer({ env: {} })
  return started.success
    ? { applied: null, reason: 'restarted-untuned' }
    : failed({ applied: false, reason: 'start-failed', error: started.error })
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
  const stopped = await stopOllamaProcess()
  // Whatever spawn-time env the daemon carried left with it, whichever of the
  // three ways it went down — so there is no longer a tuning to undo. (Anything
  // PortOS put in the launchd DOMAIN outlives the process and is tracked
  // separately, by `launchdExportedKeys`.) Done in one place rather than at each
  // success return, where a fourth stop path would silently miss it.
  if (stopped.success) preTuningEnv = null
  return stopped
}

async function stopOllamaProcess() {
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
  if (!(await checkOllamaAvailable())) {
    lastInstalledModelsError = status.lastError || 'Ollama is unavailable'
    return []
  }

  const data = await ollamaRequest('/api/tags').catch(() => null)
  if (!data?.models) {
    // Cache the empty result so a /api/tags failure while Ollama stays up for
    // /api/version (the availability probe) doesn't re-hit on every catalog
    // keystroke; a forceRefresh (status refresh / pull / delete) recovers it.
    lastInstalledModelsError = 'Ollama model list (/api/tags) returned no data'
    installedModels = []
    return installedModels
  }
  lastInstalledModelsError = null

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

/**
 * Ollama's reported version, or `null` when it isn't answering. Exported so the
 * assessment store can record WHICH backend build a measurement was taken
 * against — a backend update is one of the things that makes a stored reading
 * stale, and there is no other way to notice it after the fact.
 */
export async function getVersion() {
  const data = await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS }).catch(() => null)
  return data?.version || null
}

// A model's native context length and capability set are immutable for a given
// build, but Ollama's /api/tags listing carries neither — only /api/show does
// (one POST per model). Cache name → { contextLength, capabilities } so
// enriching the model list on every status poll doesn't re-hit /api/show.
// Busted alongside installedModels on delete (a deleted name shouldn't linger),
// but a re-pull of the same name yields the same details so we don't bust on pull.
const modelDetailsCache = new Map() // name -> { contextLength: number|null, capabilities: string[] }

/**
 * Fetch a model's native details (max context length + capability set) via
 * /api/show. Ollama nests context under `model_info["<arch>.context_length"]`
 * (the arch prefix varies by family so we scan for the suffix) and reports a
 * top-level `capabilities` array (`["completion","vision","tools",…]`). Cached;
 * returns nulls/empty when the daemon doesn't report a field.
 * @param {string} name
 * @returns {Promise<{ contextLength: number|null, capabilities: string[] }>}
 */
async function getModelDetails(name) {
  const miss = { contextLength: null, capabilities: [] }
  if (!name) return miss
  if (modelDetailsCache.has(name)) return modelDetailsCache.get(name)
  // /api/show documents the id under `model`; current Ollama also accepts the
  // legacy `name`, so send both (extra fields are ignored) for cross-version safety.
  const data = await ollamaRequest('/api/show', { method: 'POST', body: JSON.stringify({ model: name, name }) }).catch(() => null)
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
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : []
  }
  modelDetailsCache.set(name, details)
  return details
}

/**
 * A model's capability set (`["completion","vision","tools",…]`) from /api/show.
 * Lets vision detection see capabilities that the /api/tags id can't reveal —
 * e.g. a vision-capable MoE like `qwen3.6:35b` whose id has no `vl`/`vision`
 * token. Cached; returns `[]` when the daemon doesn't report capabilities.
 * @param {string} name
 * @returns {Promise<string[]>}
 */
async function getModelCapabilities(name) {
  return (await getModelDetails(name)).capabilities
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
async function getLoadedModelsAt(baseUrl) {
  const data = await ollamaRequestAt(baseUrl, '/api/ps').catch((err) => ({ _err: err.message }))
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
async function getLoadedModels() {
  if (!(await checkOllamaAvailable())) {
    lastLoadedModelsError = status.lastError || 'Ollama is unavailable'
    return []
  }
  const result = await getLoadedModelsAt(config.baseUrl)
  lastLoadedModelsError = result.error
  return result.models
}

/** Last `/api/tags` error (null only after a trustworthy installed list). */
function getLastInstalledModelsError() {
  return lastInstalledModelsError
}

/** Last `/api/ps` error (null only after a trustworthy residency list). */
function getLastLoadedModelsError() {
  return lastLoadedModelsError
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
  return { unloaded: true, model: modelName }
}

/**
 * Pull a model, streaming progress. Resolves once the pull finishes.
 * Non-percent frames carry a reason flag so the UI can show why the banner is
 * paused instead of stalling: `retrying: true` during a transient-error backoff,
 * `finalizing: true` while PortOS completes an install Ollama abandoned (see
 * finalizeHuggingFacePull). A success that went through that recovery is flagged
 * `recovered: true`.
 * @param {string} modelId
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number, retrying?: boolean, finalizing?: boolean }) => void} [onProgress]
 * @returns {Promise<{ success: boolean, modelId: string, error?: string, recovered?: boolean }>}
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
    await sleep(delayMs)
  }

  // The weights may all be on disk and only Ollama's manifest write missing —
  // retrying just re-races the same deadline, so finish the pull ourselves.
  // Gated on the ref being one we can actually finish, so a deadline against a
  // non-HF registry doesn't flash a "finishing install…" banner for a recovery
  // that has nowhere to fetch from.
  if (isPullDeadlineError(lastError) && huggingFaceRegistryBase(parseOllamaModelRef(modelId))) {
    if (typeof onProgress === 'function') {
      onProgress({ status: 'finishing install from downloaded files…', percent: null, finalizing: true })
    }
    const recovered = await finalizeHuggingFacePull(modelId).catch((err) => ({ success: false, error: err.message }))
    if (recovered.success) {
      installedModels = null  // bust cache so the recovered model shows on next list
      return { success: true, modelId, recovered: true }
    }
    console.warn(`⚠️ Ollama pull recovery declined for ${modelId}: ${recovered.error}`)
  }

  console.error(`⚠️ Ollama pull failed for ${modelId}: ${lastError}`)
  const code = isShardedGgufError(lastError) ? 'SHARDED_GGUF'
    : isOllamaOutdatedError(lastError) ? 'OLLAMA_OUTDATED'
      : undefined
  return { success: false, error: lastError, modelId, ...(code ? { code } : {}) }
}

function hfImportError(status, statusText) {
  if (status === 401 || status === 403) {
    return 'Hugging Face denied access. Accept the repository terms, then configure a Hugging Face token in Settings.'
  }
  return `Hugging Face request failed: ${status} ${statusText}`
}

async function downloadHfImportFile({ repo, remotePath, destination, headers, progress }) {
  const url = buildHfResolveUrl(repo, 'main', remotePath)
  const response = await fetchWithTimeout(url, { headers }, 0)
  if (!response.ok || !response.body) throw new Error(hfImportError(response.status, response.statusText))
  await ensureDir(dirname(destination))
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      progress(chunk.length)
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body), tracker, createWriteStream(destination))
}

/**
 * Download a curated Hugging Face Safetensors subdirectory and import it through
 * Ollama's supported `ollama create` path. The caller supplies only catalog-owned
 * recipes; arbitrary free-text ids continue through pullModel instead.
 *
 * @param {{ modelId: string, repo: string, subdir: string, minVersion?: string }} spec
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number, importing?: boolean }) => void} [onProgress]
 */
async function importModelFromHfSafetensors(spec, onProgress) {
  const { modelId, repo, subdir, minVersion = '0.19.0' } = spec
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  const version = await getVersion()
  if (!version || compareSemver(version.replace(/^v/, ''), minVersion.replace(/^v/, '')) < 0) {
    return {
      success: false,
      error: `This MLX import requires Ollama ${minVersion} or newer${version ? ` (installed: ${version})` : ''}.`,
      modelId,
      code: 'OLLAMA_OUTDATED'
    }
  }
  const { getHfToken } = await import('./hfToken.js')
  const token = await getHfToken()
  if (!token) {
    return {
      success: false,
      error: 'This gated model requires a Hugging Face token. Accept the repository terms, then configure a token in Settings.',
      modelId,
      code: 'HF_TOKEN_REQUIRED'
    }
  }
  if (!(await commandExists('ollama', ['--version']))) {
    return { success: false, error: 'The Ollama CLI is required to import Safetensors models.', modelId }
  }

  const headers = buildHfAuthHeaders(token)
  const metadataUrl = `${HF_API}/${repo}?blobs=true`
  const metadataResponse = await fetchWithTimeout(metadataUrl, { headers }, HF_IMPORT_METADATA_TIMEOUT_MS)
    .catch((err) => ({ _err: describeFetchError(err) }))
  if (metadataResponse._err) return { success: false, error: metadataResponse._err, modelId }
  if (!metadataResponse.ok) {
    return { success: false, error: hfImportError(metadataResponse.status, metadataResponse.statusText), modelId }
  }
  const metadata = await metadataResponse.json().catch(() => null)
  const prefix = `${subdir.replace(/\/+$/, '')}/`
  const files = (metadata?.siblings || [])
    .filter((file) => typeof file.rfilename === 'string' && file.rfilename.startsWith(prefix))
    .map((file) => ({
      remotePath: file.rfilename,
      relativePath: file.rfilename.slice(prefix.length),
      size: Number(file.lfs?.size ?? file.size) || 0
    }))
    .filter((file) => isSafeHfRepoRelativePath(file.relativePath))
  if (!files.some((file) => file.relativePath.endsWith('.safetensors')) || !files.some((file) => file.relativePath === 'config.json')) {
    return { success: false, error: `The ${subdir} checkpoint is incomplete or unavailable on Hugging Face.`, modelId }
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'portos-ollama-hf-import-'))
  const modelDir = join(tempRoot, 'model')
  const total = files.reduce((sum, file) => sum + file.size, 0)
  let completed = 0
  let lastPercent = -1
  const reportBytes = (bytes) => {
    completed += bytes
    const percent = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null
    if (percent === lastPercent) return
    lastPercent = percent
    if (typeof onProgress === 'function') onProgress({ status: 'downloading MLX checkpoint', percent, completed, total })
  }
  const performImport = async () => {
    for (const file of files) {
      await downloadHfImportFile({
        repo,
        remotePath: file.remotePath,
        destination: join(modelDir, ...file.relativePath.split('/')),
        headers,
        progress: reportBytes
      })
    }
    const modelfile = join(tempRoot, 'Modelfile')
    await atomicWrite(modelfile, `FROM ${modelDir}\n`)
    if (typeof onProgress === 'function') {
      onProgress({ status: 'importing checkpoint into Ollama', percent: null, importing: true })
    }
    await execFileAsync('ollama', ['create', modelId, '-f', modelfile], { timeout: 0, maxBuffer: 64 * 1024 * 1024 })
    installedModels = null
    console.log(`✅ Ollama Safetensors import complete: ${modelId}`)
    return { success: true, modelId }
  }
  return performImport()
    .catch((err) => ({ success: false, error: err.stderr || err.message, modelId }))
    .finally(() => rm(tempRoot, { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Ollama Safetensors import cleanup failed: ${err.message}`)
    }))
}

/**
 * Detect the Go-runtime deadline Ollama reports when a registry request outlives
 * its internal per-request budget: `context deadline exceeded`. Distinctive
 * because it lands AFTER the weight layers hit 100% — the blobs are downloaded
 * and verified, only the manifest write is missing — which is what makes the
 * local-completion recovery in finalizeHuggingFacePull() safe to attempt.
 *
 * Deliberately NOT part of isTransientPullError: retrying re-races the same slow
 * endpoint against the same deadline and fails identically every time.
 * @param {string|null|undefined} error
 */
function isPullDeadlineError(error) {
  return /context deadline exceeded/i.test(String(error ?? ''))
}

/**
 * Detect Ollama's refusal to pull a multi-part (sharded) GGUF. The HF passthrough
 * registry returns a 400 whose message names "sharded GGUF" and links the tracking
 * issue (ollama/ollama#5245). The catalog already flags sharded quants so the UI
 * disables Install — this classifier is defense-in-depth for the pull-by-name path
 * (a raw `hf.co/<repo>:<quant>` typed into the search box) so the caller can show
 * an actionable message instead of the raw 400. Match the phrase plus the 400 so
 * an unrelated 400 can't slip through.
 * @param {string|null|undefined} error
 */
function isShardedGgufError(error) {
  if (!error) return false
  const str = String(error)
  return /\b400\b/.test(str) && /sharded gguf/i.test(str)
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

// safeJSONParse imported from fileUtils provides identical null-on-failure semantics.
const safeParse = (line) => safeJSONParse(line, null);

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
  modelDetailsCache.delete(modelId)
  console.log(`🗑️ Ollama deleted: ${modelId}`)
  return { success: true, modelId }
}

// ---- local-disk introspection / import (migrate fast-path) ------------------

/** Ollama's models root: `$OLLAMA_MODELS` or `~/.ollama/models`. */
function getModelsDir() {
  return process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')
}

/**
 * Enumerate Ollama manifests directly from disk so a stopped daemon does not
 * erase downloaded inventory. A corrupt or unreadable manifest rejects the
 * scan: counted UI must not turn unreadable state into a trustworthy empty.
 */
async function listStoredModels() {
  const manifestsDir = join(getModelsDir(), 'manifests')
  const root = await stat(manifestsDir).then((entry) => entry.isDirectory(), (err) => {
    if (err?.code === 'ENOENT') return false
    throw err
  })
  if (!root) return []

  const registries = (await readdir(manifestsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  const models = []
  for (const registry of registries) {
    const registryDir = join(manifestsDir, registry.name)
    const namespaces = (await readdir(registryDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
    for (const namespace of namespaces) {
      const namespaceDir = join(registryDir, namespace.name)
      const names = (await readdir(namespaceDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
      for (const name of names) {
        const nameDir = join(namespaceDir, name.name)
        const tags = (await readdir(nameDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
        for (const tag of tags) {
          const manifest = await readJSONFile(join(nameDir, tag.name), null, { logError: false, strict: true })
          if (!manifest) throw new Error(`Ollama manifest disappeared during inventory: ${tag.name}`)
          const sizes = manifestBlobRefs(manifest).map((blob) => blob.size)
          const size = sizes.length > 0 && sizes.every(Number.isFinite)
            ? sizes.reduce((sum, value) => sum + value, 0)
            : null
          const localRegistry = registry.name === 'registry.ollama.ai'
          const localNamespace = namespace.name === 'library'
          const base = localRegistry && localNamespace
            ? name.name
            : localRegistry
              ? `${namespace.name}/${name.name}`
              : `${registry.name}/${namespace.name}/${name.name}`
          const id = `${base}:${tag.name}`
          models.push({ id, name: id, size })
        }
      }
    }
  }
  return models.sort((a, b) => (b.size || 0) - (a.size || 0))
}

const fileExists = (p) => stat(p).then((s) => s.isFile()).catch(() => false)
const readManifest = (p) => readJSONFile(p, null, { logError: false })
// One expression for the canonical manifest path, so the recovery writer and
// findManifest's reader can't drift apart.
const manifestPathFor = (modelsDir, ref) => join(modelsDir, ...ollamaManifestRelPath(ref).split('/'))

// The canonical manifest path covers registry-pulled models; fall back to a
// shallow scan of manifests/<registry>/<namespace>/<name>/<tag> for custom
// registries/namespaces we didn't guess.
async function findManifest(modelsDir, ref) {
  const direct = await readManifest(manifestPathFor(modelsDir, ref))
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
 * Fetch a Hugging Face registry document (manifest or blob) as a Buffer, with a
 * timeout generous enough for HF's slow cold-CDN small-blob path (the very thing
 * Ollama's own deadline gives up on). Carries the user's HF token when they have
 * one, so a gated repo Ollama could pull is recoverable too.
 * @returns {Promise<{ buffer: Buffer }|{ error: string }>}
 */
async function fetchHuggingFaceDocument(url, headers) {
  return fetchWithTimeout(url, { headers }, HF_FINALIZE_TIMEOUT_MS)
    .then(async (response) => (response.ok
      ? { buffer: Buffer.from(await response.arrayBuffer()) }
      : { error: `${response.status} ${response.statusText}` }))
    .catch((err) => ({ error: describeFetchError(err) }))
}

/**
 * Finish a Hugging Face pull that downloaded its weights but died before Ollama
 * wrote the manifest (see HF_FINALIZE_TIMEOUT_MS). Re-fetches the manifest, then
 * for each blob it references: keeps an on-disk blob whose size already matches,
 * and downloads + digest-verifies any small missing one. Only when EVERY blob is
 * present and correct does it write the manifest — a half-written manifest would
 * leave `ollama run` failing on a missing blob, which is worse than no model.
 *
 * Digest verification is the whole safety story here: we are hand-placing files
 * into Ollama's content-addressed store, so a byte we didn't verify is a corrupt
 * model that reports as installed.
 *
 * Pure disk + network: the caller owns the `installedModels` cache bust, so this
 * stays safe to call from a future "repair this install" action.
 *
 * @param {string} modelId e.g. `hf.co/<owner>/<repo>:Q8_0`
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function finalizeHuggingFacePull(modelId) {
  const ref = parseOllamaModelRef(modelId)
  const base = huggingFaceRegistryBase(ref)
  if (!base) return { success: false, error: 'not a Hugging Face model ref' }

  const modelsDir = getModelsDir()
  const blobsDir = join(modelsDir, 'blobs')
  // Imported lazily: hfToken.js reaches settings.js, which resolves its file
  // path from PATHS at module load — a static import would drag that (and
  // everything settings pulls in) into every consumer of this module.
  const { getHfToken } = await import('./hfToken.js')
  const headers = buildHfAuthHeaders(await getHfToken())
  const fetched = await fetchHuggingFaceDocument(`${base}/manifests/${ref.tag}`, headers)
  if (fetched.error) return { success: false, error: `manifest fetch failed: ${fetched.error}` }

  const manifestText = fetched.buffer.toString('utf8')
  const refs = manifestBlobRefs(safeJSONParse(manifestText, null))
  if (refs.length === 0) return { success: false, error: 'manifest listed no blobs' }

  for (const blob of refs) {
    const blobPath = join(blobsDir, blob.filename)
    const existing = await stat(blobPath).then((s) => s.size, () => null)
    // Ollama already verified anything it finished writing, so a size match is
    // enough to accept it — re-hashing a 30GB weight layer would take minutes.
    if (existing !== null && existing === blob.size) continue
    if (blob.size === null || blob.size > HF_FINALIZE_MAX_BLOB_BYTES) {
      return { success: false, error: `blob ${blob.filename} (${blob.size ?? 'unknown'} bytes) is missing and too large to recover` }
    }
    const got = await fetchHuggingFaceDocument(`${base}/blobs/${blob.digest}`, headers)
    if (got.error) return { success: false, error: `blob ${blob.filename} fetch failed: ${got.error}` }
    const hex = createHash('sha256').update(got.buffer).digest('hex')
    if (hex !== blob.hex) return { success: false, error: `blob ${blob.filename} failed digest verification` }
    await atomicWrite(blobPath, got.buffer)
    console.log(`🧩 Ollama pull recovery: restored blob ${blob.filename.slice(0, 19)} (${got.buffer.length}B) for ${modelId}`)
  }

  // Ollama leaves `<blob>-partial*` scratch files behind for the download it
  // abandoned; they'd shadow the completed blobs on a future resume attempt. One
  // pass over the (potentially large) blobs dir clears every blob's leftovers.
  const scratch = await readdir(blobsDir).catch(() => [])
  await Promise.all(scratch
    .filter((name) => refs.some((blob) => name.startsWith(`${blob.filename}-partial`)))
    .map((name) => unlink(join(blobsDir, name)).catch(() => {})))

  // Write the manifest byte-for-byte as the registry served it so the digest
  // Ollama derives from it matches the registry's.
  await atomicWrite(manifestPathFor(modelsDir, ref), manifestText)
  console.log(`✅ Ollama pull recovery: wrote manifest for ${modelId} (${refs.length} blobs verified)`)
  return { success: true }
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
  await ensureDir(dirname(blobPath))
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
  const baseModels = available ? await getInstalledModels(true) : []
  // Enrich with native context length + capabilities (cached /api/show per
  // model) so the model cards + selector dropdowns can show each model's window
  // and so vision-capable models are detected from their reported capabilities.
  const models = available ? await enrichWithModelDetails(baseModels) : baseModels
  const service = await getServiceStatus().catch(() => ({ supported: false, manager: null, running: false, runAtStartup: false, status: null }))
  return {
    available,
    baseUrl: config.baseUrl,
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
      applied: available ? appliedContextLength : null,
      agentMinimum: OLLAMA_AGENT_MIN_CONTEXT
    },
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

export {
  getInstalledModels,
  getModelCapabilities,
  getLoadedModels,
  getLoadedModelsAt,
  getLastInstalledModelsError,
  getLastLoadedModelsError,
  unloadModel,
  pullModel,
  importModelFromHfSafetensors,
  deleteModel,
  getStatus,
  getBaseUrl,
  resolveLocalModel,
  importModelFromGguf,
  startServer,
  stopServer,
  ensureContextWindow,
  restartWithEnv,
  getRuntimeContextLength,
  startPersistentService,
  stopPersistentService,
  ensureRunning,
  ensureProviderReady,
  isOllamaProvider,
  getServiceStatus,
  getModelsDir,
  listStoredModels,
  getEmbeddings,
  isBootstrapConflictError,
  isPullDeadlineError,
  finalizeHuggingFacePull
}
