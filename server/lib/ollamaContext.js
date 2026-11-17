/**
 * Ollama runtime context-window helpers: resolving, pinning and diagnosing the daemon's `n_ctx`.
 *
 * Ollama runtime context-window helpers. Ollama auto-picks `n_ctx` from VRAM, too small for agent harnesses (they size compaction against an Anthropic-sized window and die with `exceed_context_size_error`).
 * Harnesses speak Ollama's endpoints directly, so no per-request `num_ctx` is possible; the only lever is `OLLAMA_CONTEXT_LENGTH` on the daemon PortOS starts.
 * Pure, no I/O: `services/ollamaManager.js` owns the daemon, `services/ollamaAgentContext.js` the pre-spawn enforcement.
 */

// The `internal/` leaf on purpose: the toolkit barrel reaches `fs`/`child_process` and this is in the prompt budgeter and dispatch gate closure (import budget).
import { isOllamaBackedProvider, ollamaBaseFromProvider, withRuntimeContextWindow } from './aiToolkit/internal/ollamaBacked.js'
import { LIFECYCLE_LINES } from './agentOutputMarkers.js'

/** Threshold below which PortOS warns before spawning: 32K (the common VRAM auto-pick) is consumed by scaffold, tools and a few reads. */
export const OLLAMA_AGENT_MIN_CONTEXT = 65536

/** Ollama's own env knob for the daemon-wide default window. */
export const OLLAMA_CONTEXT_ENV_VAR = 'OLLAMA_CONTEXT_LENGTH'

const positiveInt = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * The context window PortOS should hold the Ollama daemon at for `provider`: provider `numCtx`, then ambient `OLLAMA_CONTEXT_LENGTH`, then `null` (leave Ollama's VRAM auto-pick alone:
 * a window larger than VRAM silently offloads layers to CPU, and only the user knows their headroom).
 *
 * @param {{numCtx?: number|null}|null|undefined} provider
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|null}
 */
export function resolveOllamaContextLength(provider, env = process.env) {
  return positiveInt(provider?.numCtx) ?? positiveInt(env?.[OLLAMA_CONTEXT_ENV_VAR])
}

/**
 * The base URL of the Ollama daemon THIS install manages: `OLLAMA_URL`, then the `OLLAMA_HOST` (`host:port`) convention, then the stock local daemon. Half of the `isSameOllamaDaemon` comparison.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function managedOllamaBaseUrl(env = process.env) {
  const raw = String(env?.OLLAMA_URL || env?.OLLAMA_HOST || '').trim()
  return raw || 'http://localhost:11434'
}

/**
 * Normalize an Ollama base URL to a scheme, no trailing slash and no `/v1` (`OLLAMA_HOST` is conventionally a bare `host:port`).
 *
 * @param {string} raw
 */
export function normalizeOllamaBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`
  return url || 'http://localhost:11434'
}

/**
 * The window PortOS holds `provider`'s daemon at, or `null` (VRAM auto-pick stands): {@link resolveOllamaContextLength} gated on the daemon being the one this install manages, since the ambient
 * `OLLAMA_CONTEXT_LENGTH` only reaches the daemon PortOS launches (`withOllamaContextEnv`) and for a REMOTE Ollama would budget to a window nobody set (same gate as `services/ollamaAgentContext.js`).
 * `numCtx` is NOT gated: an `api` provider sends it as `num_ctx`, which binds a remote daemon too.
 *
 * @param {object|null|undefined} provider
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|null}
 */
export function managedOllamaContextLength(provider, env = process.env) {
  if (!isOllamaBackedProvider(provider)) return null
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), managedOllamaBaseUrl(env))) return null
  return resolveOllamaContextLength(provider, env)
}

/**
 * `provider` with that window stamped on, for the prompt budgeter (`services/stageRunner.js#effectiveContextWindow`) and pre-dispatch gate (`services/promptRunner.js#assertRequestFitsContext`).
 * How the env rung reaches the vendored toolkit (which may not import this module): data on an in-memory projection, never persisted (`aiToolkit/internal/ollamaBacked.js#withRuntimeContextWindow`).
 *
 * @param {object|null|undefined} provider
 * @param {Record<string, string|undefined>} [env]
 */
export function withOllamaRuntimeContextWindow(provider, env = process.env) {
  return withRuntimeContextWindow(provider, managedOllamaContextLength(provider, env))
}

/** `host:port` for comparing two Ollama base URLs, or null when unparseable. */
function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) return null
  // A bare `host:port` (OLLAMA_HOST convention) is not a valid URL; add a scheme before parsing.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw.replace(/^(https?:\/\/):(?=\d|$)/i, '$1localhost:')
    : /^:\d+(?:\/.*)?$/.test(raw)
      ? `http://localhost${raw}`
      : `http://${raw}`
  // `URL.parse` returns null on invalid input instead of throwing.
  const url = URL.parse(withScheme)
  if (!url) return null

  // Loopback aliases are the same local daemon; canonicalize so 127.0.0.1, [::1] and an empty
  // OLLAMA_HOST hostname cannot make a local provider look remote.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const canonicalHostname = ['127.0.0.1', '::1', 'localhost'].includes(hostname)
    ? 'localhost'
    : hostname
  return `${canonicalHostname}${url.port ? `:${url.port}` : ''}`
}

