/**
 * Beeper Desktop API client (fork issue #29, part of #1).
 *
 * Raw `fetch`, deliberately NOT `@beeper/desktop-api` — the published SDK lags
 * the live API and exposes no `Account.status`, no `loginID`, no `/v1/bridges`;
 * `GET /v1/spec` on the running instance is the authoritative reference (see
 * the API-surface research note, `docs/research/2026-08-31-beeper-api-surface.md`
 * on the `research/beeper` branch — not merged onto `beeper/integration`, so the
 * path is not resolvable from this branch alone). Every other Beeper feature
 * (#30-#37) is built on this module.
 *
 * `server/lib/safeUrlFetch.js` cannot wrap this: it blocks loopback in both
 * postures by design, and Beeper Desktop's whole API IS a loopback service
 * (default `http://127.0.0.1:23373`). This module goes straight to
 * `fetchWithTimeout` instead, same as `ollamaManager.js` / `lmStudioManager.js`
 * for the other local-daemon integrations. `safeUrlFetch`'s `readBodyCapped`
 * two-stage byte cap (Content-Length early-out, then a streamed abort once
 * accumulated bytes exceed the ceiling) is NOT reused here — every JSON
 * response this module reads is small, from a local trusted process, read via
 * `readResponseJson`. The byte-streaming asset fetch (attachment mirror, #37 —
 * `headAsset` / `fetchAssetStream` below) is the one caller that wants that
 * two-stage shape, and it enforces its own: a `HEAD` pre-flight plus a
 * mid-stream abort, both against `BEEPER_ATTACHMENT_MAX_BYTES`.
 *
 * Auth and base URL: `settings.beeper.baseUrl` (default below) and, since #31,
 * the vault-backed credential store (`beeperCredentials.resolveBeeperToken` —
 * AES-256-GCM in Postgres, per fork issue #11 decision 6). `resolveBeeperConfig`
 * is the one call site that resolves it; the legacy plaintext
 * `settings.beeper.token` from #29 survives there as a READ-only fallback so an
 * install that hand-edited one keeps working. Nothing here ever writes a token.
 * Every caller-facing function also accepts an explicit `{ baseUrl, token }`
 * override, which skips both stores entirely.
 */

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { describeFetchError, isReplayableConnectionError } from '../lib/fetchErrorChain.js';
import { ServerError } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { isLoopbackHostname, parseBrowserOrigin } from '../lib/beeperOAuthOrigin.js';
import { getSettings } from './settings.js';
import { resolveBeeperToken } from './beeperCredentials.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:23373';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// Fork issue #61, decision 7. The original 1s cap (a live Beeper Desktop
// answers in single-digit-to-low-double-digit ms, and a closed loopback port
// refuses near-instantly) turned out to be too tight on a loaded machine: a
// Beeper Desktop that is genuinely up but briefly slow to answer the bare
// liveness probe timed out and reported the same "unreachable" card as a
// closed app, even seconds after it had handled a real request. 3s is still
// well short of `DEFAULT_REQUEST_TIMEOUT_MS` (this stays a liveness probe, not
// a request budget) but gives a momentarily busy app room to answer before the
// card treats it as gone. A timeout on ITS OWN is still ambiguous, though —
// nothing distinguishes "briefly slow" from "actually closed" from timing
// alone — which is what `RECENT_SUCCESS_WINDOW_MS` below is for.
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
// Paired with the cap above: a probe timeout is reported as `probeState:
// 'slow'` (reachable stays true) rather than `'unreachable'` ONLY when a real
// Beeper call — an authenticated API request through this client, or a
// realtime-socket ping (server/services/beeperSocket.js) — succeeded within
// this window. 60s comfortably survives one missed probe against the socket's
// own ~30s ping cadence while staying short enough that an app closed for real
// still reaches the unreachable card within a minute of going quiet — a probe
// timeout with no recent success (nothing else has talked to Beeper lately
// either) is exactly what "unreachable" means, promptly.
export const RECENT_SUCCESS_WINDOW_MS = 60_000;

// Last time ANY call through `beeperRequest` (a real API call, or a successful
// probe) completed. `null` until the first one — `hasRecentBeeperSuccess`
// reads that as "no recent success" rather than an epoch-zero false positive.
let lastSuccessAt = null;

function noteSuccess() {
  lastSuccessAt = Date.now();
}

/** Whether a Beeper call has completed within `RECENT_SUCCESS_WINDOW_MS`. */
export function hasRecentBeeperSuccess(nowMs = Date.now()) {
  return typeof lastSuccessAt === 'number' && (nowMs - lastSuccessAt) <= RECENT_SUCCESS_WINDOW_MS;
}

// Test-only: `beeperStatus.test.js` and `beeperClient.test.js` need to drive
// `hasRecentBeeperSuccess` without waiting on a real successful request first.
export function __setLastBeeperSuccessAtForTests(value) {
  lastSuccessAt = value;
}
// Reads may retry once on a replayable connection failure (Beeper Desktop
// restarting mid-request); a fresh request-scoped budget on the replay, same
// shape as fetchWithTimeout's own retry contract.
const READ_RETRY = { retries: 1, retryDelayMs: 300, shouldRetry: isReplayableConnectionError };

