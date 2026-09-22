/**
 * Ollama runtime context-window helpers.
 *
 * Ollama picks a model's runtime window (`n_ctx`) from available VRAM —
 * `OLLAMA_CONTEXT_LENGTH` documents the default as "4k/32k/256k based on VRAM".
 * That auto-pick is fine for a chat turn and far too small for an agent harness:
 * Claude Code / OpenCode ship a system prompt plus tool schemas plus a growing
 * transcript, and they size their own compaction against the window they *think*
 * they have (an Anthropic-sized one), not the window Ollama actually loaded. The
 * result is a run that works for an hour and then dies mid-task with
 * `exceed_context_size_error` at 100% prompt utilisation.
 *
 * The only lever that reaches those harnesses is the daemon default: they speak
 * Ollama's Anthropic/OpenAI-compatible endpoints directly, so PortOS cannot
 * attach a per-request `num_ctx` the way the toolkit runner does for `api`
 * providers. Hence `OLLAMA_CONTEXT_LENGTH` on the daemon PortOS starts.
 *
 * Pure — no I/O, no daemon calls. `server/services/ollamaManager.js` owns the
 * daemon side (starting/restarting with the resolved window) and
 * `server/services/ollamaAgentContext.js` owns the pre-spawn enforcement.
 */

// The `internal/` leaf on purpose: the toolkit's public barrel reaches `fs` and
// `child_process`, and this module sits in the closure of the prompt budgeter
// and the dispatch gate, both inside the server suite's import budget. The leaf
// imports nothing.
import { isOllamaBackedProvider, ollamaBaseFromProvider, withRuntimeContextWindow } from './aiToolkit/internal/ollamaBacked.js'

/**
 * Smallest runtime window an Ollama-backed *agent harness* can realistically
 * finish a task in. Not a hard requirement — it is the threshold below which
 * PortOS warns before spawning, because 32K (the common VRAM auto-pick) is
 * routinely consumed by scaffold + tools + a few file reads.
 */
export const OLLAMA_AGENT_MIN_CONTEXT = 65536

/** Ollama's own env knob for the daemon-wide default window. */
export const OLLAMA_CONTEXT_ENV_VAR = 'OLLAMA_CONTEXT_LENGTH'

const positiveInt = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * The context window PortOS should hold the Ollama daemon at for `provider`.
 *
 * Explicit provider config wins (`numCtx` — the same field the toolkit runner
 * sends as a per-request `num_ctx` for `api` providers, reused here as "the
 * window this provider needs"), then the ambient `OLLAMA_CONTEXT_LENGTH`, then
 * `null`.
 *
 * `null` means **leave Ollama's VRAM-based auto-pick alone**. That is the
 * deliberate default: forcing a window larger than VRAM allows does not fail
 * loudly, it silently offloads layers to CPU and turns a fast local model into
 * an unusable one. Only the user knows their machine's headroom.
 *
 * @param {{numCtx?: number|null}|null|undefined} provider
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|null}
 */
export function resolveOllamaContextLength(provider, env = process.env) {
  return positiveInt(provider?.numCtx) ?? positiveInt(env?.[OLLAMA_CONTEXT_ENV_VAR])
}

/**
 * The base URL of the Ollama daemon THIS install manages — `OLLAMA_URL`, then
 * the `OLLAMA_HOST` (`host:port`) convention, then the stock local daemon.
 *
 * Declared here rather than restated at each reader because it is half of the
 * `isSameOllamaDaemon` comparison below, and a second spelling of it is a second
 * answer to "is this provider's daemon the one PortOS launched?".
 * `services/ollamaManager.js` normalizes the result into its own config.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function managedOllamaBaseUrl(env = process.env) {
  const raw = String(env?.OLLAMA_URL || env?.OLLAMA_HOST || '').trim()
  return raw || 'http://localhost:11434'
}

/**
 * The window PortOS holds `provider`'s daemon at, or `null` when it holds it at
 * none (Ollama's VRAM auto-pick stands).
 *
 * {@link resolveOllamaContextLength} gated on the daemon being the one this
 * install manages. The gate matters because the ambient `OLLAMA_CONTEXT_LENGTH`
 * only ever reaches the daemon PortOS launches (`withOllamaContextEnv`): applied
 * to a provider pointed at a REMOTE Ollama it would describe a window nobody
 * set, and budget that remote daemon down to a local machine's VRAM headroom.
 * The same gate `services/ollamaAgentContext.js` puts on the reload.
 *
 * `numCtx` is deliberately NOT gated with it — an `api`-type provider's
 * `numCtx` rides the request as `num_ctx` and binds a remote daemon just as
 * well, which is why the clamp reads that rung straight off the record.
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
 * `provider` with that window stamped on for a caller about to ask a context
 * question about it — the ONE operation the prompt budgeter
 * (`services/stageRunner.js#effectiveContextWindow`) and the pre-dispatch gate
 * (`services/promptRunner.js#assertRequestFitsContext`) both want.
 *
 * This is how the env rung reaches the vendored toolkit, which may not import
 * out to this module: as data on an in-memory projection, never persisted. See
 * `aiToolkit/internal/ollamaBacked.js#withRuntimeContextWindow` for the field's
 * contract and #7472 for the failure it closes.
 *
 * @param {object|null|undefined} provider
 * @param {Record<string, string|undefined>} [env]
 * @returns {object|null|undefined}
 */