/**
 * Whether `providerBaseUrl` names the same Ollama daemon as `managedBaseUrl`. `isOllamaBackedProvider` also matches a provider on a *remote* daemon, but PortOS can only manage the local one
 * (reloading it for a remote-served provider would disrupt local work and leave the real daemon untouched). Compares host + port only; unparseable either side → false, so an ambiguous value never authorizes a restart.
 *
 * @param {string|null|undefined} providerBaseUrl
 * @param {string|null|undefined} managedBaseUrl
 * @returns {boolean}
 */
export function isSameOllamaDaemon(providerBaseUrl, managedBaseUrl) {
  const a = hostOf(providerBaseUrl)
  const b = hostOf(managedBaseUrl)
  return !!a && !!b && a === b
}

/**
 * Child env for `ollama serve`, carrying the resolved window; returns `env` untouched when `contextLength` is null so the daemon keeps Ollama's auto-pick.
 *
 * @param {Record<string, string|undefined>} env
 * @param {number|null} contextLength
 * @returns {Record<string, string|undefined>}
 */
export function withOllamaContextEnv(env, contextLength) {
  const n = positiveInt(contextLength)
  if (!n) return env
  return { ...env, [OLLAMA_CONTEXT_ENV_VAR]: String(n) }
}

// Ollama's overflow rejection in both shapes: the JSON error body (`n_prompt_tokens` / `n_ctx`) and
// the harness message ("request (N tokens) exceeds ..."). Matched independently so a truncated copy still parses.
const OVERFLOW_TYPE_RE = /exceed_context_size_error/
const OVERFLOW_MESSAGE_RE = /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i
const N_PROMPT_TOKENS_RE = /"n_prompt_tokens"\s*:\s*(\d+)/
const N_CTX_RE = /"n_ctx"\s*:\s*(\d+)/

/**
 * Recognize an Ollama context-overflow rejection in a chunk of agent output.
 *
 * Returns `null` for anything else, including a generic 400, so it works as the too-small-window guard.
 *
 * @param {string|null|undefined} text
 * @returns {{ promptTokens: number|null, contextLength: number|null }|null}
 */
export function parseOllamaContextOverflow(text) {
  const s = String(text || '')
  const message = s.match(OVERFLOW_MESSAGE_RE)
  if (!message && !OVERFLOW_TYPE_RE.test(s)) return null
  return {
    promptTokens: positiveInt(message?.[1]) ?? positiveInt(s.match(N_PROMPT_TOKENS_RE)?.[1]),
    contextLength: positiveInt(message?.[2]) ?? positiveInt(s.match(N_CTX_RE)?.[1])
  }
}

const tokenLabel = (n) => (n ? `${Math.round(n / 1024)}K` : 'unknown')

/**
 * One actionable line for an overflow: names the knob (the provider's `num_ctx`) and that the daemon reloads, since the raw body doesn't say where to raise it.
 *
 * @param {{ promptTokens: number|null, contextLength: number|null }} overflow
 * @param {{ model?: string|null, providerName?: string|null }} [options]
 * @returns {string}
 */
export function describeOllamaContextOverflow(overflow, { model = null, providerName = null } = {}) {
  const who = providerName ? `${providerName}'s` : "the provider's"
  const what = model ? ` for ${model}` : ''
  return `🪟 Ollama ran out of context${what}: the request needed ${tokenLabel(overflow?.promptTokens)} tokens ` +
    `but the model was loaded with a ${tokenLabel(overflow?.contextLength)} window. ` +
    `Raise ${who} "Local num_ctx" in AI Providers (or set ${OLLAMA_CONTEXT_ENV_VAR}) and PortOS will reload ` +
    `the Ollama daemon at that window — check the model still fits in VRAM at the larger size.`
}

/**
 * Pre-spawn warning that the daemon's window is below {@link OLLAMA_AGENT_MIN_CONTEXT}.
 *
 * @param {number} runtimeContext - the window the daemon actually loaded
 * @param {{ providerName?: string|null }} [options]
 * @returns {string}
 */
export function describeOllamaContextTooSmall(runtimeContext, { providerName = null } = {}) {
  // Lands in the agent's output buffer, so it is the lifecycle line the PR-body reader strips.
  return LIFECYCLE_LINES.ollamaContextTooSmall({
    who: providerName || 'This provider',
    runtime: tokenLabel(runtimeContext),
    minimum: tokenLabel(OLLAMA_AGENT_MIN_CONTEXT),
  })
}