/**
 * Typed Beeper API error. `retryable` reflects the mapping in
 * `mapBeeperResponseError`, clamped to `false` whenever the originating call
 * ran with `allowRetry: false` (every write: send/edit/delete/react/archive/
 * read-state) — callers building their own retry policy on top of this client
 * should key on it rather than re-deriving from `status`.
 */
export class BeeperApiError extends ServerError {
  constructor(message, { status = 500, code, retryable = false, details } = {}) {
    super(message, { status, code, context: { retryable, ...(details !== undefined ? { details } : {}) } });
    this.name = 'BeeperApiError';
    this.retryable = retryable;
    // ServerError's constructor does `this.status = options.status || 500`, which
    // silently rewrites a deliberate `status: 0` ("no HTTP response at all", the
    // network-error case below) into a fabricated 500. Restore the caller's actual
    // value here so `err.status === 0` is a reliable way to spot a transport
    // failure, not just `err.code === 'NETWORK_ERROR'`.
    this.status = status;
  }
}

// Logged at most once per distinct rejected value (not on every call — this
// runs on the hot path: every sweep tick, every status poll) so a
// misconfigured install narrates the fallback without spamming the log.
let lastRejectedBaseUrl;

/**
 * Normalize a candidate Beeper Desktop base URL, re-applying the SAME
 * loopback-only gate `beeperSettingsSchema` enforces on the PUT route
 * (SEC-2, `server/lib/mediaValidation.js`) — not belt-and-suspenders.
 * `getSettings()` reads `settings.json` off disk with NO schema
 * re-validation on read, so a hand-edited file is a path that can still hand
 * a non-loopback origin — with a live vault token attached to every request —
 * to `beeperRequest`, even though the settings PUT route would have refused
 * it. A rejected value falls back to the shipped loopback default rather than
 * reaching a single request.
 */
function normalizeBaseUrl(value, { allowNonLoopback = false } = {}) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  const parsed = parseBrowserOrigin(trimmed);
  if (parsed && (isLoopbackHostname(parsed.hostname) || allowNonLoopback)) {
    return parsed.origin;
  }
  if (trimmed !== lastRejectedBaseUrl) {
    lastRejectedBaseUrl = trimmed;
    console.error(`❌ Beeper baseUrl "${trimmed}" is not a loopback origin and allowNonLoopbackBaseUrl is not set — falling back to ${DEFAULT_BASE_URL}`);
  }
  return DEFAULT_BASE_URL;
}

/**
 * The configured Beeper Desktop base URL, trailing slash trimmed, falling back
 * to the loopback default. Exported so the connect flow (#31) resolves it
 * exactly the way every API call does instead of re-deriving it.
 */
export async function resolveBeeperBaseUrl() {
  const settings = await getSettings().catch(() => null);
  return normalizeBaseUrl(settings?.beeper?.baseUrl, {
    allowNonLoopback: settings?.beeper?.allowNonLoopbackBaseUrl === true,
  });
}

function normalizeToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve `{ baseUrl, token }` for a call. An explicit `baseUrl` AND `token`
 * (token may be `null`, meaning "deliberately unauthenticated") skip both
 * stores entirely — this is what keeps most tests in this file free of any
 * mock. Otherwise the base URL falls back to `settings.beeper.baseUrl` and then
 * to the hardcoded default, while the token comes from the vault-backed store
 * (`resolveBeeperToken`, #31), which itself falls back to the legacy plaintext
 * `settings.beeper.token` for reads.
 *
 * An unreadable vault THROWS out of here rather than resolving `token: null`:
 * "the credential cannot be read" and "no credential is configured" are
 * different conditions, and collapsing them would report a connected install as
 * unconfigured (the absent-vs-empty sentinel rule).
 *
 * SEC-2's loopback-only gate applies whenever `baseUrl` is resolved FROM
 * settings below — the one path a hand-edited `settings.json` can reach. The
 * "both explicit" bypass above trusts its caller instead of re-deriving the
 * gate here: it exists for values ALREADY resolved through
 * `resolveBeeperBaseUrl()` (the OAuth discovery baseUrl, and
 * `beeperStatus.js`'s probes — both call `resolveBeeperBaseUrl()` rather than
 * reading `settings.beeper.baseUrl` directly for exactly this reason) plus the
 * many tests in this file, and gating it a second time would need the
 * opt-in re-derived here anyway, defeating "skip both stores entirely." A
 * caller with a genuinely unvalidated `baseUrl` must resolve it through
 * `resolveBeeperBaseUrl()` first, never pass it straight into this bypass.
 */
export async function resolveBeeperConfig({ baseUrl, token } = {}) {
  if (baseUrl !== undefined && token !== undefined) {
    // `allowNonLoopback: true` — trust the caller entirely rather than
    // re-deriving the settings-sourced opt-in (which would defeat "skip both
    // stores"). `normalizeBaseUrl` still enforces the bare-origin SHAPE and
    // still trims a trailing slash; only the loopback gate is waived here.
    return { baseUrl: normalizeBaseUrl(baseUrl, { allowNonLoopback: true }), token: normalizeToken(token) };
  }
  const settings = await getSettings().catch(() => null);
  const resolvedBaseUrl = baseUrl !== undefined ? baseUrl : settings?.beeper?.baseUrl;
  const allowNonLoopback = settings?.beeper?.allowNonLoopbackBaseUrl === true;
  if (token !== undefined) {
    return { baseUrl: normalizeBaseUrl(resolvedBaseUrl, { allowNonLoopback }), token: normalizeToken(token) };
  }
  const stored = await resolveBeeperToken();
  return { baseUrl: normalizeBaseUrl(resolvedBaseUrl, { allowNonLoopback }), token: normalizeToken(stored?.token) };
}

/**
 * Map a non-ok Beeper response to a typed, retry-classified error.
 *
 * `retryEligible` (default `true`) clamps every status-table verdict to
 * non-retryable when the call itself was never eligible to retry. A write
 * call runs with `allowRetry: false` (the client-wide send-safe default) and
 * must never hand back `retryable: true` on its thrown error — that field is
 * the client's own documented "key on this, not on status" contract
 * (`BeeperApiError` above), and a caller following it would otherwise
 * duplicate a real send. `beeperRequest` passes its own `allowRetry` through
 * unchanged as `retryEligible`; only the asset-502 branch below ignores it,
 * since that mapping is `retryable: false` unconditionally regardless of
 * retry eligibility.
 *
 * The one non-conventional case: `GET`/`HEAD /v1/assets/serve` answers `502`
 * for a missing/expired asset, not `404` (live-verified on both methods). A
 * generic "5xx is transient" retry policy loops forever on media the network
 * has aged out, so an asset-endpoint `502` maps to a TERMINAL
 * `ASSET_UNAVAILABLE` rather than the ordinarily-retryable `UPSTREAM_ERROR`.
 * `POST /v1/assets/download` does NOT share this — it answers `200` with an
 * `{ error }` body instead, so this `502` branch never fires for it; that
 * shape is validated separately in `downloadAsset` below. Every other status
 * follows the spec's documented meaning (see the
 * API-surface research note, `docs/research/2026-08-31-beeper-api-surface.md`
 * §7, on the `research/beeper` branch); `code` is never a published enum, so
 * it rides along under `details` for logging only.
 */
export function mapBeeperResponseError(status, body, { isAssetEndpoint = false, retryEligible = true } = {}) {
  const beeperCode = body?.code;
  const message = typeof body?.message === 'string' && body.message
    ? body.message
    : `Beeper API error: ${status}`;
  const details = beeperCode !== undefined ? { beeperCode } : undefined;

  if (status === 502 && isAssetEndpoint) {
    return new BeeperApiError(message, { status, code: 'ASSET_UNAVAILABLE', retryable: false, details });
  }

  const STATUS_TABLE = {
    400: { code: 'BAD_REQUEST', retryable: false },
    401: { code: 'UNAUTHORIZED', retryable: false },
    403: { code: 'FORBIDDEN', retryable: false },
    404: { code: 'NOT_FOUND', retryable: false },
    409: { code: 'CONFLICT', retryable: false },
    422: { code: 'VALIDATION_ERROR', retryable: false },
    429: { code: 'RATE_LIMITED', retryable: true },
    500: { code: 'INTERNAL_ERROR', retryable: true },
    502: { code: 'UPSTREAM_ERROR', retryable: true },
  };
  const mapped = STATUS_TABLE[status] || { code: 'UNKNOWN_ERROR', retryable: status >= 500 };
  return new BeeperApiError(message, { status, code: mapped.code, retryable: retryEligible && mapped.retryable, details });
}

/**
 * Low-level authenticated request. Every call goes through `fetchWithTimeout`
 * (requirement: "fetchWithTimeout on every call"). `allowRetry` is OFF by
 * default — the send-safe default, since Beeper has no idempotency key on
 * send and a retried POST duplicates a real message. Read call sites opt in
 * explicitly with `allowRetry: true`.
 */
async function beeperRequest(path, {
  method = 'GET',
  body,
  headers,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  baseUrl,
  token,
  requireAuth = true,
  allowRetry = false,
  isAssetEndpoint = false,
} = {}) {
  const resolved = await resolveBeeperConfig({ baseUrl, token });
  if (requireAuth && !resolved.token) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }

  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (resolved.token) reqHeaders.Authorization = `Bearer ${resolved.token}`;

  // `timeoutMs` covers headers AND body consumption inside `fetchWithTimeout`
  // (#7236), so there is no second body deadline to keep here. What that helper
  // deliberately does NOT bound is a whole retry SEQUENCE — each replay gets a
  // fresh budget — so a read that may replay carries a caller-owned signal as
  // the TOTAL deadline, which is exactly the hook `waitForRetry` honors. A
  // Beeper that keeps dropping connections therefore cannot stretch one logical
  // request across unbounded backoffs.
  const totalDeadline = allowRetry && Number.isFinite(timeoutMs) && timeoutMs > 0 ? new AbortController() : null;
  const totalDeadlineId = totalDeadline ? setTimeout(() => totalDeadline.abort(), timeoutMs) : null;

  let response;
  let data;
  try {
    response = await fetchWithTimeout(`${resolved.baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(totalDeadline ? { signal: totalDeadline.signal } : {}),
    }, timeoutMs, allowRetry ? READ_RETRY : {});

    if (response.status === 204) {
      noteSuccess();
      return null;
    }
    data = await readResponseJson(response, { fallback: (text) => ({ message: text }) });
  } catch (err) {
    const description = describeFetchError(err);
    // AbortController firing (during headers OR body consumption) is the one
    // network failure that means "no answer arrived in time" rather than
    // "nothing is listening" — the distinction `probeBeeperInfo` needs to
    // tell `slow` from `unreachable` (fork issue #61, decision 7).
    const timedOut = /\babort/i.test(description);
    throw new BeeperApiError(`Beeper request failed: ${description}`, {
      status: 0, code: 'NETWORK_ERROR', retryable: allowRetry && isReplayableConnectionError(err),
      details: timedOut ? { timedOut: true } : undefined,
    });
  } finally {
    if (totalDeadlineId !== null) clearTimeout(totalDeadlineId);
  }

  if (!response.ok) throw mapBeeperResponseError(response.status, data, { isAssetEndpoint, retryEligible: allowRetry });
  noteSuccess();
  return data;
}

// ---------------------------------------------------------------------------
// Discovery / liveness
// ---------------------------------------------------------------------------

/**
 * `GET /v1/info` — the one endpoint that also answers UNAUTHENTICATED, which is
 * what makes it the liveness probe and what disqualifies it as a credential
 * check: it answers 200 for a bogus token just as happily (#31's connect flow
 * introspects instead). `token: null` is explicit, so a probe never triggers a
 * credential read.
 */
export async function getInfo({ baseUrl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return beeperRequest('/v1/info', { baseUrl, token: null, requireAuth: false, timeoutMs });
}

/**
 * Structural check on `/v1/info`'s response body (#30 — a wave-one reviewer
 * requirement on the status probe). `app.name` and `server.status` are the
 * two fields every documented shape carries (see the API-surface research
 * note). A 200 with an unexpected body — some other local HTTP service
 * answering on a misconfigured `settings.beeper.baseUrl` (#30 makes that
 * user-editable), or a Beeper Desktop version mid-upgrade — must not be
 * reported as a healthy probe just because the transport succeeded. Exported
 * so a caller that wants the raw typed error (rather than `probeBeeperInfo`'s
 * swallowed boolean) can throw it directly.
 */
export function assertValidInfoResponse(info) {
  const valid = isPlainObject(info)
    && typeof info?.app?.name === 'string' && info.app.name.length > 0
    && typeof info?.server?.status === 'string' && info.server.status.length > 0;
  if (!valid) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/info response shape (expected { app: { name }, server: { status } })', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
}

/**
 * Liveness probe with a `DEFAULT_PROBE_TIMEOUT_MS` cap (#11, revised at fork
 * issue #61 decision 7) — generous headroom over a live Beeper Desktop's
 * actual response time, without being a real request budget. Never throws —
 * an unreachable/misconfigured install is a normal outcome for a feature the
 * user hasn't set up yet, not an exceptional one. A shape-invalid 200 (see
 * `assertValidInfoResponse`) reports `reachable: false` exactly like a
 * transport failure — a body that isn't Beeper's `/v1/info` never counts as
 * "reachable" just because *something* answered.
 *
 * `timedOut` and `latencyMs` are additive fields for `beeperStatus.js` to
 * derive `probeState: 'ok' | 'slow' | 'unreachable'` from — see
 * `hasRecentBeeperSuccess` above. Every existing caller that reads only
 * `reachable`/`info`/`error` is unaffected.
 */
export async function probeBeeperInfo({ baseUrl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  try {
    const info = await getInfo({ baseUrl, timeoutMs });
    assertValidInfoResponse(info);
    return {
      reachable: true, info, error: null, timedOut: false, latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const timedOut = err instanceof BeeperApiError && err.context?.details?.timedOut === true;
    return {
      reachable: false,
      info: null,
      error: err instanceof BeeperApiError ? err.message : describeFetchError(err),
      timedOut,
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

/**
 * Walk a cursor-paginated Beeper endpoint as an async iterator, so callers
 * never hand-roll the cursor loop. `fetchPage({ cursor, direction })` must
 * return the standard envelope `{ items, hasMore, oldestCursor, newestCursor }`.
 *
 * `direction: 'before'` (default) walks `oldestCursor` — the only direction
 * the endpoints this client wraps document as safe to auto-paginate (the SDK's
 * own auto-pagination only ever walks backwards too). `hasMore: true` with no
 * cursor to continue on is treated as exhausted rather than looping forever —
 * a defensive stop, since the spec never documents that combination. Same
 * defense if a server answers `hasMore: true` with the SAME cursor it was
 * just called with (a value that would otherwise walk in place forever).
 *
 * A page whose `items` isn't an array (a malformed/unexpected response body —
 * see `getAccounts`/`getBridges` below for the same rule) throws a typed
 * `MALFORMED_RESPONSE` `BeeperApiError` rather than silently coercing to `[]`
 * and reporting "no items" — the AGENTS.md "sentinel + validate" rule: absent,
 * failed, and invalid must never collapse into the same value as
 * legitimately-empty.
 */
export async function* paginateBeeperCursor(fetchPage, { direction = 'before' } = {}) {
  let cursor;
  for (;;) {
    const page = await fetchPage({ cursor, direction });
    if (!Array.isArray(page?.items)) {
      throw new BeeperApiError('Beeper API returned an unexpected paginated response shape (expected { items: [] })', {
        status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
      });
    }
    for (const item of page.items) yield item;
    if (!page?.hasMore) return;
    const nextCursor = direction === 'after' ? page?.newestCursor : page?.oldestCursor;
    if (!nextCursor || nextCursor === cursor) return;
    cursor = nextCursor;
  }
}

function cursorQuery({ cursor, direction }) {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

function clampLimit(value, { min = 1, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Append arbitrary search/filter params onto a `URLSearchParams`. An array
 * value (`accountIDs`, `chatIDs`, `mediaTypes` — all declared as array query
 * params in `/v1/spec`) is serialized as REPEATED keys (`?chatIDs=a&chatIDs=b`),
 * not `qs.set(key, String(array))`, which would comma-join it into one value
 * (`chatIDs=a%2Cb`) that the server reads as a single id matching nothing.
 */
function appendSearchParams(qs, params) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        qs.append(key, String(item));
      }
      continue;
    }
    qs.set(key, String(value));
  }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/**
 * `GET /v1/chats` — no `limit` param (server-chosen page size). One page.
 *
 * `accountIDs` is the endpoint's only filter and is declared as an ARRAY query
 * param, so it goes through `appendSearchParams` (repeated keys) rather than
 * `qs.set`, which would comma-join two ids into one value matching no account.
 * The ingestion sweep (#32) pages one account at a time so a chat row is
 * always attributable to the account whose cursor bounds it — without the
 * filter it would have to page the whole cross-account list once per account.
 * An omitted/empty `accountIDs` sends no filter at all (every account), never
 * an empty `accountIDs=` that the server would read as "match nothing".
 */
export async function listChatsPage({ cursor, direction = 'before', accountIDs, baseUrl, token, timeoutMs } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, { accountIDs });
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return beeperRequest(`/v1/chats${query ? `?${query}` : ''}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/** Async iterator over every chat, walking cursors automatically. */
export function listChats({ direction = 'before', accountIDs, baseUrl, token, timeoutMs } = {}) {
  return paginateBeeperCursor(
    ({ cursor, direction: dir }) => listChatsPage({
      cursor, direction: dir, accountIDs, baseUrl, token, timeoutMs,
    }),
    { direction },
  );
}

export async function getChat(chatId, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/** `GET /v1/chats/search` — has `limit` (default 50, max 200). One page. */
export async function searchChatsPage({ limit, cursor, direction = 'before', baseUrl, token, timeoutMs, ...params } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, params);
  const clamped = clampLimit(limit, { min: 1, max: 200, fallback: undefined });
  if (clamped !== undefined) qs.set('limit', String(clamped));
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return beeperRequest(`/v1/chats/search${query ? `?${query}` : ''}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** `GET /v1/chats/{chatID}/messages` — no `limit` param. One page. */
export async function listMessagesPage(chatId, { cursor, direction = 'before', baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages${cursorQuery({ cursor, direction })}`,
    { baseUrl, token, timeoutMs, allowRetry: true },
  );
}

/** Async iterator over every message in a chat, walking cursors automatically. */
export function listMessages(chatId, { direction = 'before', baseUrl, token, timeoutMs } = {}) {
  return paginateBeeperCursor(
    ({ cursor, direction: dir }) => listMessagesPage(chatId, { cursor, direction: dir, baseUrl, token, timeoutMs }),
    { direction },
  );
}

export async function getMessage(chatId, messageId, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    { baseUrl, token, timeoutMs, allowRetry: true },
  );
}

/** `GET /v1/messages/search` — `limit` is hard-capped at 20 (default 20). One page. */
export async function searchMessagesPage({ limit, cursor, direction = 'before', baseUrl, token, timeoutMs, ...params } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, params);
  const clamped = clampLimit(limit, { min: 1, max: 20, fallback: 20 });
  qs.set('limit', String(clamped));
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  return beeperRequest(`/v1/messages/search?${qs.toString()}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/**
 * Send a message. Retry is OFF (the client-wide default) — there is no
 * idempotency key on send, so a retried POST sends a second real message.
 */
export async function sendMessage(chatId, { text, replyToMessageID, attachment } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: { text, replyToMessageID, attachment },
    baseUrl, token, timeoutMs,
  });
}

/** Edit a message. No retry — same send-safety posture as `sendMessage`. */
export async function editMessage(chatId, messageId, text, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PUT',
    body: { text },
    baseUrl, token, timeoutMs,
  });
}

/**
 * Delete (unsend) a message. `forEveryone` is REQUIRED and must be an
 * explicit boolean — the API defaults it to `true` when omitted, unsending
 * for every participant on networks that support it. No retry.
 */
export async function deleteMessage(chatId, messageId, forEveryone, { baseUrl, token, timeoutMs } = {}) {
  if (typeof forEveryone !== 'boolean') {
    throw new BeeperApiError(
      'deleteMessage requires an explicit boolean forEveryone — Beeper defaults an omitted value to true (unsend for everyone)',
      { status: 400, code: 'FOR_EVERYONE_REQUIRED', retryable: false },
    );
  }
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?forEveryone=${forEveryone}`,
    { method: 'DELETE', baseUrl, token, timeoutMs },
  );
}

export async function addReaction(chatId, messageId, reactionKey, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: 'POST',
    body: { reactionKey },
    baseUrl, token, timeoutMs,
  });
}

