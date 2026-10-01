/**
 * fal.ai queue REST API — the transport shared by every fal.ai backend.
 *
 * fal.ai runs every model behind the same queue contract: POST the input to
 * `queue.fal.run/{endpoint}`, poll the returned `status_url` until COMPLETED,
 * then GET `response_url` for the output (which names a CDN URL for each file).
 * `videoGen/fal.js` (#6213) grew this transport inline; the image backend
 * (`imageGen/fal.js`) needs the exact same submit/poll/retrieve/cancel rules,
 * so they live here once rather than as two copies free to drift on the
 * retry/cancel semantics #8340 and #8564 had to fix.
 *
 * Only the transport is shared. Each caller keeps its own job map, SSE/event
 * vocabulary and output finalization — the `onPoll`/`onStatus` hooks on
 * `awaitFalCompletion` are how it reports progress in its own terms.
 */

import { readFile } from 'fs/promises';
import { ServerError } from '../lib/errorHandler.js';
import { describeFetchError } from '../lib/fetchErrorChain.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { detectImageFormat } from '../lib/mimeTypes.js';

export const FAL_QUEUE_BASE = 'https://queue.fal.run';

export const FAL_SUBMIT_TIMEOUT_MS = 30_000;
export const FAL_POLL_TIMEOUT_MS = 15_000;
export const FAL_POLL_INTERVAL_MS = 3000;
// A transient status-fetch failure (network blip, fal.ai 5xx) gets this many
// additional attempts — on the same FAL_POLL_INTERVAL_MS cadence, never
// resubmitting the paid generation — before the run is abandoned (#8340).
export const FAL_MAX_STATUS_RETRIES = 2;
const FAL_MAX_READ_RETRIES = 2;

/**
 * Resolve the fal.ai API key: settings override, else the `FAL_KEY` env var
 * (same settings-wins-over-env precedence as `loras.js`'s Civitai key).
 *
 * The settings value lives under `videoGen.fal.apiKey` because the video
 * backend introduced it; `privateKeyStore.js` hydrates it there server-side.
 * The image backend deliberately reuses the SAME key — one fal.ai account, one
 * credential row — rather than growing an `imageGen.fal.apiKey` twin.
 */
