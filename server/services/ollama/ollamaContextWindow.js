/** Inspects resident Ollama context sizes and coordinates context-window reloads with in-flight callers. */

import { withOllamaContextEnv } from '../../lib/ollamaContext.js'
import {
  appliedEnvCopy,
  checkOllamaAvailable,
  daemonStillLatched,
  getAppliedContextLength,
  ollamaRequest,
  restartWithEnv,
} from './ollamaDaemon.js'

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

// In-flight work registry. A daemon restart drops every request on every model,
// so callers that hold a request or agent run open on this daemon register here
// and `ensureContextWindow` waits for them to drain instead of killing them.
const inFlightWork = new Set()
let drainWaiters = []
let reloadGate = null
export const CONTEXT_RELOAD_DRAIN_TIMEOUT_MS = 120_000

/**
 * Mark a unit of work (API request, prompt run, agent run) as using the daemon.
 * @returns {() => void} idempotent release
 */
function beginOllamaWork() {
  const token = {}
  inFlightWork.add(token)
  return () => {
    if (!inFlightWork.delete(token) || inFlightWork.size > 0) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve(true)
  }
}

/**
 * `beginOllamaWork` once no reload is in progress. Registers in the same turn as the
 * final gate check: registering after a separate awaited wait resumes microtasks later,
 * long enough for another caller to see an empty registry and start a new reload.
 * @returns {Promise<() => void>} idempotent release
 */
async function beginOllamaWorkAfterReload() {
  while (reloadGate) await reloadGate
  return beginOllamaWork()
}

const getInFlightOllamaWorkCount = () => inFlightWork.size

/** Resolves true once nothing is in flight, false after `timeoutMs`. */
function waitForOllamaDrain(timeoutMs = CONTEXT_RELOAD_DRAIN_TIMEOUT_MS) {
  if (inFlightWork.size === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const waiter = (drained) => { clearTimeout(timer); resolve(drained) }
    const timer = setTimeout(() => {
      drainWaiters = drainWaiters.filter((w) => w !== waiter)
      resolve(false)
    }, timeoutMs)
    drainWaiters.push(waiter)
  })
}

/** The window a resident model was actually loaded at (`/api/ps`), or null when not resident/unknown. */
async function getResidentModelContext(model) {
  const wanted = typeof model === 'string' ? model.trim() : ''
  if (!wanted) return null
  const models = await getRuntimeModels()
  const hit = models?.find((m) => modelNames(m).includes(wanted))
  const n = Number(hit?.context_length)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Hold the Ollama daemon at (at least) `contextLength` tokens, reloading it with
 * that window when it is running at a smaller one.
 *
 * Reloading a daemon is disruptive, so it happens at most once per daemon per
 * window (the `daemon.contextLength` latch) and never when a resident model is
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

  // Compose the context-window env ON TOP OF the currently applied launch env
  // instead of replacing it, so a reload preserves knobs (e.g.
  // OLLAMA_FLASH_ATTENTION, OLLAMA_KV_CACHE_TYPE) that are not about the window.
  // `appliedEnv` outlives the `daemon` record specifically to answer "what has
  // PortOS put in front of Ollama that has not been cleared yet", so an active
  // tuning is preserved even if the daemon was temporarily down.
  // When a tuning is active mid-sweep, preserving its knobs keeps the sweep's
  // measurements comparable rather than demoting the daemon to untuned
  // mid-sweep, while allowing the context window to expand for the harness.
  const env = withOllamaContextEnv(appliedEnvCopy(), target)

  if (!(await checkOllamaAvailable(true))) {
    return { ...(await restartWithEnv(env, { tuning: false })), contextLength: target }
  }

  if (Number(getAppliedContextLength()) >= target && await daemonStillLatched()) {
    return { applied: false, reason: 'already-applied', contextLength: target, runtimeContextLength: getAppliedContextLength() }
  }

  // `runtime == null` means nothing is resident, which is the NORMAL idle state
  // between runs — not a reason to skip. The window Ollama will pick when the
  // harness loads its model is its VRAM-based default, i.e. exactly the one the
  // user set `numCtx` to override, so leaving it alone here would make the
  // setting a no-op in the common case. Apply it; the `daemon.contextLength`
  // latch keeps this to one reload per daemon.
  const runtime = await getRuntimeContextLength(selectedModel)
  if (runtime != null && runtime >= target) {
    return { applied: false, reason: 'already-large-enough', contextLength: target, runtimeContextLength: runtime }
  }

  // Drain, then re-read the window: the wait can be long enough for another caller to have
  // reloaded the daemon already, and work that started meanwhile must be waited for too.
  let currentRuntime = runtime
  const drainDeadline = Date.now() + CONTEXT_RELOAD_DRAIN_TIMEOUT_MS
  while (inFlightWork.size > 0) {
    console.log(`⏳ Ollama reload to ${target} tokens waiting for ${inFlightWork.size} in-flight run(s)`)
    const remaining = drainDeadline - Date.now()
    if (remaining <= 0 || !(await waitForOllamaDrain(remaining))) {
      console.log(`⏭️ Ollama reload to ${target} tokens skipped: ${inFlightWork.size} run(s) still in flight after ${CONTEXT_RELOAD_DRAIN_TIMEOUT_MS}ms`)
      return { applied: false, reason: 'in-flight', contextLength: target, runtimeContextLength: currentRuntime }
    }
    currentRuntime = await getRuntimeContextLength(selectedModel)
    if (currentRuntime != null && currentRuntime >= target) {
      return { applied: false, reason: 'already-large-enough', contextLength: target, runtimeContextLength: currentRuntime }
    }
  }

  console.log(`🪟 Reloading Ollama at a ${target}-token context window (was ${runtime ?? 'unknown'})`)

  // The restart ladder itself — including the rule that a launch-at-login daemon
  // is restarted in place rather than un-registered — lives in `restartWithEnv`.
  // The checks ABOVE are what is specific to a context window: a resident model
  // already big enough, and the >= latch that keeps an agent spawn from bouncing
  // the daemon. Everything below was the same ladder written twice.
  // The gate holds new runs (`beginOllamaWorkAfterReload`) until the restart settles, so none starts on a
  // daemon that is about to be killed.
  let openGate
  reloadGate = new Promise((resolve) => { openGate = resolve })
  try {
    return { ...(await restartWithEnv(env, { tuning: false })), contextLength: target, runtimeContextLength: currentRuntime }
  } finally {
    reloadGate = null
    openGate()
  }
}

export {
  beginOllamaWork,
  beginOllamaWorkAfterReload,
  ensureContextWindow,
  getInFlightOllamaWorkCount,
  getResidentModelContext,
  getRuntimeContextLength,
  waitForOllamaDrain
}
