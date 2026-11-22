/**
 * Whether `provider` is served by an Ollama daemon rather than its nominal
 * backend: the built-in `ollama` id, an `api` provider whose `endpoint` points at
 * Ollama, or a Claude-Ollama CLI/TUI harness (marker or `ANTHROPIC_BASE_URL`).
 * Lives here to avoid an import cycle with `modelFetchers.js`; re-exported from `providers.js`.
 */
export function isOllamaBackedProvider(provider) {
  if (provider?.id === 'ollama') return true;
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
}

/**
 * Normalize an Ollama base URL (strip trailing slash + an OpenAI-compat `/v1`)
 * so differently-spelled URLs for one daemon compare equal. Deliberately NOT
 * re-exported: `ollamaRefreshGroupKey` is the contract hosts group on.
 */
export function ollamaBaseFromProvider(provider) {
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || 'http://localhost:11434');
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * `planned` held to what an Ollama daemon will actually serve: the one place
 * `numCtx` becomes a context window (gate, budgeter and meter share it). The
 * ceiling is an upper BOUND on `planned` (and the answer when none was declared);
 * with no ceiling `planned` passes through, `null` included. Rungs as in
 * `ollamaContext.js#resolveOllamaContextLength`: `numCtx`, then host-stamped
 * `runtimeContextWindow`, each validated independently. Only Ollama is sent `numCtx`.
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
 * `provider` carrying the window its Ollama daemon is ACTUALLY running at (the
 * `runtimeContextWindow` rung {@link clampToRuntimeContextWindow} reads). The
 * ambient `OLLAMA_CONTEXT_LENGTH` cannot be resolved here, so the HOST passes it
 * in as data. In-memory ONLY: never persist to `providers.json`. Returns the
 * SAME object when there is nothing to add.
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

/**
 * `provider` with its per-model window applied: when `modelNumCtx[model]` is
 * set, that number replaces `numCtx` for this model only, so one large-window
 * model (a 1M-token one, say) need not raise the window every model on the
 * daemon loads with. Every reader of `numCtx` for a known model goes through
 * this first: the request, the clamp, the budgeter and the meter. In-memory
 * only; returns the SAME object when there is no override for `model`.
 *
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {object|null|undefined}
 */
export function withModelNumCtx(provider, model) {
  const override = model ? positiveTokens(provider?.modelNumCtx?.[model]) : null;
  if (!provider || !override || positiveTokens(provider.numCtx) === override) return provider;
  return { ...provider, numCtx: override };
}

// Ollama's native `think` field takes a level string for models whose template
// supports one (`/api/show` → `thinking.values`), not just a boolean. Kept in this
// browser-safe leaf (not its own module) so the effort picker and the runner read
// one table without growing the boot import closure.

// Families whose Ollama template takes a thinking level, weakest first.
const FAMILY_LEVELS = Object.freeze([
  [/(?:^|[/:_-])inkling/i, Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])],
  [/(?:^|[/:_-])gpt-oss/i, Object.freeze(['low', 'medium', 'high'])],
]);

/**
 * The thinking levels `model` accepts as Ollama's `think`, or null when it takes only a boolean or none.
 * @param {string|null|undefined} model
 * @returns {readonly string[]|null}
 */
export function ollamaThinkingLevelsForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  for (const [pattern, levels] of FAMILY_LEVELS) if (pattern.test(model)) return levels;
  return null;
}

/**
 * The `think` value for a run: a supported `effort` level wins over the
 * provider's boolean `thinking`; an unsupported effort is ignored.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @returns {string|null}
 */
export function ollamaThinkLevel(model, effort) {
  const levels = ollamaThinkingLevelsForModel(model);
  return levels && typeof effort === 'string' && levels.includes(effort) ? effort : null;
}
