/**
 * Higgsfield developer API — the shared request transport for the image and
 * video backends (services/imageGen/higgsfield.js, services/videoGen/higgsfield.js).
 *
 * Every model sits behind the same queue contract (docs.higgsfield.ai,
 * "Requests"): POST the input to `api.higgsfield.ai/{endpoint}`, which answers
 * `{ request_id, status_url, cancel_url }`; poll `status_url` until `completed`
 * / `failed` / `nsfw` / `canceled`, then download `images[].url` or `video.url`
 * (kept for about seven days, so it is fetched at once). Media inputs must be
 * public URLs: local files go up through `/files/generate-upload-url` first.
 *
 * Same submit/poll/cancel rules as `falQueue.js` and `runwayApi.js`: a lost
 * submit response marks the run unsettled (it may still bill), a transient
 * status failure is retried on the poll cadence without resubmitting, and every
 * abandonment path sends the remote cancel once. Higgsfield only cancels a
 * request that is still queued; once it started the render runs to the end.
 */

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { detectImageFormat } from '../lib/mimeTypes.js';

export const HIGGSFIELD_API_BASE = 'https://api.higgsfield.ai';
export const HIGGSFIELD_SUBMIT_TIMEOUT_MS = 60_000;
export const HIGGSFIELD_POLL_TIMEOUT_MS = 15_000;
export const HIGGSFIELD_POLL_INTERVAL_MS = 4000;
export const HIGGSFIELD_MAX_STATUS_RETRIES = 2;
const HIGGSFIELD_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The Higgsfield credential, `KEY_ID:KEY_SECRET` as the console issues it: the
 * settings-stored value, else the `HIGGSFIELD_API_KEY` env var. One account
 * serves image and video, so both backends read the same `videoGen.higgsfield`
 * key (like fal.ai and Runway).
 */
