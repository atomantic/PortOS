/**
 * One `GET {base}/models` reachability and listing probe for the local OpenAI-compatible daemons (llama.cpp, Ollama, LM Studio, MTPLX).
 *
 * One `GET {base}/models` reachability+listing probe for the local OpenAI-compatible daemons (llama.cpp, Ollama, LM Studio, MTPLX), replacing three drifted copies (`llamaServerManager`'s passed `timeout` INSIDE the fetch init, where it isn't an option, so it ran on the 15s default in a 500ms poll loop).
 * Three states a caller must tell apart: `reachable: false` (nothing serving, `error` says why); `reachable: true, models: null` (answered, listing unreadable); `reachable: true, models: []` (up and serving nothing).
 * `contextWindows` keeps each model's SERVED window (vLLM `max_model_len`, llama-server `n_ctx`, LM Studio `loaded_context_length`): dropping it let a provably oversized prompt be dispatched with only the provider's timeout as backstop (#7441).
 * A daemon behind an API key (vLLM's compose stack sets `VLLM_API_KEY`) answers 401/403 unauthenticated: a REACHABLE server with an unreadable listing (reporting it unreachable would tell the user to start a running container); pass `apiKey` to read it.
 */

// The toolkit's model refresh already reads a window off a listing row; a second table here would let refresh-time and probe-time disagree. Importing INTO `aiToolkit/internal/` is the established direction (openAiChatStream.js, harnessOutput.js, providerGraphPreview.js); its AGENTS.md forbids the toolkit importing OUT.
import { catalogContextWindow } from './aiToolkit/internal/modelCatalog.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { describeFetchError } from './fetchErrorChain.js';
import { readResponseJson } from './readResponseJson.js';

/** The one-token reason a probe failed for a UI with one line to spend: `describeFetchError` returns the whole cause chain, but the code alone tells "nothing is listening" from "the host is wedged", and the two timeout spellings mean the same to the user. */
function shortFailureReason(err) {
  // `describeFetchError` walks `.code`/`.message` only; an abort carries its identity in `.name` (`AbortError`), the timeout case.
  const chain = `${err?.name || ''}: ${describeFetchError(err)}`;
  if (/AbortError|TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/.test(chain)) return 'timed out';
  const code = chain.match(/\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/);
  return code ? code[1] : chain.slice(0, 120);
}

/**
 *
 * @param {string} baseUrl - an OpenAI-compatible base (…/v1); trailing slashes tolerated
 * @param {{timeoutMs?: number, apiKey?: string, headers?: Record<string,string>}} [opts] —
 *   `headers` is for a listing that authenticates some other way than a bearer
 *   token (the Anthropic API's `x-api-key` + `anthropic-version` pair, #7563);
 *   it is merged over the bearer header when both are given.
 * @returns {Promise<{reachable:boolean, models:string[]|null, contextWindows:Record<string,number>|null, error:string|null}>}
 *   `contextWindows` carries an entry only for a model whose window the listing
 *   actually declared, so `{}` means "nothing declared one" — never "these
 *   models have no window". It is `null` exactly when `models` is. Per-row
 *   parsing (which key, and smallest-wins when a row declares several) is
 *   `catalogContextWindow`'s rule, shared with model refresh.
 */
export async function probeOpenAiModels(baseUrl, { timeoutMs = 2_000, apiKey = '', headers = {} } = {}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const merged = { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers };
  // A redirect would forward custom credential headers (undici strips only `Authorization` cross-origin), so a keyed probe fails instead of following one.
  const carriesKey = Object.keys(merged).some((name) => /^(authorization|x-api-key)$/i.test(name));
  const init = {
    method: 'GET',
    ...(Object.keys(merged).length > 0 ? { headers: merged } : {}),
    ...(carriesKey ? { redirect: 'error' } : {}),
  };
  const res = await fetchWithTimeout(url, init, timeoutMs)
    // undici reports every network failure as a bare `TypeError: fetch failed`; the real reason (ECONNREFUSED vs ETIMEDOUT) lives in the cause chain.
    .catch((err) => ({ transportError: shortFailureReason(err) }));

  if (res.transportError) return { reachable: false, models: null, contextWindows: null, error: res.transportError };
  if (!res.ok) {
    // Undici holds the socket until an unread body is consumed; a 404 on every poll would leak one each time.
    await res.body?.cancel().catch(() => {});
    // 401/403 is the ONE failure status proving a daemon is up (something read the request and refused it); collapsing it into "nothing answered" sends the user to start a running server.
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, models: null, contextWindows: null, error: 'authentication required' };
    }
    return { reachable: false, models: null, contextWindows: null, error: `HTTP ${res.status}` };
  }

  // The body read is its own failure path: a daemon that accepts then drops the connection (or truncates) rejects inside `res.text()`, NOT at the fetch, and unhandled it would fail the whole readiness request (one flaky daemon blanking every provider's checklist), so it lands on the reachable-but-unreadable sentinel.
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

/**
 * `probeOpenAiModels`, retried once under `/v1` when a base URL with no version
 * segment answers 404. Service connections can carry a bare daemon host (Ollama's
 * `http://localhost:11434` is what Codex's OSS mode is configured with), whose
 * OpenAI surface lives under `/v1`. The retry only replaces the first answer when
 * it actually lists models, so a host that 404s on both keeps its original error.
 */
export async function probeOpenAiModelsWithVersionFallback(baseUrl, options = {}, probe = probeOpenAiModels) {
  const first = await probe(baseUrl, options);
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (first.error !== 'HTTP 404' || /\/v\d+[a-z0-9]*$/i.test(trimmed)) return first;
  const retry = await probe(`${trimmed}/v1`, options);
  return Array.isArray(retry.models) ? retry : first;
}