export function resolveFalApiKey(settings) {
  const fromSettings = (settings?.videoGen?.fal?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = (process.env.FAL_KEY || '').trim();
  return fromEnv || null;
}

/** Read a local file into a `data:` URI — how fal.ai accepts inline inputs. */
export async function fileToDataUri(filePath) {
  const buf = await readFile(filePath);
  const detected = detectImageFormat(buf);
  const mime = detected?.mime || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * The per-request bookkeeping `cancelFalRequest` and `awaitFalCompletion`
 * share. `cancelUrl` is filled in once the submit returns.
 */
export const createFalRequestEntry = (apiKey) => ({
  apiKey, controller: new AbortController(), aborted: false, cancelUrl: null, canceledRemote: false, remoteTerminal: false,
});

// Best-effort, idempotent cancellation of the remote fal.ai request — shared
// by explicit user cancellation (cancel()/cancelAll()) and every local
// abandonment path (exhausted status retries, the render deadline) so an
// already-known cancel_url is never left unsent (#8340). A caught failure is
// logged for diagnosis but never rethrown: the local job still finalizes as
// failed/canceled either way. Guarded so it never re-sends once fired, and
// never fires once the remote request already reached a fal-reported
// terminal state (COMPLETED/ERROR) — there is nothing left to cancel there.
export async function cancelFalRequest(entry) {
  if (!entry || entry.canceledRemote || entry.remoteTerminal || !entry.cancelUrl || !entry.apiKey) return;
  entry.canceledRemote = true;
  try {
    const res = await fetchWithTimeout(entry.cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Key ${entry.apiKey}` },
    }, FAL_POLL_TIMEOUT_MS);
    if (!res.ok) console.error(`❌ fal.ai cancellation request failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`❌ fal.ai cancellation request failed: ${err?.message || err}`);
  }
}

/**
 * Submit one paid request. Resolves to the queue receipt with every URL the
 * rest of the run needs, falling back to the documented URL shapes when a
 * receipt omits one.
 */
export async function submitFalRequest({ apiKey, modelId, body }) {
  const res = await fetchWithTimeout(`${FAL_QUEUE_BASE}/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, FAL_SUBMIT_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.request_id) {
    const reason = payload?.detail ? JSON.stringify(payload.detail) : `HTTP ${res.status}`;
    throw new ServerError(`fal.ai rejected the request: ${reason}`, { status: 502, code: 'FAL_SUBMIT_FAILED' });
  }
  const requestBase = `${FAL_QUEUE_BASE}/${modelId}/requests/${payload.request_id}`;
  return {
    ...payload,
    cancel_url: payload.cancel_url || `${requestBase}/cancel`,
    status_url: payload.status_url || `${requestBase}/status`,
    response_url: payload.response_url || requestBase,
  };
}

async function pollFalStatus({ statusUrl, apiKey }) {
  const res = await fetchWithTimeout(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  }, FAL_POLL_TIMEOUT_MS);
  if (!res.ok) throw new ServerError(`fal.ai status check failed: HTTP ${res.status}`, { status: 502, code: 'FAL_STATUS_FAILED' });
  return res.json();
}

/**
 * Poll a submitted request until fal.ai reports it terminal, the caller
 * cancels it (`entry.aborted`), or `deadline` passes. Resolves to
 * `{ outcome: 'completed' | 'canceled' | 'failed', reason? }` and never
 * throws — every abandonment path has already sent the remote cancel.
 *
 *  - `onPoll()` fires before every status request (the video lane uses it as
 *    its watchdog activity heartbeat).
 *  - `onStatus(status)` fires for every non-terminal status fal.ai reports
 *    (`IN_QUEUE` / `IN_PROGRESS`), for the caller's progress wording.
 *  - `timeoutMs` only names the budget in the deadline message.
 */
export async function awaitFalCompletion({
  entry, statusUrl, apiKey, deadline, timeoutMs, onPoll = () => {}, onStatus = () => {},
}) {
  let statusFailures = 0;
  while (Date.now() < deadline) {
    if (entry.aborted) {
      // The cancel may have landed while submit was in flight, before the
      // receipt's cancel_url existed — send it now rather than leave a paid render running.
      await cancelFalRequest(entry);
      return { outcome: 'canceled' };
    }
    onPoll();
    let status;
    try {
      status = await pollFalStatus({ statusUrl, apiKey });
    } catch (err) {
      statusFailures += 1;
      if (statusFailures > FAL_MAX_STATUS_RETRIES) {
        await cancelFalRequest(entry);
        return { outcome: 'failed', reason: `fal.ai status checks failed ${statusFailures} times in a row: ${err?.message || err}` };
      }
      await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
      continue;
    }
    statusFailures = 0;
    if (status.status === 'COMPLETED') {
      entry.remoteTerminal = true;
      break;
    }
    if (status.status === 'ERROR') {
      entry.remoteTerminal = true;
      return { outcome: 'failed', reason: `fal.ai render failed: ${status.error || 'unknown error'}` };
    }
    onStatus(status.status);
    await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
  }
  if (entry.aborted) return { outcome: 'canceled' };
  if (Date.now() >= deadline) {
    await cancelFalRequest(entry);
    return { outcome: 'failed', reason: `fal.ai did not finish within ${Math.round(timeoutMs / 1000)}s` };
  }
  return { outcome: 'completed' };
}

/** A short, single-line reason from a fal error response body (`detail` string or validation list), or ''. */
async function falErrorDetail(response) {
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  if (!text) return '';
  let reason = text;
  try {
    const body = JSON.parse(text);
    const detail = body?.detail ?? body?.error ?? body?.message;
    reason = Array.isArray(detail)
      ? detail.map((d) => [d?.loc?.slice?.(-1)?.[0], d?.msg || d?.type].filter(Boolean).join(': ')).join('; ')
      : typeof detail === 'string' ? detail : JSON.stringify(detail ?? body);
  } catch { /* not JSON: keep the text */ }
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Read the result of an already-paid render — the `response_url` JSON, or
 * (with `binary: true`) an output file's bytes. Retries only transient reads,
 * including body consumption; schema/JSON errors and permanent HTTP failures
 * must not enter this loop. `apiKey` is omitted for CDN downloads, which are
 * public URLs.
 */
export async function readCompletedFalResult(url, { apiKey, signal, deadline, binary = false, binaryTimeoutMs, label }) {
  const what = label || (binary ? 'download' : 'result retrieval');
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('fal.ai retrieval deadline exceeded');
    let response;
    try {
      response = await fetchWithTimeout(url, {
        ...(apiKey ? { headers: { Authorization: `Key ${apiKey}` } } : {}),
        signal,
      }, Math.min(remaining, binary ? binaryTimeoutMs : FAL_POLL_TIMEOUT_MS));
      if (!response.ok) {
        const transientRead = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
        // A permanent failure on the result read is how fal reports a job that
        // failed on its side (a 422 with a `detail` naming the input or policy
        // violation). Keep that reason — without it the job just says "HTTP 422".
        const detail = !transientRead && !binary ? await falErrorDetail(response) : '';
        const error = new Error(`fal.ai ${what} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
        error.transientRead = transientRead;
        throw error;
      }
      const value = await (binary ? response.arrayBuffer() : response.json());
      signal.throwIfAborted();
      return value;
    } catch (err) {
      // Release error responses without waiting for an error body to download.
      // A rejected consumer has already released its fetch deadline.
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
      signal.throwIfAborted();
      if (err instanceof SyntaxError) throw new Error('fal.ai did not return valid result JSON');
      const transient = err.transientRead ?? (err.name === 'AbortError' || err.name === 'TimeoutError' ||
        /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|fetch failed|network error|socket hang up/i.test(describeFetchError(err)));
      if (!transient || attempt >= FAL_MAX_READ_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * (2 ** attempt), Math.max(0, deadline - Date.now()))));
    }
  }
}