export function resolveHiggsfieldApiKey(settings) {
  const fromSettings = (settings?.videoGen?.higgsfield?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  return (process.env.HIGGSFIELD_API_KEY || '').trim() || null;
}

const headers = (apiKey, json = false) => ({
  Authorization: `Key ${apiKey}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

/** A short, single-line reason from a Higgsfield error body (`detail` string or validation list), or ''. */
function higgsfieldErrorDetail(payload) {
  const detail = payload?.detail ?? payload?.error ?? payload?.message;
  const text = Array.isArray(detail)
    ? detail.map((d) => [Array.isArray(d?.loc) ? d.loc.slice(-1)[0] : null, d?.msg || d?.type].filter(Boolean).join(': ')).join('; ')
    : typeof detail === 'string' ? detail : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const UPLOAD_TYPES = Object.freeze({
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
});

/**
 * Host local bytes for one render and return the public URL a model reads.
 * The signed upload headers authorize the PUT; the API key never goes to storage.
 */
export async function uploadHiggsfieldFile({ apiKey, bytes, contentType, signal }) {
  signal?.throwIfAborted();
  const created = await fetchWithTimeout(`${HIGGSFIELD_API_BASE}/files/generate-upload-url`, {
    method: 'POST', headers: headers(apiKey, true), signal,
    body: JSON.stringify({ content_type: contentType }),
  }, HIGGSFIELD_SUBMIT_TIMEOUT_MS);
  const target = await created.json().catch(() => null);
  if (!created.ok || typeof target?.upload_url !== 'string' || !target.upload_url.startsWith('https://')
    || typeof target?.public_url !== 'string' || !target.public_url.startsWith('https://')) {
    throw new ServerError(`Higgsfield upload could not start: HTTP ${created.status}`, { status: 502, code: 'HIGGSFIELD_UPLOAD_FAILED' });
  }
  const uploadHeaders = target.upload_headers && typeof target.upload_headers === 'object' && !Array.isArray(target.upload_headers)
    ? Object.fromEntries(Object.entries(target.upload_headers).filter(([, value]) => typeof value === 'string'))
    : {};
  signal?.throwIfAborted();
  const put = await fetchWithTimeout(target.upload_url, {
    method: 'PUT', headers: { 'Content-Type': contentType, ...uploadHeaders }, body: bytes, signal,
  }, HIGGSFIELD_UPLOAD_TIMEOUT_MS);
  await put.body?.cancel?.();
  if (!put.ok) throw new ServerError(`Higgsfield upload failed: HTTP ${put.status}`, { status: 502, code: 'HIGGSFIELD_UPLOAD_FAILED' });
  return target.public_url;
}

/** Upload a local image (PNG/JPEG/WebP/GIF) and return its public URL. */
export async function uploadHiggsfieldImage({ apiKey, path, bytes = null, signal }) {
  const data = bytes || await readFile(path);
  const format = detectImageFormat(data)?.format;
  const contentType = UPLOAD_TYPES[format];
  if (!contentType) throw new ServerError('Higgsfield accepts PNG, JPEG, WebP or GIF images', { status: 400, code: 'HIGGSFIELD_INPUT_INVALID' });
  return uploadHiggsfieldFile({ apiKey, bytes: data, contentType, signal });
}

/** Per-request bookkeeping shared by `cancelHiggsfieldRequest` and `awaitHiggsfieldRequest`. */
export const createHiggsfieldRequestEntry = (apiKey) => ({
  apiKey, controller: new AbortController(), aborted: false, requestId: null, cancelUrl: null, remoteTerminal: false, cancelPromise: null,
});

/**
 * Best-effort, idempotent cancellation. Never rethrows: the local job still
 * finalizes as failed/canceled either way. A 400 means the render already
 * started and cannot be stopped, so it is still billed (marked unsettled).
 */
export async function cancelHiggsfieldRequest(entry) {
  if (!entry) return;
  if (!entry.cancelPromise) {
    if (entry.remoteTerminal || !entry.cancelUrl || !entry.apiKey) return;
    entry.cancelPromise = fetchWithTimeout(entry.cancelUrl, {
      method: 'POST', headers: headers(entry.apiKey),
    }, HIGGSFIELD_POLL_TIMEOUT_MS)
      .then(async (res) => {
        await res.body?.cancel?.();
        if (res.status === 400) console.log('⏭️ Higgsfield request already started; it cannot be canceled remotely');
        else if (!res.ok && res.status !== 404) console.error(`❌ Higgsfield cancellation request failed: HTTP ${res.status}`);
      })
      .catch((err) => console.error(`❌ Higgsfield cancellation request failed: ${err?.message || err}`));
  }
  await entry.cancelPromise;
  if (!entry.remoteTerminal) maintenance.markCurrentUnsettled();
}

/**
 * Delete a FINISHED request's files, prompt and parameters from Higgsfield
 * (billing records stay). A 404 counts as already gone. User-requested, so a
 * failure throws.
 */
export async function deleteHiggsfieldRequest({ apiKey, requestId }) {
  const res = await fetchWithTimeout(`${HIGGSFIELD_API_BASE}/requests/${encodeURIComponent(requestId)}`, {
    method: 'DELETE', headers: headers(apiKey),
  }, HIGGSFIELD_POLL_TIMEOUT_MS);
  await res.body?.cancel?.();
  if (!res.ok && res.status !== 404) {
    throw new ServerError(`Higgsfield delete failed: HTTP ${res.status}`, { status: 502, code: 'HIGGSFIELD_DELETE_FAILED' });
  }
  return { alreadyGone: res.status === 404 };
}

/** Submit one paid generation. Resolves to `{ requestId, statusUrl, cancelUrl }`. */
export async function submitHiggsfieldRequest({ apiKey, endpoint, body, signal }) {
  signal?.throwIfAborted();
  const res = await fetchWithTimeout(`${HIGGSFIELD_API_BASE}/${endpoint}`, {
    method: 'POST',
    // A retried submit with the same key never creates a second paid request.
    headers: { ...headers(apiKey, true), 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  }, HIGGSFIELD_SUBMIT_TIMEOUT_MS).catch((err) => {
    // A lost POST response is not proof the paid request was rejected.
    maintenance.markCurrentUnsettled();
    throw err;
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || typeof payload?.request_id !== 'string') {
    if (res.ok || res.status >= 500) maintenance.markCurrentUnsettled();
    const detail = higgsfieldErrorDetail(payload);
    throw new ServerError(`Higgsfield rejected the request: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { status: 502, code: 'HIGGSFIELD_SUBMIT_FAILED' });
  }
  const requestBase = `${HIGGSFIELD_API_BASE}/requests/${encodeURIComponent(payload.request_id)}`;
  return {
    requestId: payload.request_id,
    statusUrl: typeof payload.status_url === 'string' ? payload.status_url : `${requestBase}/status`,
    cancelUrl: typeof payload.cancel_url === 'string' ? payload.cancel_url : `${requestBase}/cancel`,
  };
}

