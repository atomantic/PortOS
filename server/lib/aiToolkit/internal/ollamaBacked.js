/**
 * Whether `provider` is served by an Ollama daemon rather than its nominal
 * cloud/CLI backend. Covers three shapes: the built-in `ollama` API provider
 * itself (id match — its `endpoint` carries the daemon URL, not `envVars`);
 * an `api`-type provider whose `endpoint` points at Ollama (generic local
 * setups); and the Claude-Ollama CLI/TUI pattern — a `claude` process that
 * carries the `ollamaBacked` marker or an `ANTHROPIC_BASE_URL` pointed at
 * Ollama, running the full Claude Code harness but generating tokens from a
 * local model, so its model list must come from Ollama (filtered to
 * tool-use-capable models) rather than the static Anthropic list.
 *
 * Lives in `internal/` rather than `providers.js` so the model-fetcher table
 * (`internal/modelFetchers.js`) can key its ollama row on it without importing
 * back into `providers.js` and forming a module cycle. Re-exported from
 * `providers.js` (and from `server/services/providers.js`) so hosts can
 * classify providers the same way this module's own refresh dispatch does,
 * instead of re-deriving the shape check and risking drift.
 */
export function isOllamaBackedProvider(provider) {
  if (provider?.id === 'ollama') return true;
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
}

/**
 * Normalize an Ollama base URL (strip trailing slash + an OpenAI-compat `/v1`)
 * so two providers pointed at the same daemon through differently-spelled URLs
 * resolve to the same string.
 *
 * Lives here beside {@link isOllamaBackedProvider} rather than in `providers.js`
 * so `internal/modelFetchers.js` can build a refresh group key on it without
 * importing back into `providers.js` and forming a module cycle. Deliberately
 * NOT re-exported from `providers.js`: `ollamaRefreshGroupKey` is the contract
 * hosts group on, and exporting the normalizer alongside it only invites a
 * caller to re-derive the grouping rule and drift from the real dispatch.
 */
export function ollamaBaseFromProvider(provider) {
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || 'http://localhost:11434');
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * `planned` held to what an Ollama daemon will actually serve — the one place
 * PortOS decides what `numCtx` means to a context window.
 *
 * It is the window the daemon was launched with, so it is an upper BOUND over
 * whatever a planning ladder resolved, and the answer outright when nothing
 * else declared one. It is NOT a fallback rung under the declared windows: a
 * catalog entry of 40,960 on a daemon launched at 8,192 still gets 8,192. With
 * no ceiling `planned` passes through untouched, `null` included — unknown must
 * not become a new answer.
 *
 * Shared rather than restated because the two ends drifted (#7466): the
 * pre-dispatch gate (`providerStatus.js#knownContextWindow`) clamped while the
 * prompt budgeter (`server/services/stageRunner.js#effectiveContextWindow`)
 * ranked `numCtx` last, so a chunked stage was built against the model's
 * declared window and then refused before it dispatched. The gate, the budgeter
 * and the browser's provider-card meter now all call this.
 *
 * The ceiling itself walks TWO rungs, in the same order
 * `server/lib/ollamaContext.js#resolveOllamaContextLength` walks to decide what
 * to launch the daemon with — so the budgeter and the launcher answer the same
 * question the same way:
 *
 *   1. `provider.numCtx` — the window this provider's own record asks for.
 *   2. `provider.runtimeContextWindow` — the window the daemon is ACTUALLY
 *      running at, stamped by the host (see {@link withRuntimeContextWindow}).
 *      This is the ambient `OLLAMA_CONTEXT_LENGTH` rung, which this directory
 *      cannot resolve for itself, and it ranks BELOW `numCtx` for the same
 *      reason `resolveOllamaContextLength` does: explicit provider config wins,
 *      and an unsaved `numCtx` being edited in the provider form must not be
 *      overruled by the window the daemon happens to be serving right now.
 *
 * Each rung is validated independently: a zero / negative / non-numeric
 * `numCtx` falls THROUGH to the runtime rung rather than collapsing the whole
 * ceiling to "none", so a malformed record cannot silently widen the budget.
 *
 * One deliberate limit, conservative (it can only under-plan): only Ollama
 * honors the runner's top-level `num_ctx`; every other OpenAI-compatible
 * endpoint ignores it, so there the field describes a window nothing enforces
 * and must never refuse a request. Hence the `isOllamaBackedProvider` gate —
 * and why this lives beside that predicate rather than in its own module, which
 * would add a module to the import closure of every suite reaching either end
 * of one rule.
 *
 * For an Ollama-backed CLI/TUI harness `numCtx` is the window the daemon is
 * reloaded UP TO, so a daemon already running wider keeps its wider window.
 *
 * @param {object|null|undefined} provider
 * @param {number|null|undefined} planned — whatever the caller's ladder resolved
 * @returns {number|null}
 */
export function clampToRuntimeContextWindow(provider, planned) {
  const ceiling = isOllamaBackedProvider(provider)
    ? (positiveTokens(provider?.numCtx) ?? positiveTokens(provider?.runtimeContextWindow))
    : null;
  const usable = positiveTokens(planned);
  if (!ceiling) return usable;
  return usable ? Math.min(usable, ceiling) : ceiling;
}

/**
 * `provider` carrying the window its Ollama daemon is ACTUALLY running at —
 * the write side of the `runtimeContextWindow` rung
 * {@link clampToRuntimeContextWindow} reads.
 *
 * Declared here beside its reader, for the same reason the ceiling itself is
 * declared once: a field whose meaning is stated in two modules is a field the
 * two will eventually disagree about (#7466).
 *
 * It exists because the ceiling has a rung this directory cannot resolve. PortOS
 * also sets the daemon-wide window through the ambient `OLLAMA_CONTEXT_LENGTH`
 * env var (`server/lib/ollamaContext.js#resolveOllamaContextLength`), and on an
 * install that uses that rung with `numCtx` unset, the budgeter planned at the
 * model's catalog window, the gate admitted it, and the call died at dispatch
 * with `exceed_context_size_error` (#7472). The toolkit may not import out to
 * where that lives, and the browser cannot read server env at all — so the HOST
 * resolves it and hands it in as data on the provider projection, rather than
 * the clamp reaching out for it. Server side that is
 * `ollamaContext.js#withOllamaRuntimeContextWindow`; the browser takes the same
 * number off the provider-readiness payload.
 *
 * In-memory ONLY. `runtimeContextWindow` describes the process running right
 * now — relaunch the daemon at another window and a stored copy would be a lie
 * — so it must never reach `providers.json`, exactly like the observed windows
 * `mergeObservedContextWindows` folds onto the same projection.
 *
 * Returns the SAME object when there is nothing to add, so a host with no
 * ambient window allocates nothing and compares identically. `null` in must
 * stay `null` out: "PortOS did not set a window" is not a window.
 *
 * @param {object|null|undefined} provider
 * @param {number|null|undefined} ceiling — the window the daemon is held at
 * @returns {object|null|undefined}
 */
export function withRuntimeContextWindow(provider, ceiling) {
  const runtime = positiveTokens(ceiling);
  if (!provider || !runtime) return provider;
  if (positiveTokens(provider.runtimeContextWindow) === runtime) return provider;
  return { ...provider, runtimeContextWindow: runtime };
}

/** A context-window field as a positive integer token count, or `null`. */
function positiveTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