export async function removeReaction(chatId, messageId, reactionKey, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionKey)}`,
    { method: 'DELETE', baseUrl, token, timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Chat state (archive / read)
// ---------------------------------------------------------------------------

/** `PATCH /v1/chats/{chatID}` with `{isArchived}` — returns the updated Chat. */
export async function archiveChat(chatId, archived = true, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'PATCH',
    body: { isArchived: archived },
    baseUrl, token, timeoutMs,
  });
}

/**
 * `PATCH /v1/chats/{chatID}` — the chat-state update endpoint, and the write
 * path behind the two rail controls #9 wired (Archive, Low priority). The body
 * is an explicit allowlist rather than a passthrough: `PATCH` also carries the
 * draft field, and a spread of caller-supplied keys would let a route body
 * clear a draft (or set one) as a side effect of archiving a chat.
 *
 * `archiveChat` above stays as the narrow archive-only spelling; this is the
 * general form and returns the updated `Chat` either way. Retries are OFF
 * (`beeperRequest`'s default) — a Beeper write has no idempotency key.
 */
export async function updateChat(chatId, patch = {}, { baseUrl, token, timeoutMs } = {}) {
  const body = {};
  if (typeof patch.isArchived === 'boolean') body.isArchived = patch.isArchived;
  if (typeof patch.isLowPriority === 'boolean') body.isLowPriority = patch.isLowPriority;
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'PATCH',
    body,
    baseUrl, token, timeoutMs,
  });
}

export async function markRead(chatId, { messageID } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/read`, {
    method: 'POST',
    body: messageID ? { messageID } : {},
    baseUrl, token, timeoutMs,
  });
}

