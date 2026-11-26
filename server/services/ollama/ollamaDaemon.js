/** Controls the Ollama daemon, its native HTTP connection, and its platform service and launch environment. */

import { execFile, spawn } from '../../lib/childProcess.js'
import { promisify } from 'util'
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js'
import { readResponseJson } from '../../lib/readResponseJson.js'
import { describeFetchError } from '../../lib/fetchErrorChain.js'
import { sleep } from '../../lib/fileUtils.js'
import { commandExists } from '../../lib/commandExists.js'
import {
  OLLAMA_CONTEXT_ENV_VAR,
  managedOllamaBaseUrl,
  normalizeOllamaBaseUrl,
  resolveOllamaContextLength,
  withOllamaContextEnv,
} from '../../lib/ollamaContext.js'
import { isLocalInstanceEndpoint } from '../../lib/localEndpoint.js'
import { localRuntimeKind } from '../../lib/modelPinMembership.js'
import { createSingleFlight } from '../../lib/singleFlight.js'
import { resetModelListCache } from './ollamaModelCache.js'

const execFileAsync = promisify(execFile)
const AVAILABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

// Short probe — degrade to "no Ollama" fast rather than block on a cold check.
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 12_000
const STOP_TIMEOUT_MS = 8_000
const SERVICE_COMMAND_TIMEOUT_MS = 20_000
const PROCESS_IDENTITY_TIMEOUT_MS = 2_000

const DEFAULT_CONFIG = {
  // Ollama uses OLLAMA_HOST (host:port, no scheme) by convention; also accept
  // an explicit OLLAMA_URL. Normalize to a scheme + no trailing slash + no /v1.
  baseUrl: normalizeOllamaBaseUrl(managedOllamaBaseUrl()),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS
}

let config = { ...DEFAULT_CONFIG }
let isAvailable = null
let lastCheckAt = null
let _managedProcess = null
let managedProcessPid = null
// Starts never overlap: two racing launches of one daemon kill or orphan each other.
const startFlight = createSingleFlight({ exclusive: true })
const ensureFlight = createSingleFlight({ exclusive: true })
// What PortOS knows about the Ollama daemon that is up RIGHT NOW. Every field
// describes ONE live process, so the whole record is written by `recordDaemon`
// and dropped by `forgetDaemon` — "which env" and "which process" can never
// describe two different daemons.
//
// `known` is the record's only sentinel, and the one thing a reader tests before
// trusting the rest: "do we know the launch env this daemon holds?".
// `recordDaemon` is the sole writer, so it cannot drift from `envSignature`.
//
// - `envSignature` — the FULL launch env the live daemon was started with, so a
//   second request for the same tuning is a no-op instead of another restart. A
//   sweep measures every model under one tuning; without this it would stop,
//   start, and cold-load the daemon once per model, and every first sample would
//   time a fresh page-in rather than the model. `''` is a real value ("this
//   daemon holds nothing"), which is why the sentinel is `known` rather than a
//   null signature.
// - `contextLength` — the OLLAMA_CONTEXT_LENGTH PortOS handed this daemon. It is
//   what stops `ensureContextWindow` from restarting in a loop: Ollama is free to
//   load a model at less than the requested window (it fits the KV cache to
//   VRAM), and re-reading a smaller `/api/ps` value as "not applied yet" would
//   bounce the daemon before every single agent spawn. Once a window has been
//   handed over, that request is done.
// - `identity` — PID set for the daemon that received that handoff. See
//   `daemonStillLatched` for why a missing identity is "no evidence".
let daemon = { known: false, envSignature: null, contextLength: null, identity: null }

// The launch env PortOS has put in front of Ollama and has NOT taken back yet.
// Deliberately OUTSIDE `daemon` because it outlives it: `daemon` answers "does
// the daemon that is up right now hold this env?", so losing sight of the daemon
// drops it, while this answers "what has PortOS put in front of Ollama that has
// not been cleared yet?" — which a clear needs even when the daemon it was
// applied to is gone. Only a NAMED env replaces it; nothing clears it.
// `null` = PortOS has recorded no env. The clear list is this object's KEYS,
// read off it rather than tracked separately where the two could disagree.
let appliedEnv = null

// The subset of those names that went into the launchd DOMAIN via
// `launchctl setenv` (the homebrew launch-at-login path). Tracked separately
// because a domain variable outlives every daemon: every job started afterwards
// inherits it, so clearing means unsetting it BY NAME. Omitting it from the next
// start does nothing. Emptied only by a successful unset.
let exportedLaunchdKeys = []

