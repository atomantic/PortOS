/**
 * Beeper status resolution for the Comms → Beeper status card (#30, fork
 * issue #1). Combines three things the card renders from:
 *   - whether a token is configured (never the token itself — this module
 *     resolves the vaulted credential store #31 through `resolveBeeperToken()`,
 *     which DOES decrypt, specifically so a vault whose ciphertext cannot be
 *     decrypted is noticed rather than reported as a healthy, connected
 *     install (audit cluster 04, finding 1) — but never reads the decrypted
 *     `token` field beyond the presence check itself);
 *   - a liveness probe against the local Beeper Desktop API;
 *   - the read-only account roster mirrored by fork issue #27's schema, so
 *     the card renders something even with Beeper Desktop closed (accounts
 *     survive from the last ingestion sweep, #32).
 *
 * Two flags stay distinct, per the fork issue #11 decision #30 carries
 * forward: the INSTANCE FEATURE (`instanceFeatureRegistry.js` `beeper`)
 * governs navigation; `settings.beeper.enabled` governs ingestion. This
 * module answers the connection/status question only.
 */
import { query } from '../lib/db.js';
import {
  probeBeeperInfo, getInfo, assertValidInfoResponse, BeeperApiError, resolveBeeperBaseUrl,
  hasRecentBeeperSuccess, RECENT_SUCCESS_WINDOW_MS,
} from './beeperClient.js';
import { getBeeperRealtimeState } from './beeperSocket.js';
import { getOutboxStatus } from './beeperOutbox.js';
import { resolveBeeperToken } from './beeperCredentials.js';
import { getBeeperSweepProgress } from './beeperSweepProgress.js';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