export async function markUnread(chatId, { messageID } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/unread`, {
    method: 'POST',
    body: messageID ? { messageID } : {},
    baseUrl, token, timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * `POST /v1/assets/download` — resolves an `mxc://`/`localmxc://` reference to
 * a local file URL, returned as `{ srcURL }`. A missing/expired asset answers
 * HTTP `200` here — NOT `502` — with `{ error: '<message>' }` and no `srcURL`
 * (`AssetDownloadResponse` documents both fields as optional siblings on the
 * one 200 shape; live-verified against an unresolvable `mxc://` reference).
 * `beeperRequest` only maps non-2xx statuses, so a 200-with-`error` body would
 * otherwise pass through as a "success" carrying no file to read. Validate the
 * body here instead: an `error` string, or a response missing a non-empty
 * `srcURL`, is the same terminal condition the 502 branch of
 * `mapBeeperResponseError` exists for — `ASSET_UNAVAILABLE`, never retryable
 * — so both failure shapes converge on the same caller-facing error. The
 * `502`-on-`assets/serve` case (`GET`/`HEAD`, see below) is unrelated and
 * still goes through `mapBeeperResponseError`'s status branch. Byte streaming
 * (`GET /v1/assets/serve`, implemented below as `fetchAssetStream`/
 * `headAsset`) and disk mirroring (`beeperAttachments.js`) are not
 * implemented in `downloadAsset`.
 */
export async function downloadAsset(url, { baseUrl, token, timeoutMs } = {}) {
  const data = await beeperRequest('/v1/assets/download', {
    method: 'POST',
    body: { url },
    baseUrl, token, timeoutMs,
    isAssetEndpoint: true,
  });
  const srcURL = typeof data?.srcURL === 'string' ? data.srcURL : '';
  if (typeof data?.error === 'string' && data.error) {
    throw new BeeperApiError(data.error, { status: 200, code: 'ASSET_UNAVAILABLE', retryable: false });
  }
  if (!srcURL) {
    throw new BeeperApiError('Beeper /v1/assets/download returned no srcURL', {
      status: 200, code: 'ASSET_UNAVAILABLE', retryable: false,
    });
  }
  return data;
}

/**
 * The byte-streaming half of the asset surface (#37): `GET /v1/assets/serve`.
 *
 * `beeperRequest` cannot serve these — it reads every response through
 * `readResponseJson`, which is right for the small local JSON the rest of this
 * client speaks to and catastrophic for a 30 MB video (it would buffer the
 * whole body in memory to hand back a `{ message: '<binary>' }`). These two
 * functions therefore go to `fetchWithTimeout` directly and hand the caller
 * the RAW `Response`, whose body the mirror streams to disk.
 *
 * What they do NOT skip is the error mapping. `serve` answers `502` for media
 * the network has aged out — unlike `POST /v1/assets/download`, which answers
 * 200 with an { error } body — so both run through `mapBeeperResponseError`
 * with `isAssetEndpoint: true` — a terminal `ASSET_UNAVAILABLE`, never the
 * ordinarily-retryable `UPSTREAM_ERROR` a generic "5xx is transient" policy
 * would loop on forever.
 */
// Time to the RESPONSE HEADERS, not to the last byte — which is why this is the
// one call site that opts out of `fetchWithTimeout`'s body deadline below.
// Generous rather than the 15s a JSON call gets, because Beeper may have to
// pull the media off the network before it can answer at all. The BODY is
// bounded separately by the mirror's own idle-abort (`STREAM_IDLE_TIMEOUT_MS`
// in `beeperAttachments.js`), which is what a caller passing `signal` here is
// usually doing — a whole-transfer ceiling here would instead kill a large
// attachment that is streaming along perfectly happily.
const ASSET_REQUEST_TIMEOUT_MS = 60_000;

function assetErrorFrom(response) {
  // A `serve`/HEAD failure body is not reliably JSON (and a HEAD has no body
  // at all), so the mapper is handed the status alone and builds its own
  // message rather than inventing a `code` that never came from Beeper.
  return mapBeeperResponseError(response.status, null, { isAssetEndpoint: true, retryEligible: false });
}

async function assetRequest(mxcId, { method, baseUrl, token, timeoutMs = ASSET_REQUEST_TIMEOUT_MS, signal } = {}) {
  const resolved = await resolveBeeperConfig({ baseUrl, token });
  if (!resolved.token) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }
  const reference = String(mxcId || '').trim();
  if (!reference) {
    throw new BeeperApiError('Beeper asset reference is empty', {
      status: 400, code: 'BAD_REQUEST', retryable: false,
    });
  }
  const url = `${resolved.baseUrl}/v1/assets/serve?url=${encodeURIComponent(reference)}`;
  const response = await fetchWithTimeout(url, {
    method,
    headers: { Authorization: `Bearer ${resolved.token}` },
    redirect: 'error',
    signal,
  }, timeoutMs, { bodyDeadline: false }).catch((err) => {
    throw new BeeperApiError(`Beeper asset request failed: ${describeFetchError(err)}`, {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    });
  });
  if (!response.ok) {
    // Drain, so an error body cannot hold the socket open.
    await response.body?.cancel?.().catch(() => {});
    throw assetErrorFrom(response);
  }
  return response;
}