// The outstanding assessment tuning: `{ baselineEnv }` while one is active,
// where `baselineEnv` is the launch env the daemon carried BEFORE it went on;
// `null` when none is outstanding. Read through `activeBaselineEnv`.
//
// The baseline an untuned assessment restores is what THIS INSTALL runs by
// default, not an empty environment — `ensureContextWindow` puts the user's
// configured agent context window on the same `OLLAMA_CONTEXT_LENGTH` a tuning
// uses, and stripping it in the name of measuring "backend defaults" would
// silently undo a setting the user chose on the LLMs page. Same rule as
// `llamaServerManager`'s `preTuningConfig`, for the same reason.
//
// Named `activeTuning`, not `tuning`, so `restartWithEnv`'s `{ tuning }` option
// cannot shadow it — a shadowed assignment there would silently write the
// parameter instead of the module's record.
let activeTuning = null

const envSignature = (env) => Object.entries(env || {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`)
  .join(',')

/**
 * Record what PortOS knows about the daemon that is up right now.
 *
 * `identity` is the process identity to latch against — a spawned child's PID,
 * or the probed identity of a service PortOS restarted.
 *
 * A `null` env means "a daemon is up, but PortOS cannot name its launch env":
 * the record stops being `known`, and `appliedEnv` is deliberately left alone.
 * Not knowing which daemon is up says nothing about whether the variables PortOS
 * exported are still in front of Ollama, and forgetting them would strand a
 * tuning nothing can clear.
 */
function recordDaemon(env, identity) {
  daemon = {
    known: Boolean(env),
    envSignature: env ? envSignature(env) : null,
    // A restart that named no window leaves Ollama on its VRAM-based auto-pick,
    // which is not a window PortOS can claim — so the context latch is dropped
    // rather than crediting the new process with the old one's window.
    contextLength: resolveOllamaContextLength(null, env || {}),
    identity: identity || null
  }
  if (env) appliedEnv = { ...env }
}

/** The daemon we knew about is gone; whatever comes up next has to be re-checked. */
const forgetDaemon = () => recordDaemon(null, null)

/** A copy of what PortOS has in front of Ollama, or `{}` when it has recorded none. */
const appliedEnvCopy = () => (appliedEnv ? { ...appliedEnv } : {})

/**
 * The launch env an outstanding tuning displaced, or `fallback` when no tuning
 * is outstanding.
 *
 * The fallback belongs to the CALLER rather than to this function, because the
 * two sites ask different questions of the same record and one expression
 * cannot answer both: `restartWithEnv` asks "what is this tuning about to
 * displace?" (an unknown daemon displaces `{}` — PortOS knows of no env to put
 * back), while `clearLaunchEnv` asks "is there anything to undo at all?"
 * (`null` = nothing, and it returns without bouncing the daemon). What they must
 * NOT disagree on is that an active tuning's baseline wins, and that lives here.
 */
const activeBaselineEnv = (fallback) => (activeTuning ? activeTuning.baselineEnv : fallback)

/** `null` clears the tuning; any env records it as the baseline to restore. */
const setTuning = (baselineEnv) => { activeTuning = baselineEnv ? { baselineEnv } : null }

/**
 * Whether the daemon PortOS latched against is still the one answering.
 *
 * Availability alone cannot identify an Ollama process — an external restart can
 * become reachable before PortOS observes a failed probe — so only a CHANGED
 * process identity invalidates a latch. An unreadable identity is not evidence
 * of replacement, and an empty /api/ps response is normal after model eviction
 * and immediately after a restart, so model absence cannot invalidate it either.
 * Treating either as "no evidence" is what keeps an unavailable process probe
 * from creating a restart loop.
 *
 * A mismatch IS positive evidence the daemon was replaced behind PortOS's back,
 * so the record describing the old one is dropped here rather than at each of
 * the two call sites.
 */
async function daemonStillLatched() {
  const currentIdentity = await getOllamaProcessIdentity()
  if (!daemon.identity || !currentIdentity || currentIdentity === daemon.identity) return true
  forgetDaemon()
  return false
}

const status = { lastError: null, lastSuccessAt: null, consecutiveErrors: 0 }

// Whether brew/systemctl exists does not change under a running server, so the
// probe (a `brew --version` spawn) runs once per platform per process.
let serviceControllerProbe = null

function getServiceController() {
  if (serviceControllerProbe?.platform !== process.platform) {
    serviceControllerProbe = { platform: process.platform, promise: probeServiceController() }
  }
  return serviceControllerProbe.promise
}

async function probeServiceController() {
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

// `brew services list` costs ~0.45 s, and a service's state only changes when
// PortOS runs start/stop/restart (which invalidate this) or the user runs brew
// themselves, so a short TTL keeps the status endpoint cheap.
const SERVICE_STATUS_TTL_MS = 10_000
let serviceStatusCache = null // { at, value } | { inflight, generation }
let serviceStatusGeneration = 0

function invalidateServiceStatus() {
  serviceStatusGeneration++
  serviceStatusCache = null
}

function getServiceStatus() {
  const cached = serviceStatusCache
  if (cached) {
    if (cached.inflight) return cached.inflight
    if (Date.now() - cached.at < SERVICE_STATUS_TTL_MS) return Promise.resolve(cached.value)
  }
  const generation = serviceStatusGeneration
  const inflight = readServiceStatus().then((value) => {
    // A mutation that landed while this read was in flight makes it stale.
    if (generation === serviceStatusGeneration) serviceStatusCache = { at: Date.now(), value }
    return value
  }, (err) => {
    if (serviceStatusCache?.inflight === inflight) serviceStatusCache = null
    throw err
  })
  if (generation === serviceStatusGeneration) serviceStatusCache = { inflight }
  return inflight
}

async function readServiceStatus() {
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
  const response = await fetchWithTimeout(`${normalizeOllamaBaseUrl(baseUrl)}${endpoint}`, {
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
    forgetDaemon()
    status.lastError = describeFetchError(err)
    status.consecutiveErrors++
    lastCheckAt = now
    return false
  }
}

function resetAvailabilityCache() {
  isAvailable = null
  lastCheckAt = null
  resetModelListCache()
}

async function waitForAvailability(expected, timeoutMs, shouldAbort = () => false) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !shouldAbort()) {
    if ((await checkOllamaAvailable(true)) === expected) return true
    if (!shouldAbort()) await sleep(400)
  }
  return !shouldAbort() && (await checkOllamaAvailable(true)) === expected
}

function rememberManagedProcess(child) {
  _managedProcess = child
  managedProcessPid = child.pid
  child.on('exit', () => {
    if (managedProcessPid === child.pid) {
      _managedProcess = null
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
 * Single-flight per launch env: concurrent callers asking for the same env
 * share one spawn and one result. Two racing `ollama serve` children left the
 * loser to fail its bind and exit, and its exit cleared `managedProcessPid`,
 * leaving the surviving daemon untracked and unstoppable on Windows. A caller
 * asking for a DIFFERENT env waits for the in-flight start, then runs its own,
 * which sees the daemon up and reports `alreadyRunning` exactly as a
 * sequential call would, instead of claiming a start under an env it never got.
 *
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {Promise<{ success: boolean, running?: boolean, alreadyRunning?: boolean, pid?: number, error?: string }>}
 */
function startServer({ env = null } = {}) {
  return startFlight.run(envSignature(env), () => spawnServer(env))
}

async function spawnServer(env) {
  if (await checkOllamaAvailable(true)) {
    return { success: true, running: true, alreadyRunning: true }
  }

  const contextLength = resolveOllamaContextLength(null, env || {})
  let spawnError = null
  let notifySpawnFailure = null
  // `spawn()` reports a missing executable asynchronously. Waiting only for the
  // HTTP probe in that case turns an immediate ENOENT into a 12-second startup
  // timeout, obscuring the one useful diagnosis and needlessly delaying a
  // fallback. Keep the probe for a real daemon startup, but let a spawn failure
  // settle this attempt as soon as Node reports it.
  const spawnFailed = new Promise((resolve) => { notifySpawnFailure = resolve })
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
  child.on('error', (err) => {
    spawnError = err
    notifySpawnFailure(err)
  })
  child.unref()

  const startup = await Promise.race([
    waitForAvailability(true, START_TIMEOUT_MS, () => spawnError !== null).then((running) => ({ running, error: null })),
    spawnFailed.then((error) => ({ running: false, error })),
  ])
  const running = startup.running
  if (running) {
    // A daemon PortOS just started carries exactly `env` and nothing else, so
    // there is no earlier tuning left to undo. `restartWithEnv` re-asserts its
    // own baseline after this returns — see the note there. Mirrors
    // `llamaServerManager`'s `startLlamaServer`.
    setTuning(null)
    recordDaemon(env, String(child.pid))
    const window = contextLength ? ` (context ${contextLength})` : ''
    console.log(`▶️ Started Ollama server (pid ${child.pid})${window}`)
    return { success: true, running: true, pid: child.pid }
  }

  const detail = startup.error?.code === 'ENOENT'
    ? 'Ollama CLI is not installed or is not on PortOS\'s PATH. Install Ollama from https://ollama.com/download, then restart PortOS.'
    : spawnError?.message || stderr.join('').trim()
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
  invalidateServiceStatus()
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
  invalidateServiceStatus()
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

// Single-flight like `startServer`: concurrent `brew services start` calls
// trip the bootstrap-conflict recovery, whose bootout stops the daemon the
// other caller just started.
function ensureRunning({ preferPersistent = false } = {}) {
  const persistent = Boolean(preferPersistent)
  return ensureFlight.run(persistent, () => bringUp(persistent))
}

async function bringUp(preferPersistent) {
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
    if (!exportedLaunchdKeys.includes(key)) exportedLaunchdKeys.push(key)
  }

  const bounced = await bounceService()
  if (!bounced.ok) return bounced.failure
  recordDaemon(env, await getOllamaProcessIdentity())
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
  invalidateServiceStatus()
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
  // An unknown daemon (`!daemon.known`) displaces `{}` — PortOS knows of no env
  // to put back — never a stale record of some earlier daemon's.
  const before = activeBaselineEnv(null)
  const captured = activeBaselineEnv(daemon.known ? appliedEnvCopy() : {})

  const result = await applyLaunchEnv(env, entries)
  // Asserted AFTER the restart, never before: `startServer`/`stopServer` drop
  // the baseline as a matter of course (a daemon PortOS just started is untuned
  // by construction), so anything written up front would be wiped mid-call.
  //
  // A restart that did not happen changed nothing, so the bookkeeping must not
  // move either.
  //
  // When a non-tuning restart (`tuning: false`, e.g. `ensureContextWindow`) occurs
  // while a tuning is active (`before !== null`), preserve the pre-tuning undo
  // baseline rather than clearing it, but update its context window so that a
  // later `clearLaunchEnv()` restores the untuned daemon with the new context
  // length rather than reverting it. If no tuning was active (`before === null`),
  // no tuning is outstanding afterwards either.
  if (result.applied === false) {
    setTuning(before)
  } else if (tuning) {
    setTuning(captured)
  } else if (before) {
    setTuning(withOllamaContextEnv(before, env[OLLAMA_CONTEXT_ENV_VAR]))
  } else {
    setTuning(null)
  }
  return result
}

// The restart itself, with `restartWithEnv` owning the baseline bookkeeping
// around it so no exit below has to remember to unwind it.
async function applyLaunchEnv(env, entries) {
  // The daemon that is up may already BE this tuning — a sweep measures every
  // model under one knob set, and restarting per model would cold-load each one
  // and time the page-in as if it were the model's throughput. Same evidence
  // rule as the context latch, and for the same reason — see
  // `daemonStillLatched`.
  if (daemon.known && daemon.envSignature === envSignature(env) && await checkOllamaAvailable(true) && await daemonStillLatched()) {
    return { applied: true, reason: 'already-applied' }
  }

  // A key the PREVIOUS env exported into the launchd domain and this one does
  // not name is STILL set, and every job started afterwards inherits it — so the
  // daemon would come back carrying half the old configuration. Omitting a
  // variable is not clearing it. Done here rather than in the service path
  // alone, because a spawned daemon started while a service is registered
  // inherits the same domain.
  const stale = exportedLaunchdKeys.filter((key) => !(key in env))
  if (stale.length) {
    const cleared = await unsetLaunchdKeys(stale)
    if (!cleared.success) return { applied: false, reason: 'unsetenv-failed', error: cleared.error }
    exportedLaunchdKeys = exportedLaunchdKeys.filter((key) => key in env)
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
 * "Before PortOS tuned it" is the active tuning's baseline, NOT an empty
 * environment — see the note on `activeTuning`. Only when that baseline is
 * itself empty does this tear the launch env down to nothing.
 */
async function clearLaunchEnv() {
  // Variables PortOS exported are outstanding even when no tuning reached the
  // daemon — a `setenv` that landed before its restart failed. They sit in the
  // launchd domain, so the daemon that came up NEXT inherited them and is tuned
  // however this record reads. Taking them out is not enough: that daemon holds
  // them in its own process environment and has to be restarted too, which is
  // exactly what an empty baseline already means here.
  const baseline = activeBaselineEnv(exportedLaunchdKeys.length ? {} : null)
  // Nothing outstanding at all. `null` — not `false` — because no request was
  // refused: the daemon already serves the configuration being asked for.
  if (baseline === null) return { applied: null, reason: 'already-untuned' }

  const keys = [...new Set([...Object.keys(appliedEnv ?? {}), ...exportedLaunchdKeys])]
  console.log(`🔧 Clearing the Ollama tuning PortOS applied (${keys.join(', ')})`)
  setTuning(null)

  // A non-empty baseline is just "restart under this env", which the normal
  // path already does — including taking the tuning's leftover launchd
  // variables back out of the domain. It is not an APPLICATION though: the run
  // asked for no tuning, so a success records `null`.
  if (Object.keys(baseline).length > 0) {
    const restored = await restartWithEnv(baseline, { tuning: false })
    if (restored.applied === false) {
      setTuning(baseline)
      return restored
    }
    return { ...restored, applied: null }
  }

  const exported = exportedLaunchdKeys
  // Domain variables come out FIRST, and regardless of whether a daemon is up:
  // they outlive the process that read them, so a login-launched Ollama would
  // otherwise come back tuned long after this run recorded "backend defaults".
  if (exported.length) {
    const unset = await unsetLaunchdKeys(exported)
    if (!unset.success) {
      setTuning(baseline)
      return { applied: false, reason: 'unsetenv-failed', error: unset.error }
    }
    exportedLaunchdKeys = []
  }

  const running = await checkOllamaAvailable(true)
  const service = await getServiceStatus().catch(() => null)

  // Nothing to restart. The domain is already clear and a daemon PortOS spawns
  // inherits the PortOS process environment, so whatever comes up next is
  // untuned either way.
  if (!running) {
    recordDaemon({}, null)
    return { applied: null, reason: 'not-running' }
  }

  // Every failure below leaves the daemon still tuned, so the baseline goes back
  // on the books for a later run to retry.
  const failed = (result) => {
    setTuning(baseline)
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
    recordDaemon({}, await getOllamaProcessIdentity())
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

/**
 * Whether `provider` is backed by the daemon THIS instance manages. A provider with an
 * endpoint must resolve to a local one: a federated/tailnet "Ollama (Peer)" record is a
 * remote daemon, and treating it as local would try to launch `ollama serve` here.
 */
function isOllamaProvider(provider) {
  const endpoint = provider?.endpoint
  if (endpoint && !isLocalInstanceEndpoint(endpoint)) return false
  if (localRuntimeKind(provider) === 'ollama') return true
  // A custom OLLAMA_URL / OLLAMA_HOST port is not the default 11434 the kind check knows.
  return Boolean(endpoint) && sameDaemonOrigin(endpoint, getBaseUrl())
}

function sameDaemonOrigin(endpoint, baseUrl) {
  const origin = (value) => {
    const parsed = safeUrl(String(value || '').replace(/\/v\d+\/?$/, ''))
    return parsed ? `${parsed.protocol}//${parsed.host}` : null
  }
  const a = origin(endpoint)
  return a !== null && a === origin(baseUrl)
}

