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
