/**
 * Google Cloud Agent Platform (formerly Vertex AI; still the `aiplatform.googleapis.com`
 * API) — the shared transport for the `google` image and video
 * backends (services/imageGen/google.js, services/videoGen/google.js).
 *
 * One credential (Settings > Credentials "Google Cloud (Agent Platform)", or the
 * GOOGLE_CLOUD_API_KEY env var) is either:
 *  - an Agent Platform API key — sent as `x-goog-api-key`. With no project set it
 *    calls the express-mode global endpoint (`aiplatform.googleapis.com/v1/
 *    publishers/google/models/...`); with a project it calls that project's
 *    regional endpoint (an API key bound to a service account). Express mode
 *    serves only the Gemini models Google lists for it, so Imagen and Veo need a project, or
 *  - a service account JSON key (`"type": "service_account"`) — exchanged for an
 *    OAuth access token with a self-signed JWT (RFC 7523), cached until shortly
 *    before it expires. Its `project_id` is the project unless one is set.
 *
 * The region (`videoGen.google.location`, default us-central1) applies to
 * Imagen and Veo; the Gemini image models are always called on `global`.
 *
 * Money: a predict / generateContent / predictLongRunning call is billed.
 * Google offers no cancel for a Veo operation, so abandoning one after submit
 * marks the run unsettled (it may still bill). A lost submit response is
 * unsettled too. Model probes (`checkGoogleModel`) are free reads.
 */

import { createSign } from 'crypto';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { safeJSONParse } from '../lib/jsonIo.js';
import { detectImageFormat } from '../lib/mimeTypes.js';
import { GOOGLE_DEFAULT_LOCATION, isValidGoogleLocation, isValidGoogleProjectId } from '../lib/googleCloudConfig.js';

export const GOOGLE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const GOOGLE_POLL_TIMEOUT_MS = 30_000;
export const GOOGLE_POLL_INTERVAL_MS = 5000;
export const GOOGLE_MAX_STATUS_RETRIES = 2;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Parse the stored credential. Returns `{ kind: 'serviceAccount', clientEmail,
 * privateKey, projectId, tokenUri }`, `{ kind: 'apiKey', apiKey }`, or null
 * when nothing usable is stored. A JSON value that is not a service account key
 * is refused rather than sent as an API key.
 */
function parseGoogleCredential(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (value.startsWith('{')) {
    const json = safeJSONParse(value, null);
    if (json?.type !== 'service_account' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
      throw new ServerError('The Google credential is JSON but not a service account key (it needs type, client_email and private_key)', { status: 400, code: 'GOOGLE_CREDENTIAL_INVALID' });
    }
    return {
      kind: 'serviceAccount',
      clientEmail: json.client_email,
      privateKey: json.private_key,
      projectId: typeof json.project_id === 'string' ? json.project_id : null,
      tokenUri: typeof json.token_uri === 'string' && json.token_uri.startsWith('https://') ? json.token_uri : TOKEN_URL,
    };
  }
  return { kind: 'apiKey', apiKey: value };
}