function safeUrl(value) {
  try { return new URL(value) } catch { return null }
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
  // separately, by `exportedLaunchdKeys`.) Done in one place rather than at each
  // success return, where a fourth stop path would silently miss it.
  if (stopped.success) setTuning(null)
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
 * Ollama's reported version, or `null` when it isn't answering. Exported so the
 * assessment store can record WHICH backend build a measurement was taken
 * against — a backend update is one of the things that makes a stored reading
 * stale, and there is no other way to notice it after the fact.
 */
export async function getVersion() {
  const data = await ollamaRequest('/api/version', { timeout: AVAILABILITY_PROBE_TIMEOUT_MS }).catch(() => null)
  return data?.version || null
}

/**
 * Base URL shared by the daemon client and model-management callers.
 * Used by sibling services (e.g. the local code-review endpoint) so the
 * catalog UI and the code-review path can't desync.
 */
function getBaseUrl() {
  return config.baseUrl
}

const getAppliedContextLength = () => daemon.contextLength
const getAvailabilityErrors = () => ({
  lastError: status.lastError,
  consecutiveErrors: status.consecutiveErrors,
})

export {
  appliedEnvCopy,
  checkOllamaAvailable,
  daemonStillLatched,
  ensureProviderReady,
  ensureRunning,
  getAppliedContextLength,
  getAvailabilityErrors,
  getBaseUrl,
  getServiceStatus,
  isOllamaProvider,
  ollamaRequest,
  ollamaRequestAt,
  restartWithEnv,
  startPersistentService,
  startServer,
  stopPersistentService,
  stopServer
}
