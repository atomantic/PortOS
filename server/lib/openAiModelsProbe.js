/**
 * One `GET {base}/models` reachability+listing probe for the local
 * OpenAI-compatible daemons (llama.cpp, Ollama, LM Studio, MTPLX).
 *
 * This existed three times in `server/` before it existed once here, and the
 * copies had already drifted: `llamaServerManager`'s passed its timeout as a
 * `timeout` key INSIDE the fetch init object, where it is not an option, so
 * that probe silently ran on the 15s default inside a 500ms startup poll loop.
 * A single implementation makes the timeout, the URL normalization, and the
 * "reachable but unlistable" distinction one decision instead of N.
 *
 * Answers three states a caller must be able to tell apart:
 *   - `reachable: false`             — nothing is serving here (with `error` naming why)
 *   - `reachable: true, models: null`— it answered, but the listing was unreadable
 *   - `reachable: true, models: []`  — it is up and genuinely serving nothing
 *
 * The listing also carries each model's SERVED context window (vLLM spells it
 * `max_model_len`, llama-server `n_ctx`, LM Studio `loaded_context_length`), and
 * `contextWindows` keeps it. Dropping it was how a prompt that provably could
 * not fit still got dispatched: nothing upstream could tell a 50K-char prompt
 * from a 15K one against a 32K endpoint, so the only backstop was the
 * provider's wall-clock timeout (#7441).
 *
 * A daemon started behind an API key (vLLM's compose stack sets `VLLM_API_KEY`)
 * answers 401/403 to an unauthenticated probe. That is a REACHABLE server whose
 * listing we cannot read — reporting it as unreachable would tell the user to
 * start a container that is already running. Pass `apiKey` to read the listing
 * too.
 */

// The toolkit's model refresh already reads a window off a listing row, and a
// second table here would let refresh-time and probe-time disagree about the
// same daemon. Reaching INTO `aiToolkit/internal/` is the established direction
// (`openAiChatStream.js`, `harnessOutput.js`, `providerGraphPreview.js` all do
// it) — the self-containment rule in its AGENTS.md forbids the toolkit
// importing OUT, not the host importing in.
import { catalogContextWindow } from './aiToolkit/internal/modelCatalog.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { describeFetchError } from './fetchErrorChain.js';
import { readResponseJson } from './readResponseJson.js';

/**
 * The one-token reason a probe failed, for a UI that has a line to spend on it.
 * `describeFetchError` returns the whole cause chain (`fetch failed: ECONNREFUSED:
 * connect ECONNREFUSED <host>:<port>`); the code alone is what tells the user
 * "nothing is listening" from "the host is wedged", and the two timeout
 * spellings mean the same thing to them.
 */
function shortFailureReason(err) {
  // `describeFetchError` walks `.code`/`.message` only, and an abort carries its
  // identity in `.name` (`AbortError`) — which is exactly the timeout case.
  const chain = `${err?.name || ''}: ${describeFetchError(err)}`;
  if (/AbortError|TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/.test(chain)) return 'timed out';
  const code = chain.match(/\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/);
  return code ? code[1] : chain.slice(0, 120);
}

/**
 * @param {string} baseUrl - an OpenAI-compatible base (…/v1); trailing slashes tolerated
 * @param {{timeoutMs?: number, apiKey?: string}} [opts]
 * @returns {Promise<{reachable:boolean, models:string[]|null, contextWindows:Record<string,number>|null, error:string|null}>}
 *   `contextWindows` carries an entry only for a model whose window the listing
 *   actually declared, so `{}` means "nothing declared one" — never "these
 *   models have no window". It is `null` exactly when `models` is. Per-row
 *   parsing (which key, and smallest-wins when a row declares several) is
 *   `catalogContextWindow`'s rule, shared with model refresh.
 */
export async function probeOpenAiModels(baseUrl, { timeoutMs = 2_000, apiKey = '' } = {}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const init = { method: 'GET', ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}) };
  const res = await fetchWithTimeout(url, init, timeoutMs)
    // undici reports every network failure as a bare `TypeError: fetch failed`;
    // the real reason (ECONNREFUSED vs. ETIMEDOUT — "nothing is listening" vs.
    // "the host is wedged", two different fixes for the user) lives in the
    // cause chain.
    .catch((err) => ({ transportError: shortFailureReason(err) }));

  if (res.transportError) return { reachable: false, models: null, contextWindows: null, error: res.transportError };
  if (!res.ok) {
    // Undici holds the socket until an unread body is consumed; an endpoint
    // answering 404 on every poll would otherwise leak one each time.
    await res.body?.cancel().catch(() => {});
    // 401/403 is the ONE failure status that proves a daemon is up: something
    // read the request and refused it. Collapsing that into "nothing answered"
    // sends the user off to start a server that is already serving.
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, models: null, contextWindows: null, error: 'authentication required' };
    }
    return { reachable: false, models: null, contextWindows: null, error: `HTTP ${res.status}` };
  }

  // The body read is its own failure path: a daemon that accepts the connection
  // and then drops it (or sends a truncated body) rejects inside `res.text()`,
  // NOT at the fetch above. Unhandled, that rejection escapes the probe and
  // fails the entire readiness request — one flaky daemon would blank the
  // checklist for every provider — so it lands on the same
  // reachable-but-unreadable sentinel as a non-JSON body.
  const body = await readResponseJson(res, { fallback: null, emptyValue: null }).catch(() => null);
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!rows) return { reachable: true, models: null, contextWindows: null, error: 'model listing was not readable' };
  const models = [];
  const contextWindows = {};
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (row?.id || row?.name);
    if (typeof id !== 'string' || id === '') continue;
    models.push(id);
    const tokens = catalogContextWindow(row);
    if (tokens) contextWindows[id] = tokens;
  }
  return { reachable: true, models, contextWindows, error: null };
}