/**
 * `HEAD /v1/assets/serve` — the pre-flight the size ceiling and the eviction
 * guard both key on. Returns `{ bytes }`, with `bytes: null` when the server
 * declines to say (the absent-vs-empty rule: "unknown size" must not read as
 * "zero bytes", which would sail under any ceiling).
 *
 * A `502` here is the eviction guard's whole point: it means Beeper can no
 * longer supply the file, so the local copy is the last one and must be kept
 * regardless of age.
 */
export async function headAsset(mxcId, { baseUrl, token, timeoutMs, signal } = {}) {
  const response = await assetRequest(mxcId, { method: 'HEAD', baseUrl, token, timeoutMs, signal });
  const raw = response.headers?.get?.('content-length');
  const bytes = Number(raw);
  return { bytes: raw !== null && raw !== undefined && Number.isFinite(bytes) ? bytes : null };
}

/**
 * `GET /v1/assets/serve` — the raw streaming response. The caller owns the
 * body: it must consume or cancel it.
 *
 * `serve` sends NO `Content-Type` (probed live, #13), which is why the mirror
 * stores Beeper's declared `mimeType` from the message payload and serves from
 * that instead of sniffing anything here. `timeoutMs` covers the headers only;
 * pass `signal` to bound the body.
 */
export async function fetchAssetStream(mxcId, { baseUrl, token, timeoutMs, signal } = {}) {
  return assetRequest(mxcId, { method: 'GET', baseUrl, token, timeoutMs, signal });
}