/** The raw stored credential (API key or service account JSON): settings first, then GOOGLE_CLOUD_API_KEY. */
function resolveGoogleCredentialValue(settings) {
  const fromSettings = (settings?.videoGen?.google?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  return (process.env.GOOGLE_CLOUD_API_KEY || '').trim() || null;
}

/**
 * Everything a request needs: the parsed credential, project and region.
 * Returns null when no credential is configured; throws for a malformed one.
 * The credential is re-resolved from live settings at dispatch and never rides
 * in persisted queue params.
 */
export function resolveGoogleConfig(settings) {
  const credential = parseGoogleCredential(resolveGoogleCredentialValue(settings));
  if (!credential) return null;
  const vg = settings?.videoGen?.google || {};
  const projectId = (typeof vg.projectId === 'string' && vg.projectId.trim()) || (credential.kind === 'serviceAccount' ? credential.projectId : null)
    || (process.env.GOOGLE_CLOUD_PROJECT || '').trim() || null;
  const location = isValidGoogleLocation(vg.location) ? vg.location : GOOGLE_DEFAULT_LOCATION;
  if (credential.kind === 'serviceAccount' && !projectId) {
    throw new ServerError('The Google service account key has no project_id; set the project in Settings > Media > Google', { status: 400, code: 'GOOGLE_CREDENTIAL_INVALID' });
  }
  if (projectId && !isValidGoogleProjectId(projectId)) {
    throw new ServerError('The Google project id is not a valid Google Cloud project id', { status: 400, code: 'GOOGLE_CREDENTIAL_INVALID' });
  }
  return { credential, projectId, location };
}

/**
 * Express mode (an API key with no project) serves only Google's short list of
 * Gemini models. Returns the refusal for a model outside it, or null.
 */
export function googleExpressModeRefusal(config, { label, expressMode = false }) {
  if (!config || config.projectId || expressMode) return null;
  return `${label} is not available in Agent Platform express mode (an API key with no project). Set your Google Cloud project in Settings > Media > Google, or use a service account key.`;
}

export const isGoogleConfigured = (settings) => Boolean(resolveGoogleCredentialValue(settings));

const base64url = (input) => Buffer.from(input).toString('base64url');
const tokenCache = new Map();

/** Exchange a service account key for an access token (cached per account). */
async function getGoogleAccessToken(credential, { now = Date.now } = {}) {
  const cached = tokenCache.get(credential.clientEmail);
  if (cached && cached.privateKey === credential.privateKey && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;
  const iat = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credential.clientEmail, scope: TOKEN_SCOPE, aud: credential.tokenUri, iat, exp: iat + 3600,
  }));
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(credential.privateKey, 'base64url');
  } catch {
    // Never echo the key material.
    throw new ServerError('The Google service account private key could not be read', { status: 400, code: 'GOOGLE_CREDENTIAL_INVALID' });
  }
  const res = await fetchWithTimeout(credential.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
  }, TOKEN_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || typeof payload?.access_token !== 'string') {
    const reason = typeof payload?.error_description === 'string' ? ` — ${payload.error_description.slice(0, 200)}` : '';
    throw new ServerError(`Google refused the Google service account: HTTP ${res.status}${reason}`, { status: 502, code: 'GOOGLE_AUTH_FAILED' });
  }
  const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600;
  tokenCache.set(credential.clientEmail, { token: payload.access_token, privateKey: credential.privateKey, expiresAt: now() + expiresIn * 1000 });
  return payload.access_token;
}

export const __resetGoogleTokenCache = () => tokenCache.clear();

async function authHeaders(config) {
  if (config.credential.kind === 'apiKey') return { 'x-goog-api-key': config.credential.apiKey };
  return { Authorization: `Bearer ${await getGoogleAccessToken(config.credential)}` };
}

/**
 * The model's resource URL for `method` (`predict`, `generateContent`,
 * `predictLongRunning`, `fetchPredictOperation`). `location` overrides the
 * configured region (the Gemini image models pass 'global').
 */
export function googleModelUrl(config, modelId, method, { location = null } = {}) {
  const loc = location || config.location;
  if (!config.projectId) {
    // Express mode: an API key with no project calls the global endpoint without a project path.
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(modelId)}:${method}`;
  }
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${config.projectId}/locations/${loc}/publishers/google/models/${encodeURIComponent(modelId)}:${method}`;
}