export function withOllamaRuntimeContextWindow(provider, env = process.env) {
  return withRuntimeContextWindow(provider, managedOllamaContextLength(provider, env))
}

/** `host:port` for comparing two Ollama base URLs, or null when unparseable. */
function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) return null
  // A bare `host:port` (the OLLAMA_HOST convention) is not a valid URL, so give
  // it a scheme before parsing rather than string-comparing the two spellings.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw.replace(/^(https?:\/\/):(?=\d|$)/i, '$1localhost:')
    : /^:\d+(?:\/.*)?$/.test(raw)
      ? `http://localhost${raw}`
      : `http://${raw}`
  // `URL.parse` returns null on invalid input instead of throwing (Node ≥22.1;
  // every supported PortOS runtime is newer), so no try/catch is needed here.
  const url = URL.parse(withScheme)
  if (!url) return null

  // Ollama treats loopback aliases as the same local daemon. Compare a
  // canonical hostname plus the parsed port so 127.0.0.1, [::1], and an empty
  // OLLAMA_HOST hostname cannot make a local provider look remote.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const canonicalHostname = ['127.0.0.1', '::1', 'localhost'].includes(hostname)
    ? 'localhost'
    : hostname
  return `${canonicalHostname}${url.port ? `:${url.port}` : ''}`
}

/**
 * Whether `providerBaseUrl` names the same Ollama daemon as `managedBaseUrl`.
 *
 * `isOllamaBackedProvider` matches any provider whose tokens come from Ollama,
 * including one pointed at a *remote* daemon — but PortOS can only start, stop,
 * or hand a context window to the local one it manages. Reloading the local
 * daemon for a provider served by another host would disrupt unrelated local
 * work AND leave the provider's real daemon untouched, so the daemon-management
 * path gates on this.
 *
 * Compares host + port only: scheme and `/v1` suffix vary between how a provider
 * spells the endpoint and how `ollamaManager` normalizes it. Unparseable on
 * either side → false, so an ambiguous value never authorizes a restart.
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
 * Child env for `ollama serve`, carrying the resolved window. Returns `env`
 * untouched when `contextLength` is null so a PortOS-started daemon keeps
 * Ollama's own auto-pick unless someone asked for a specific window.
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

// Ollama's overflow rejection, in both the shapes it reaches us in: the JSON
// error body (`n_prompt_tokens` / `n_ctx`) and the human message the harness
// prints ("request (N tokens) exceeds the available context size (M tokens)").
// Matched independently so a truncated/re-wrapped copy of either still parses.
const OVERFLOW_TYPE_RE = /exceed_context_size_error/
const OVERFLOW_MESSAGE_RE = /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i
const N_PROMPT_TOKENS_RE = /"n_prompt_tokens"\s*:\s*(\d+)/
const N_CTX_RE = /"n_ctx"\s*:\s*(\d+)/

/**
 * Recognize an Ollama context-overflow rejection in a chunk of agent output.
 *
 * Returns `null` for anything else — including a generic 400 — so callers can
 * use it as the guard for "is this the too-small-window failure?" rather than
 * pattern-matching the raw JSON at every call site.
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
 * One actionable line explaining an overflow. The raw Ollama body is a JSON
 * blob whose "try increasing it" says nothing about *where* — this names the
 * knob (the provider's `num_ctx`) and the fact that the daemon reloads to apply
 * it, so the run's output is enough to fix the run.
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
 * One actionable line warning that the daemon's current window is below
 * {@link OLLAMA_AGENT_MIN_CONTEXT}, emitted before a spawn rather than an hour
 * into a doomed run.
 *
 * @param {number} runtimeContext - the window the daemon actually loaded
 * @param {{ providerName?: string|null }} [options]
 * @returns {string}
 */
export function describeOllamaContextTooSmall(runtimeContext, { providerName = null } = {}) {
  const who = providerName ? `${providerName}` : 'This provider'
  return `⚠️ ${who} is running on an Ollama window of ${tokenLabel(runtimeContext)} — below the ` +
    `${tokenLabel(OLLAMA_AGENT_MIN_CONTEXT)} an agent harness usually needs. Set "Local num_ctx" in AI Providers ` +
    `to reload Ollama at a larger window (VRAM permitting), or the run will fail partway through.`
}
