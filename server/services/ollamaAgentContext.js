import { isTruthyMeta } from '../lib/metadataFlags.js';
/**
 * Pre-spawn context-window preparation for Ollama-backed *agent harnesses*
 * (`claude-ollama`, `opencode-ollama`, ...).
 *
 * The harness talks to Ollama directly, so the only lever is the daemon's
 * `OLLAMA_CONTEXT_LENGTH`: a provider's `numCtx` is enforced by (re)loading the
 * daemon at that window before the harness starts. Without `numCtx` nothing is
 * restarted, but a too-small window is warned about up front
 * (`exceed_context_size_error` would otherwise kill the run late).
 * `dropUnsupportedOllamaThinking` likewise resolves the model's reasoning
 * capability ahead of the spawn.
 */

import { isOllamaBackedProvider } from './provider/providers.js'
// Straight from `internal/`: deliberately not re-exported from providers.js, so
// the normalization cannot drift.
import { ollamaBaseFromProvider, withModelNumCtx } from '../lib/aiToolkit/internal/ollamaBacked.js'
import {
  OLLAMA_AGENT_MIN_CONTEXT,
  describeOllamaContextTooSmall,
  isSameOllamaDaemon,
  resolveOllamaContextLength
} from '../lib/ollamaContext.js'
import { ensureContextWindow, getBaseUrl, getModelCapabilities, getRuntimeContextLength } from './ollamaManager.js'
import { LIFECYCLE_LINES } from '../lib/agent/agentOutputMarkers.js'

/**
 * Prepare the Ollama daemon for an agent harness run.
 *
 * Never throws and never blocks a spawn: a daemon that refuses to restart is
 * reported through `warning`. Non-Ollama providers return `{ skipped: true }`.
 *
 * @param {{id?:string, name?:string, defaultModel?:string|null, numCtx?:number|null, envVars?:object, endpoint?:string, ollamaBacked?:boolean}|null} provider
 * @param {{ env?: Record<string, string|undefined>, model?: string|null }} [options]
 * @returns {Promise<{ skipped: boolean, contextLength?: number|null, applied?: boolean, warning?: string|null }>}
 */
export async function ensureOllamaAgentContext(provider, { env = process.env, model = provider?.defaultModel ?? null } = {}) {
  if (!provider || !isOllamaBackedProvider(provider)) return { skipped: true }
  // `ollamaManager` only controls the LOCAL daemon; acting on it for a remote
  // provider would reload an unrelated daemon.
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), getBaseUrl())) {
    return { skipped: true, reason: 'remote-daemon' }
  }

  const contextLength = resolveOllamaContextLength(withModelNumCtx(provider, model), env)
  const providerName = provider.name || provider.id || null

  if (!contextLength) {
    const runtime = await (model ? getRuntimeContextLength(model) : getRuntimeContextLength()).catch(() => null)
    const warning = runtime != null && runtime < OLLAMA_AGENT_MIN_CONTEXT
      ? describeOllamaContextTooSmall(runtime, { providerName })
      : null
    if (warning) console.warn(warning)
    return { skipped: false, contextLength: null, applied: false, warning }
  }

  const result = await (model
    ? ensureContextWindow(contextLength, model)
    : ensureContextWindow(contextLength)
  ).catch((err) => ({
    applied: false, reason: 'error', error: err.message
  }))
  const warning = result.error
    ? LIFECYCLE_LINES.ollamaReloadFailed({ contextLength, error: result.error, who: providerName || 'the run' })
    : null
  if (warning) console.warn(warning)
  return { skipped: false, contextLength, applied: !!result.applied, warning }
}

/**
 * Does this run's Ollama model reject a thinking request?
 *
 * `true` only when `/api/show` answered with capabilities that omit `thinking`; a
 * failed probe or empty list means unknown, not unsupported. A REMOTE daemon is
 * never probed. Mirrors `modelRejectsThinking` in `codeReview.js`.
 *
 * @param {object|null} provider
 * @param {string|null} model
 * @returns {Promise<boolean>}
 */
export async function ollamaModelRejectsThinking(provider, model) {
  if (!model || !provider || !isOllamaBackedProvider(provider)) return false
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), getBaseUrl())) return false
  const capabilities = await getModelCapabilities(model).catch(() => null)
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false
  return !capabilities.includes('thinking')
}

/**
 * Drop a run's reasoning controls when its Ollama model cannot think.
 *
 * Ollama rejects the WHOLE request (`"<model>" does not support thinking`) for
 * `think: true` or an OpenAI-compatible `reasoning_effort`, so an `effort: medium`
 * agent on a non-reasoning model (gemma3) dies on its first turn. The level is
 * meaningless there, so it is dropped once per spawn on the shared provider so the
 * `--effort` argv and OpenCode's config block agree. `thinking: false` is kept.
 *
 * @param {object|null} provider - the run's provider, task overrides already merged
 * @param {string|null} model - the model this run was dispatched with
 * @param {string|null} [effort] - the run's effort level, as passed to the argv builders
 * @returns {Promise<{provider: object|null, effort: string|null, dropped: boolean}>}
 */
export async function dropUnsupportedOllamaThinking(provider, model, effort = null) {
  const keep = { provider, effort, dropped: false }
  const wantsThinking = !!effort
    || (typeof provider?.effort === 'string' && provider.effort.trim() !== '')
    || isTruthyMeta(provider?.thinking)
  if (!wantsThinking) return keep
  if (!await ollamaModelRejectsThinking(provider, model)) return keep

  const { effort: _requestedEffort, thinking: _requestedThinking, ...rest } = provider
  console.log(`⏭️ ${model} does not support thinking — running without a reasoning effort`)
  return { provider: { ...rest, thinking: false }, effort: null, dropped: true }
}