// Expiry rides beside the token in the vault (#11 decision 10 — "stored beside
// the token and displayed without a network call"). There is no refresh grant,
// so `tokenExpired` is an actionable RE-CONNECT state, deliberately distinct
// from `tokenExpiringSoon`; a pasted no-expiry token (`tokenExpiresAt: null`)
// triggers neither, which is exactly why that path exists.
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
 * The read-only account roster mirrored by fork issue #27's schema, so the
 * status card can render even with Beeper Desktop closed. Always an array —
 * an empty result is a trustworthy "no accounts synced yet", not a fault: the
 * ingestion sweep (#32) populates this table, so a fresh install sees `[]`
 * until its first sync pass completes.
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
 * Whether SOMETHING recently proved Beeper Desktop is actually up: a real API
 * call through `beeperClient.js`, or the realtime socket receiving a fresh
 * server ping (`beeperSocket.js`'s own ~10.5s-then-30s cadence). Fork issue
 * #61 decision 7 — paired with `RECENT_SUCCESS_WINDOW_MS` in `beeperClient.js`
 * so both signals share one window rather than each guessing its own.
 */
function hasRecentBeeperActivity() {
  if (hasRecentBeeperSuccess()) return true;
  const { lastPingAt } = getBeeperRealtimeState();
  if (!lastPingAt) return false;
  const pingedAt = new Date(lastPingAt).getTime();
  return Number.isFinite(pingedAt) && (Date.now() - pingedAt) <= RECENT_SUCCESS_WINDOW_MS;
}

/**
 * The full status payload the Comms → Beeper card renders from (#30). Never
 * throws — every sub-fetch degrades to its own "unknown" value so one failure
 * (a DB hiccup, Beeper Desktop closed) doesn't blank the whole card. Use
 * `checkBeeperConnection` below for an action that DOES throw a typed,
 * coded error (the card's "Retry" button on the unreachable state).
 *
 * `reachable` is a tri-state, never collapsed to a boolean: `true`/`false`
 * once probed, `null` when the probe was never attempted (no token
 * configured) — the absent-vs-empty sentinel from root AGENTS.md. `null`
 * must never render as offline; this function never lies and reports
 * `false` for a question it never asked. `probeState` ('ok' | 'slow' |
 * 'unreachable' | 'unknown') carries the finer-grained answer the card's
 * "slow" treatment reads from — see the timeout-vs-recent-success logic below.
 */
export async function getBeeperStatus() {
  // `resolveBeeperBaseUrl()`, never a raw `settings.beeper.baseUrl` read
  // (SEC-2): it re-applies the loopback-only gate `beeperSettingsSchema`
  // enforces on the PUT route, which a hand-edited `settings.json` can still
  // bypass on read. The probe and the payload's own `baseUrl` field both have
  // to report the SAME (validated) value the sweep and every other call
  // actually use.
  const resolvedBaseUrl = await resolveBeeperBaseUrl();
  // Deliberately NOT wrapped in a catch: an unreadable vault throws (#11
  // decision 8), and the card renders its "could not read status" branch
  // rather than telling a connected install to connect again. This has to be
  // `resolveBeeperToken()` (which decrypts the row), not a cheaper
  // presence-only read: a row whose ciphertext cannot be decrypted still has
  // a row, so a presence-only check can never notice a corrupt vault — which
  // is exactly how this used to report `tokenConfigured: true, reachable:
  // true` for a credential nobody could actually authenticate with. Never
  // reads `stored.token` beyond this line: only presence, source and expiry
  // ever reach the response below.
  const stored = await resolveBeeperToken();
  const credential = {
    tokenConfigured: Boolean(stored),
    tokenSource: stored?.tokenSource ?? null,
    tokenExpiresAt: stored?.tokenExpiresAt ?? null,
    // Granted scopes (fork issue #78) — an array of strings, `[]` when
    // unknown (a pasted token, or the legacy plaintext path). Read off
    // `resolveBeeperToken()` alongside source/expiry; never the token value.
    tokenScopes: Array.isArray(stored?.tokenScopes) ? stored.tokenScopes : [],
  };
  const expiry = tokenExpiryInfo(credential.tokenExpiresAt);

  const [probe, accountsResult] = await Promise.all([
    credential.tokenConfigured
      ? probeBeeperInfo({ baseUrl: resolvedBaseUrl })
      : Promise.resolve(null),
    listBeeperAccounts()
      .then((accounts) => ({ accounts, accountsError: null }))
      // A failed mirror read must not read as "no accounts mirrored yet" — that
      // is a legitimate, trustworthy empty result (see `listBeeperAccounts`
      // above), and a DB hiccup is not the same thing. `accounts: null` is the
      // absent-vs-empty sentinel: the card renders this as unknown, never as
      // zero accounts.
      .catch((err) => ({
        accounts: null,
        accountsError: err?.message || 'Could not read the mirrored account roster',
      })),
  ]);

  // Fork issue #61, decision 7. A probe TIMEOUT specifically (never a fast
  // refusal — `beeperClient.js` only sets `timedOut` on its own AbortController
  // firing) is ambiguous on its own: nothing distinguishes "briefly slow" from
  // "actually closed" by timing alone. Paired with something that recently
  // proved Beeper Desktop is up, it means "slow to answer this one bare check,"
  // not "gone" — `reachable` stays `true` and the card renders `slow` with the
  // latency instead of flipping to the unreachable/actionable-fault card. With
  // no recent activity (or for any other failure shape), a genuinely closed
  // Beeper Desktop still reaches `unreachable` on the very first probe — this
  // never delays that. `reachable: null` (no token, probe never attempted)
  // never reaches here at all, since `probe` is `null` in that case.
  let reachable = probe ? probe.reachable : null;
  let probeState = probe === null ? 'unknown' : (probe.reachable ? 'ok' : 'unreachable');
  if (probe && !probe.reachable && probe.timedOut && hasRecentBeeperActivity()) {
    reachable = true;
    probeState = 'slow';
  }

  return {
    tokenConfigured: credential.tokenConfigured,
    // 'oauth' | 'pasted' | 'legacy-settings' | null — provenance, never the
    // value.
    tokenSource: credential.tokenSource,
    // Fork issue #78: array of strings, `[]` when unknown (a pasted token
    // never carries scopes back from Beeper's own paste UI). Never the token
    // value itself — same provenance-only rule as `tokenSource` above.
    tokenScopes: credential.tokenScopes,
    baseUrl: resolvedBaseUrl,
    reachable,
    probeState,
    probeLatencyMs: probe?.latencyMs ?? null,
    lastProbeError: probe?.error ?? null,
    appVersion: probe?.info?.app?.version ?? null,
    ...expiry,
    // Transport liveness for the card's dot and its actionable-fault line
    // (#33): `connected | reconnecting | down`, plus the last frame and last
    // server ping. `appState` rides along because an actionable value
    // (`needs-login`, `needs-verification`, `needs-secrets`) is exactly what
    // the iMessage-shape card exists to surface — it is NEVER a gate, having
    // been measured reporting `initializing` for 105s on a working install.
    realtime: getBeeperRealtimeState(),
    // Outbound-send health (#36): the runaway breaker's state, and how many
    // sends are still awaiting confirmation. The breaker is the one fault here
    // that needs a human action, so it renders on the settings card the same
    // way an actionable transport fault does — never as a global banner.
    outbox: getOutboxStatus(),
    accounts: accountsResult.accounts,
    accountsError: accountsResult.accountsError,
    // Sweep visibility (#80): running/idle, started/finished, accounts done of
    // the total, chats and messages mirrored so far. Read from the standalone
    // `beeperSweepProgress.js` leaf module rather than `beeperSync.js` itself —
    // same reasoning as importing `beeperSocketEvents.js` instead of
    // `beeperSocket.js` above: a read-only status card has no business
    // dragging the whole sweep's DB/HTTP dependency graph in just to report a
    // few numbers.
    sweep: getBeeperSweepProgress(),
  };
}

/**
 * A live, uncached connectivity check — the card's "Retry" action on the
 * "token present, unreachable" state. Unlike `getBeeperStatus` (which always
 * resolves, via `probeBeeperInfo`'s own swallowed-error contract), this
 * THROWS a typed `BeeperApiError` so the route can map it to a real HTTP
 * status per fork-issue-#30-and-later's status-code contract instead of the
 * status route's flattened `lastProbeError` string.
 */
export async function checkBeeperConnection() {
  // Same reasoning as `getBeeperStatus()` above: `resolveBeeperToken()`
  // decrypts and so actually notices an unreadable vault, rather than reading
  // a row's mere presence and reporting a connected install as unconfigured.
  const stored = await resolveBeeperToken();
  if (!stored) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }
  // `resolveBeeperBaseUrl()`, never a raw `settings.beeper.baseUrl` read — see
  // the same note on `getBeeperStatus` above (SEC-2).
  const info = await getInfo({ baseUrl: await resolveBeeperBaseUrl() });
  assertValidInfoResponse(info);
  return { reachable: true, info };
}
