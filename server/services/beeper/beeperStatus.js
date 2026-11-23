/**
 * Beeper status resolution for the Comms → Beeper status card. Combines:
 *   - whether a token is configured (never the token itself; `resolveBeeperToken()`
 *     DOES decrypt so an undecryptable vault is noticed rather than reported as
 *     connected, but the `token` field is never read beyond the presence check);
 *   - a liveness probe against the local Beeper Desktop API;
 *   - the account roster mirrored by the last ingestion sweep, so the card
 *     renders even with Beeper Desktop closed.
 *
 * The INSTANCE FEATURE (`instanceFeatureRegistry.js` `beeper`) governs
 * navigation; `settings.beeper.enabled` governs ingestion. This module answers
 * the connection/status question only.
 */
import { query } from '../../lib/db.js';
import {
  probeBeeperInfo, getInfo, assertValidInfoResponse, BeeperApiError, resolveBeeperBaseUrl,
  hasRecentBeeperSuccess, RECENT_SUCCESS_WINDOW_MS,
} from './beeperClient.js';
import { getBeeperRealtimeState } from './beeperSocket.js';
import { getOutboxStatus } from './beeperOutbox.js';
import { resolveBeeperToken } from './beeperCredentials.js';
import { getBeeperSweepProgress } from './beeperSweepProgress.js';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

// Expiry rides beside the token in the vault, shown without a network call. No
// refresh grant exists, so `tokenExpired` is an actionable RE-CONNECT state distinct
// from `tokenExpiringSoon`; a no-expiry pasted token triggers neither.
function tokenExpiryInfo(tokenExpiresAt) {
  if (typeof tokenExpiresAt !== 'string' || !tokenExpiresAt) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false, tokenExpired: false };
  }
  const expires = new Date(tokenExpiresAt);
  if (Number.isNaN(expires.getTime())) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false, tokenExpired: false };
  }
  const remainingMs = expires.getTime() - Date.now();
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return {
    tokenExpiresAt,
    tokenExpiresInDays: days,
    tokenExpiringSoon: days <= TOKEN_EXPIRY_WARNING_DAYS,
    tokenExpired: remainingMs <= 0,
  };
}

/**
 * The mirrored account roster. Always an array; empty is a trustworthy "no
 * accounts synced yet" (the ingestion sweep populates the table), not a fault.
 */
export async function listBeeperAccounts() {
  const result = await query(
    `SELECT account_id AS "accountId", network, display_name AS "displayName",
            status, bridge_id AS "bridgeId", last_seen_at AS "lastSeenAt"
     FROM beeper_accounts
     ORDER BY display_name ASC, account_id ASC`,
  );
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Whether something recently proved Beeper Desktop is up: a real API call
 * through `beeperClient.js`, or a fresh realtime-socket server ping. Both share
 * `RECENT_SUCCESS_WINDOW_MS`.
 */
function hasRecentBeeperActivity() {
  if (hasRecentBeeperSuccess()) return true;
  const { lastPingAt } = getBeeperRealtimeState();
  if (!lastPingAt) return false;
  const pingedAt = new Date(lastPingAt).getTime();
  return Number.isFinite(pingedAt) && (Date.now() - pingedAt) <= RECENT_SUCCESS_WINDOW_MS;
}

/**
 * The full status payload the Comms → Beeper card renders from. Never throws
 * (except an unreadable vault, see below): each sub-fetch degrades to its own
 * "unknown" value. `checkBeeperConnection` is the variant that throws a typed error.
 *
 * `reachable` is a tri-state: `true`/`false` once probed, `null` when never
 * attempted (no token). `null` must never render as offline. `probeState`
 * ('ok' | 'slow' | 'unreachable' | 'unknown') carries the finer answer.
 */
export async function getBeeperStatus() {
  // `resolveBeeperBaseUrl()`, never a raw settings read: it re-applies the
  // loopback-only gate that a hand-edited `settings.json` can bypass.
  const resolvedBaseUrl = await resolveBeeperBaseUrl();
  // Deliberately NOT caught: an unreadable vault throws and the card renders its
  // "could not read status" branch. It must be `resolveBeeperToken()` (decrypts),
  // not a presence-only read, which can never notice a corrupt vault. Only
  // presence, source and expiry ever reach the response.
  const stored = await resolveBeeperToken();
  const credential = {
    tokenConfigured: Boolean(stored),
    tokenSource: stored?.tokenSource ?? null,
    tokenExpiresAt: stored?.tokenExpiresAt ?? null,
    // `[]` when unknown (pasted token, legacy plaintext path).
    tokenScopes: Array.isArray(stored?.tokenScopes) ? stored.tokenScopes : [],
  };
  const expiry = tokenExpiryInfo(credential.tokenExpiresAt);

  const [probe, accountsResult] = await Promise.all([
    credential.tokenConfigured
      ? probeBeeperInfo({ baseUrl: resolvedBaseUrl })
      : Promise.resolve(null),
    listBeeperAccounts()
      .then((accounts) => ({ accounts, accountsError: null }))
      // A failed read is not "no accounts yet": `accounts: null` renders as unknown.
      .catch((err) => ({
        accounts: null,
        accountsError: err?.message || 'Could not read the mirrored account roster',
      })),
  ]);

  // A probe TIMEOUT (never a fast refusal; `timedOut` is set only by the client's
  // own AbortController) is ambiguous alone. Paired with recent proof Beeper Desktop
  // is up it means "slow", so `reachable` stays `true` and the card renders `slow`.
  // Without recent activity, or for any other failure, `unreachable` still shows
  // on the first probe.
  let reachable = probe ? probe.reachable : null;
  let probeState = probe === null ? 'unknown' : (probe.reachable ? 'ok' : 'unreachable');
  if (probe && !probe.reachable && probe.timedOut && hasRecentBeeperActivity()) {
    reachable = true;
    probeState = 'slow';
  }

  return {
    tokenConfigured: credential.tokenConfigured,
    // 'oauth' | 'pasted' | 'legacy-settings' | null — provenance, never the value.
    tokenSource: credential.tokenSource,
    tokenScopes: credential.tokenScopes,
    baseUrl: resolvedBaseUrl,
    reachable,
    probeState,
    probeLatencyMs: probe?.latencyMs ?? null,
    lastProbeError: probe?.error ?? null,
    appVersion: probe?.info?.app?.version ?? null,
    ...expiry,
    // Transport liveness (`connected | reconnecting | down`). `appState` rides
    // along to surface actionable values (`needs-login`...) but is NEVER a gate:
    // it was measured reporting `initializing` for 105s on a working install.
    realtime: getBeeperRealtimeState(),
    // Runaway-breaker state and unconfirmed sends; the breaker needs a human, so
    // it renders on the settings card, never as a global banner.
    outbox: getOutboxStatus(),
    accounts: accountsResult.accounts,
    accountsError: accountsResult.accountsError,
    // Read from the leaf `beeperSweepProgress.js`, not `beeperSync.js`, to avoid
    // pulling the sweep's DB/HTTP dependency graph into a status read.
    sweep: getBeeperSweepProgress(),
  };
}

/**
 * A live, uncached connectivity check (the card's "Retry"). Unlike
 * `getBeeperStatus`, this THROWS a typed `BeeperApiError` so the route can map
 * it to a real HTTP status.
 */
export async function checkBeeperConnection() {
  // `resolveBeeperToken()` decrypts, so an unreadable vault is noticed.
  const stored = await resolveBeeperToken();
  if (!stored) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }
  const info = await getInfo({ baseUrl: await resolveBeeperBaseUrl() });
  assertValidInfoResponse(info);
  return { reachable: true, info };
}
