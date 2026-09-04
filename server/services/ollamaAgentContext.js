/**
 * Pre-spawn context-window preparation for Ollama-backed *agent harnesses*
 * (`claude-ollama`, `claude-ollama-tui`, `opencode-ollama`, …).
 *
 * These providers launch a real CLI/TUI that speaks to Ollama directly, so —
 * unlike `api`-type providers, where the toolkit runner attaches a per-request
 * `num_ctx` — PortOS has no way to influence the window from inside the
 * request. The only lever is the daemon's `OLLAMA_CONTEXT_LENGTH`, which is why
 * a provider's `numCtx` is enforced here by (re)loading the daemon at that
 * window before the harness starts.
 *
 * When the provider carries no `numCtx`, nothing is restarted — Ollama's
 * VRAM-based auto-pick stands — but a too-small window is warned about up
 * front, because the alternative is a run that dies an hour in with
 * `exceed_context_size_error`.
 *
 * The same "prepare the daemon before the harness starts" role covers the
 * model's reasoning capability: Ollama rejects a whole request when a model
 * that never implements thinking is asked to think, so
 * `dropUnsupportedOllamaThinking` resolves that ahead of the spawn too.
 */

import { isOllamaBackedProvider } from './providers.js'
// Straight from `internal/` on purpose: it is deliberately NOT re-exported from
// providers.js, and re-deriving the normalization here is exactly the drift that
// exclusion exists to prevent.
import { ollamaBaseFromProvider } from '../lib/aiToolkit/internal/ollamaBacked.js'
import {
  OLLAMA_AGENT_MIN_CONTEXT,
  describeOllamaContextTooSmall,
  isSameOllamaDaemon,
  resolveOllamaContextLength
} from '../lib/ollamaContext.js'
import { ensureContextWindow, getBaseUrl, getModelCapabilities, getRuntimeContextLength } from './ollamaManager.js'

/**
 * Prepare the Ollama daemon for an agent harness run.
 *
 * Never throws and never blocks a spawn: a daemon that refuses to restart is
 * reported through `warning` (and the run proceeds on whatever window it has)
 * rather than failing the agent before it starts.
 *
 * Non-Ollama providers return `{ skipped: true }`. Call sites gate on
 * `isOllamaBackedProvider` too, so a cloud run takes no async hop at all; this
 * guard is the module's own contract, not the hot path.
 *
 * @param {{id?:string, name?:string, defaultModel?:string|null, numCtx?:number|null, envVars?:object, endpoint?:string, ollamaBacked?:boolean}|null} provider
 * @param {{ env?: Record<string, string|undefined>, model?: string|null }} [options]
 * @returns {Promise<{ skipped: boolean, contextLength?: number|null, applied?: boolean, warning?: string|null }>}
 */
export async function ensureOllamaAgentContext(provider, { env = process.env, model = provider?.defaultModel ?? null } = {}) {
  if (!provider || !isOllamaBackedProvider(provider)) return { skipped: true }
  // A provider can point at a REMOTE Ollama host. `ollamaManager` only ever
  // starts, stops, and inspects the local daemon, so acting on one of those
  // would reload an unrelated local daemon and still leave the provider's real
  // daemon at its old window.
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), getBaseUrl())) {
    return { skipped: true, reason: 'remote-daemon' }
  }

  const contextLength = resolveOllamaContextLength(provider, env)
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
    ? `⚠️ Could not reload Ollama at a ${contextLength}-token window (${result.error}) — ${providerName || 'the run'} continues on the current window.`
    : null
  if (warning) console.warn(warning)
  return { skipped: false, contextLength, applied: !!result.applied, warning }
}

/**
 * Does this run's Ollama model reject a thinking request?
 *
 * `true` only when we KNOW it does — the daemon answered `/api/show` with a
 * capability list that omits `thinking`. A failed probe (`null`) and an empty
 * list both mean *unknown*, not *unsupported*, so they leave the controls
 * alone rather than silently dropping a level the model does accept. Mirrors
 * `modelRejectsThinking` in `codeReview.js`, which solves the same problem for
 * the local code reviewer's own HTTP calls.
 *
 * A provider pointed at a REMOTE daemon is never probed: `ollamaManager` only
 * inspects the local one, so its answer would describe the wrong host.
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
 * Ollama rejects the WHOLE request rather than ignoring a field a model has no
 * answer for — `"<model>" does not support thinking`, both on native
 * `/api/chat` (`think: true`) and through the OpenAI-compatible
 * `reasoning_effort` an OpenCode `agent.*.reasoningEffort` becomes. So an
 * agent dispatched at `effort: medium` onto a non-reasoning local model
 * (gemma3, most plain chat models) dies on its first turn with exit 1 and no
 * output, which is how a `pr-reviewer` stage pinned to `gemma3:27b` failed
 * three times over. The level carries no information for such a model, so
 * dropping it loses nothing; keeping it loses the run.
 *
 * Resolved once per spawn, on the provider every path shares, so the two
 * carriers of the level — the `--effort` argv and OpenCode's config block —
 * cannot disagree. `thinking: false` is preserved: that is a request NOT to
 * think, which every model accepts.
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
    || provider?.thinking === true || provider?.thinking === 'true'
  if (!wantsThinking) return keep
  if (!await ollamaModelRejectsThinking(provider, model)) return keep

  const { effort: _requestedEffort, thinking: _requestedThinking, ...rest } = provider
  console.warn(`⚠️ ${model} does not support thinking — running without a reasoning effort`)
  return { provider: { ...rest, thinking: false }, effort: null, dropped: true }
}