async function getHiggsfieldStatus({ apiKey, statusUrl }) {
  const res = await fetchWithTimeout(statusUrl, { headers: headers(apiKey) }, HIGGSFIELD_POLL_TIMEOUT_MS);
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new ServerError(`Higgsfield status check failed: HTTP ${res.status}`, { status: 502, code: 'HIGGSFIELD_STATUS_FAILED' });
  }
  return res.json();
}

/** The output URL a completed status carries for `kind` ('image' | 'video'), or null. */
function higgsfieldOutputUrl(status, kind) {
  const pick = (item) => (typeof item?.url === 'string' && item.url.trim() ? item.url : null);
  if (kind === 'image') return (Array.isArray(status?.images) ? status.images.map(pick).find(Boolean) : null) || null;
  return pick(status?.video);
}

/**
 * Poll a submitted request until Higgsfield reports it terminal, the caller
 * cancels (`entry.aborted`), or `deadline` passes. Resolves to
 * `{ outcome: 'completed', outputUrl }` or `{ outcome: 'canceled' | 'failed', reason? }`
 * and never throws. `onStatus(status)` reports `queued` / `in_progress`.
 */
export async function awaitHiggsfieldRequest({
  entry, apiKey, statusUrl, kind, deadline, timeoutMs, onPoll = () => {}, onStatus = () => {}, pollIntervalMs = HIGGSFIELD_POLL_INTERVAL_MS,
}) {
  let statusFailures = 0;
  const wait = () => new Promise((resolve) => {
    const signal = entry.controller.signal;
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, pollIntervalMs);
    signal.addEventListener('abort', done, { once: true });
  });
  while (Date.now() < deadline) {
    if (entry.aborted) {
      await cancelHiggsfieldRequest(entry);
      return { outcome: 'canceled' };
    }
    onPoll();
    let status;
    try {
      status = await getHiggsfieldStatus({ apiKey, statusUrl });
    } catch (err) {
      statusFailures += 1;
      if (statusFailures > HIGGSFIELD_MAX_STATUS_RETRIES) {
        await cancelHiggsfieldRequest(entry);
        return { outcome: 'failed', reason: `Higgsfield status checks failed ${statusFailures} times in a row: ${err?.message || err}` };
      }
      await wait();
      continue;
    }
    statusFailures = 0;
    const state = status?.status;
    if (state === 'completed') {
      entry.remoteTerminal = true;
      if (entry.aborted) return { outcome: 'canceled' };
      const outputUrl = higgsfieldOutputUrl(status, kind);
      return outputUrl ? { outcome: 'completed', outputUrl } : { outcome: 'failed', reason: `Higgsfield finished but returned no ${kind} URL` };
    }
    if (state === 'failed' || state === 'nsfw' || state === 'canceled') {
      entry.remoteTerminal = true;
      if (entry.aborted) return { outcome: 'canceled' };
      const reason = state === 'nsfw' ? 'Higgsfield moderation rejected the output (nsfw)'
        : `Higgsfield render ${state}${typeof status.error === 'string' && status.error.trim() ? `: ${status.error.trim().slice(0, 300)}` : ''}`;
      return { outcome: 'failed', reason };
    }
    onStatus(state);
    await wait();
  }
  await cancelHiggsfieldRequest(entry);
  if (entry.aborted) return { outcome: 'canceled' };
  return { outcome: 'failed', reason: `Higgsfield did not finish within ${Math.round(timeoutMs / 1000)}s` };
}