// ---------------------------------------------------------------------------
// Accounts / bridges
// ---------------------------------------------------------------------------

// Strips the top-level `loginID` field — it is the user's phone number
// (requirement: never log or persist it from either /v1/accounts or
// /v1/bridges) — and ONLY that field. This is a narrow, named boundary, not a
// PII allowlist: `GET /v1/spec`'s `Account.user` (a `User`) carries its own
// `phoneNumber`/`email`/`fullName`, and none of those are touched here — they
// deliberately survive into every caller of `getAccounts`/`getBridges`/
// `getJoinedAccounts`, because fork issue #10 (Tribe identity) needs
// `user.phoneNumber` from this same client. A caller that logs or persists a
// whole account/user row is still responsible for that PII itself.
function stripLoginId(account) {
  if (!account || typeof account !== 'object') return account;
  const { loginID, ...rest } = account;
  return rest;
}

// Also strips `activeAccountCount` — documented to over-report (requirement:
// do not surface it) — alongside the nested loginID strip, so a bridge row
// never carries either field past this boundary.
function stripBridgeAccountsLoginId(bridge) {
  if (!bridge || typeof bridge !== 'object') return bridge;
  const { activeAccountCount, ...rest } = bridge;
  return {
    ...rest,
    accounts: Array.isArray(bridge.accounts) ? bridge.accounts.map(stripLoginId) : bridge.accounts,
  };
}