/** A short, single-line reason from a Google error body, or ''. */
function googleErrorDetail(payload) {
  const err = payload?.error;
  const text = typeof err?.message === 'string' ? err.message : typeof err === 'string' ? err : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * POST one JSON request. A lost response to a billed call marks the run
 * unsettled; a 4xx refusal does not.
 */
export async function googlePost(config, url, body, { signal, timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS, billed = true } = {}) {
  signal?.throwIfAborted();
  const headers = { ...(await authHeaders(config)), 'Content-Type': 'application/json' };
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, timeoutMs).catch((err) => {
    if (billed) maintenance.markCurrentUnsettled();
    throw err;
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    if (billed && res.status >= 500) maintenance.markCurrentUnsettled();
    const detail = googleErrorDetail(payload);
    throw new ServerError(`Google rejected the request: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { status: 502, code: 'GOOGLE_REQUEST_FAILED' });
  }
  if (!payload) {
    if (billed) maintenance.markCurrentUnsettled();
    throw new ServerError('Google returned an unreadable response', { status: 502, code: 'GOOGLE_REQUEST_FAILED' });
  }
  return payload;
}

/**
 * Free read: confirm the configured credential reaches `modelId`. Resolves to
 * `{ ok: true }` or `{ ok: false, reason }` and never throws.
 */
export async function checkGoogleModel(config, modelId, { location = null } = {}) {
  try {
    const loc = location || config.location;
    const host = !config.projectId || loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    const res = await fetchWithTimeout(`https://${host}/v1beta1/publishers/google/models/${encodeURIComponent(modelId)}`, {
      headers: await authHeaders(config),
    }, GOOGLE_POLL_TIMEOUT_MS);
    const payload = await res.json().catch(() => null);
    if (res.ok) return { ok: true };
    const detail = googleErrorDetail(payload);
    return { ok: false, reason: `Google answered HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

/** Per-request bookkeeping for a long-running Veo operation. */
export const createGoogleOperationEntry = () => ({
  controller: new AbortController(), aborted: false, operationName: null, remoteTerminal: false,
});

/**
 * Google has no cancel for a Veo operation. Abandoning a submitted one means
 * it may still bill, so the run is marked unsettled.
 */
export function abandonGoogleOperation(entry) {
  if (entry?.operationName && !entry.remoteTerminal) maintenance.markCurrentUnsettled();
}

/** Submit a long-running prediction; resolves to the operation name. */
export async function submitGoogleOperation(config, modelId, body, { signal } = {}) {
  const payload = await googlePost(config, googleModelUrl(config, modelId, 'predictLongRunning'), body, { signal, timeoutMs: GOOGLE_REQUEST_TIMEOUT_MS });
  if (typeof payload.name !== 'string' || !payload.name) {
    maintenance.markCurrentUnsettled();
    throw new ServerError('Google accepted the request but returned no operation name', { status: 502, code: 'GOOGLE_REQUEST_FAILED' });
  }
  return payload.name;
}

/**
 * Poll an operation until it is done, the caller aborts (`entry.aborted`) or
 * `deadline` passes. Resolves to `{ outcome: 'completed', response }` or
 * `{ outcome: 'canceled' | 'failed', reason? }` and never throws.
 */
export async function awaitGoogleOperation({
  entry, config, modelId, deadline, timeoutMs, onPoll = () => {}, pollIntervalMs = GOOGLE_POLL_INTERVAL_MS,
}) {
  const url = googleModelUrl(config, modelId, 'fetchPredictOperation');
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
      abandonGoogleOperation(entry);
      return { outcome: 'canceled' };
    }
    onPoll();
    let op;
    try {
      op = await googlePost(config, url, { operationName: entry.operationName }, { timeoutMs: GOOGLE_POLL_TIMEOUT_MS, billed: false });
    } catch (err) {
      statusFailures += 1;
      if (statusFailures > GOOGLE_MAX_STATUS_RETRIES) {
        abandonGoogleOperation(entry);
        return { outcome: 'failed', reason: `Google status checks failed ${statusFailures} times in a row: ${err?.message || err}` };
      }
      await wait();
      continue;
    }
    statusFailures = 0;
    if (op?.done === true) {
      entry.remoteTerminal = true;
      if (entry.aborted) return { outcome: 'canceled' };
      if (op.error) {
        const message = typeof op.error.message === 'string' ? op.error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : 'unknown error';
        return { outcome: 'failed', reason: `Google render failed: ${message}` };
      }
      return { outcome: 'completed', response: op.response || {} };
    }
    await wait();
  }
  abandonGoogleOperation(entry);
  if (entry.aborted) return { outcome: 'canceled' };
  return { outcome: 'failed', reason: `Google did not finish within ${Math.round(timeoutMs / 1000)}s` };
}

/** Why a finished response carried no media, from its safety-filter fields. */
export function googleFilteredReason(response, kind) {
  const reasons = Array.isArray(response?.raiMediaFilteredReasons) ? response.raiMediaFilteredReasons.filter((r) => typeof r === 'string') : [];
  const prefix = `Google returned no ${kind}`;
  if (reasons.length) return `${prefix}: ${reasons.join('; ').replace(/\s+/g, ' ').slice(0, 300)}`;
  if (Number(response?.raiMediaFilteredCount) > 0) return `${prefix}: blocked by its safety filter`;
  return prefix;
}

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Image bytes as the inline `{ mimeType, data }` Google reads (PNG, JPEG or WebP). */
export function googleInlineImage(bytes) {
  const mime = detectImageFormat(bytes)?.mime;
  if (!INLINE_IMAGE_TYPES.has(mime)) {
    throw new ServerError('Google accepts PNG, JPEG or WebP input images', { status: 400, code: 'GOOGLE_INPUT_INVALID' });
  }
  return { mimeType: mime, data: bytes.toString('base64') };
}