/**
 * `GET /v1/accounts` — a BARE array, not a paginated envelope.
 *
 * Throws a typed `MALFORMED_RESPONSE` `BeeperApiError` when the body isn't an
 * array, instead of coercing to `[]` — the AGENTS.md "sentinel + validate"
 * rule (`lmStudioManager.getLastListError` is the named precedent): a 200 with
 * a non-JSON body becomes `{ message: text }` and a blank 200 becomes `{}` via
 * `readResponseJson`'s fallback, and both used to be indistinguishable from a
 * genuinely empty roster. With `settings.beeper.baseUrl` user-editable (#30),
 * any other local service answering 200 must surface as a fault here, not as
 * "no accounts connected".
 */
export async function getAccounts({ baseUrl, token, timeoutMs } = {}) {
  const raw = await beeperRequest('/v1/accounts', { baseUrl, token, timeoutMs, allowRetry: true });
  if (!Array.isArray(raw)) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/accounts response shape (expected an array)', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
  return raw.map(stripLoginId);
}

/**
 * `GET /v1/bridges` — `{ items: Bridge[] }`. Deliberately does not surface
 * `activeAccountCount` (documented to over-report; requirement: do not use it).
 *
 * Same "sentinel + validate" rule as `getAccounts` above: throws a typed
 * `MALFORMED_RESPONSE` `BeeperApiError` when `items` isn't an array, instead
 * of coercing a missing/invalid `items` to `[]`.
 */
export async function getBridges({ baseUrl, token, timeoutMs } = {}) {
  const raw = await beeperRequest('/v1/bridges', { baseUrl, token, timeoutMs, allowRetry: true });
  if (!Array.isArray(raw?.items)) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/bridges response shape (expected { items: [] })', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
  return { items: raw.items.map(stripBridgeAccountsLoginId) };
}

/**
 * Join accounts to their bridge by `accountID` through each bridge's nested
 * `accounts[]` — NOT by `network` (accounts carry a display name, bridges
 * carry a lowercase slug; that join returns zero rows). An account with no
 * matching bridge is kept, with bridge-derived fields `null`.
 *
 * `statusText` is taken from the bridge only — observed live (#11) to exist
 * only on `connected` bridge rows and never populated on the account itself,
 * even though the account schema allows the field.
 *
 * Pure — no I/O — so it's testable directly against a fixture without a
 * network mock. `getJoinedAccounts` is the I/O wrapper below.
 */
export function joinAccountsWithBridges(accounts, bridgesResponse) {
  const bridges = Array.isArray(bridgesResponse?.items) ? bridgesResponse.items : [];
  const bridgeByAccountId = new Map();
  for (const bridge of bridges) {
    for (const acct of Array.isArray(bridge?.accounts) ? bridge.accounts : []) {
      if (acct?.accountID) bridgeByAccountId.set(acct.accountID, bridge);
    }
  }
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const safeAccount = stripLoginId(account);
    const bridge = safeAccount?.accountID ? bridgeByAccountId.get(safeAccount.accountID) : null;
    return {
      ...safeAccount,
      network: safeAccount.network ?? bridge?.network ?? null,
      bridgeId: bridge?.id ?? null,
      bridgeStatus: bridge?.status ?? null,
      statusText: bridge?.statusText ?? null,
    };
  });
}

/** `getAccounts()` joined to `getBridges()` by `accountID`. */
export async function getJoinedAccounts({ baseUrl, token, timeoutMs } = {}) {
  const [accounts, bridges] = await Promise.all([
    getAccounts({ baseUrl, token, timeoutMs }),
    getBridges({ baseUrl, token, timeoutMs }),
  ]);
  return joinAccountsWithBridges(accounts, bridges);
}
