/**
 * The ChatGPT-subscription half of the Codex providers, as PortOS models it.
 *
 * PortOS already ships `codex` (CLI) and `codex-tui` provider records, and
 * `providerPrerequisites.js` can tell you whether the `codex` binary is on
 * PATH. That is only half of "can this provider run": Codex authenticates
 * against a ChatGPT subscription (or an API key, or Bedrock), and until now
 * nothing in PortOS could say whether that sign-in exists, which plan backs it,
 * whether it has expired, or whether the subscription's usage window is spent.
 * The user found out inside a failed agent transcript.
 *
 * OpenAI's documented Codex **app-server** owns that lifecycle, so this is the
 * clean-room boundary PortOS consumes: `account/read` is the source of truth
 * and `account/login/start` runs the browser flow. PortOS never reads, copies,
 * returns, logs, or persists `~/.codex/auth.json`, an access token, or a
 * refresh token — Codex keeps its own credentials and refreshes them itself.
 *
 * This module is the PURE half: constants, protocol-payload normalization, the
 * redactor every log/error path runs through, and the readiness state machine.
 * The process/JSON-RPC half is `services/codexAppServer.js`.
 *
 * **SENTINEL DISCIPLINE** (AGENTS.md). Three different "nothing here" answers
 * must never collapse into each other:
 *
 *   - `runtimeInstalled: null` — NOT PROBED. Never reads as "the binary is
 *     missing".
 *   - `accountFetched: false` — `account/read` has not answered. Never reads as
 *     SIGNED OUT; that is a claim only a successful read may make.
 *   - `rateLimits: null` — the quota read failed or never ran, which is NOT the
 *     same as a successful read that legitimately reported no active window.
 *     An empty-but-fetched answer normalizes to an object, so a subscription
 *     with no limit window in flight is never mistaken for a broken fetch.
 */

import { commandBasename } from './providerModels.js';

/**
 * The one invocation PortOS is allowed to spawn. Fixed argv, never assembled
 * from a provider record or a request: the app-server is a protocol endpoint,
 * not a user-configurable command line, and a config write must not be able to
 * choose the exec target.
 */
export const CODEX_APP_SERVER_COMMAND = 'codex';
export const CODEX_APP_SERVER_ARGS = Object.freeze(['app-server']);

/** JSON-RPC methods this phase speaks. Read-only plus the explicit auth verbs. */
export const CODEX_RPC = Object.freeze({
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  rateLimitsRead: 'account/rateLimits/read',
  loginStart: 'account/login/start',
  loginCancel: 'account/login/cancel',
  logout: 'account/logout',
});

/** Server-to-client notifications that invalidate PortOS's cached readiness. */
export const CODEX_NOTIFICATIONS = Object.freeze({
  accountUpdated: 'account/updated',
  rateLimitsUpdated: 'account/rateLimits/updated',
  loginCompleted: 'account/login/completed',
});

/**
 * Every state the Providers page has to be able to paint differently, because
 * each one has a different fix. `unknown` is deliberately its own state rather
 * than a pessimistic `signedOut`: telling a signed-in user to sign in again
 * because a probe failed is worse than saying PortOS could not tell.
 */
export const CODEX_ACCOUNT_STATUS = Object.freeze({
  runtimeMissing: 'runtime-missing',
  unknown: 'unknown',
  signedOut: 'signed-out',
  loginPending: 'login-pending',
  ready: 'ready',
  quotaExhausted: 'quota-exhausted',
  reauthRequired: 'reauth-required',
});

/** Typed failures the routes and the client both branch on. */
export const CODEX_ERROR_CODES = Object.freeze({
  runtimeMissing: 'CODEX_RUNTIME_MISSING',
  startFailed: 'CODEX_APP_SERVER_START_FAILED',
  exited: 'CODEX_APP_SERVER_EXITED',
  timeout: 'CODEX_APP_SERVER_TIMEOUT',
  protocol: 'CODEX_APP_SERVER_PROTOCOL_ERROR',
  authRevoked: 'CODEX_AUTH_REVOKED',
  loginTimeout: 'CODEX_LOGIN_TIMEOUT',
  loginCancelled: 'CODEX_LOGIN_CANCELLED',
  loginFailed: 'CODEX_LOGIN_FAILED',
  unknownLogin: 'CODEX_UNKNOWN_LOGIN',
});

/**
 * Which provider records this account state belongs to.
 *
 * Keyed on the COMMAND, not the id: a user who cloned `codex` into
 * `codex-review` still runs the same binary against the same ChatGPT sign-in,
 * and hard-coding two ids would leave that card blank. API providers are
 * excluded — an OpenAI API-key provider authenticates with its own stored key
 * and has nothing to do with a subscription.
 */
export const isCodexSubscriptionProvider = (provider) => {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return false;
  const command = typeof provider?.command === 'string' ? provider.command.trim() : '';
  if (command === '') return false;
  return commandBasename(command) === CODEX_APP_SERVER_COMMAND;
};

/**
 * Keys whose VALUES may carry a credential. Matched case-insensitively as a
 * substring so a field PortOS has never seen (`chatgptAuthTokens`,
 * `refresh_token`, `clientSecret`) is redacted the first time it appears rather
 * than the first time someone notices it in a log.
 */
const SECRET_KEY_RE = /(token|secret|password|credential|apikey|api_key|accesskey|authorization|bearer|cookie|codeverifier|code_verifier)/i;
const REDACTED = '[redacted]';
const MAX_REDACT_DEPTH = 6;

/**
 * A copy of `value` safe to put in a log line, an error `context`, or an HTTP
 * response: every credential-shaped key replaced, strings clamped, recursion
 * bounded.
 *
 * Applied to protocol payloads on BOTH directions before anything is written
 * anywhere, so "we never log a token" is a property of one function rather than
 * a rule every call site has to remember.
 */
export const redactCodexPayload = (value, depth = 0) => {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactCodexPayload(entry, depth + 1));
  if (typeof value !== 'object') return REDACTED;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SECRET_KEY_RE.test(key) ? REDACTED : redactCodexPayload(entry, depth + 1),
  ]));
};

/**
 * A free-text protocol message with any credential-shaped substring masked, or
 * `null` when there is nothing to say.
 *
 * The payload redactor keys on FIELD NAMES; an upstream failure quoted into a
 * `message` string has no field names to key on ("access_token=… expired",
 * "Authorization: Bearer …"). These messages are both logged AND returned to the
 * browser by the `/codex/*` routes, so they need their own scrub.
 */
export const redactCodexMessage = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  // Clamped BEFORE the patterns run, so the scan is bounded by a constant no
  // matter what an upstream error decides to quote at us.
  const clamped = value.length > 400 ? `${value.slice(0, 400)}…` : value;
  return clamped
    // `key=<value>` / `key: <value>` where the key is credential-shaped and the
    // value is long enough to BE one. The length floor is what keeps "The secret:
    // sauce" intact while masking "refresh_token: eyJhbGciOi…" — and it is the
    // only exemption, because a long all-letters value after such a key is a
    // passphrase, not a sentence. The value class runs to the next whitespace or
    // quote so a trailing "!" cannot leave half a secret behind.
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|cookie|signature)[A-Za-z0-9_-]*)(\s*[=:]\s*)("?)([^\s"']{12,})\3?/gi,
      `$1$2${REDACTED}`,
    )
    // An inline authorization credential under ANY scheme — Bearer, Basic,
    // Token, and whatever a future provider invents. Anchored on the header
    // name, so an ordinary sentence containing "token" is untouched.
    .replace(/\b(authorization|proxy-authorization)(\s*[=:]\s*)(\S+\s+)?\S+/gi, `$1$2${REDACTED}`)
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`)
    // A bare vendor key, which carries no label at all to key on.
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9._-]{8,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9._-]{16,}/g, REDACTED);
};

const trimmedString = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * The non-secret shape of `account/read`.
 *
 * Returns `null` for a successful read that found no account — the ONE input
 * from which "signed out" may be concluded. A response PortOS cannot understand
 * is not that, so it throws rather than inventing a signed-out verdict; the
 * caller turns that into `unknown`.
 *
 * Only three fields survive: how Codex authenticates, which plan backs it, and
 * whether the credentials are Codex-managed. No id, no email, no token — the
 * page needs "is this ready and on which plan", not who the user is.
 */
export const normalizeCodexAccount = (result) => {
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') throw new Error('account/read returned a non-object result');
  // The documented envelope nests the record; tolerate a bare record too, since
  // an install may be running a Codex older or newer than the one studied.
  const raw = ('account' in result) ? result.account : result;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('account/read returned a non-object account');
  const authMethod = trimmedString(raw.type) || trimmedString(raw.authMethod);
  if (!authMethod) throw new Error('account/read returned an account with no auth method');
  return {
    authMethod,
    planType: trimmedString(raw.planType) || trimmedString(raw.chatgptPlanType),
    usesCodexManagedCredentials: raw.usesCodexManagedCredentials === true,
  };
};

/** One rate-limit window, or `null` when the payload has nothing usable in it. */
const normalizeWindow = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = typeof raw.usedPercent === 'number' && Number.isFinite(raw.usedPercent)
    ? raw.usedPercent
    : null;
  const windowDurationMins = typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins)
    ? raw.windowDurationMins
    : null;
  const resetsAt = trimmedString(raw.resetsAt);
  const limitName = trimmedString(raw.limitName);
  if (usedPercent === null && windowDurationMins === null && resetsAt === null) return null;
  return { usedPercent, windowDurationMins, resetsAt, limitName };
};

/**
 * The non-secret shape of `account/rateLimits/read`.
 *
 * Throws for a response that isn't an object, so a FAILED read stays `null` at
 * the call site. A successful read with no active window returns an object
 * whose windows are `null` — "fetched, and there is nothing to report" is a
 * real answer and must not be re-labelled as a failed fetch (AGENTS.md).
 */
export const normalizeCodexRateLimits = (result) => {
  if (result === null || result === undefined) throw new Error('rate limits read returned nothing');
  if (typeof result !== 'object') throw new Error('rate limits read returned a non-object result');
  const raw = result.rateLimits ?? result.codexRateLimits ?? result;
  const source = (raw && typeof raw === 'object') ? raw : {};
  const credits = (source.credits && typeof source.credits === 'object')
    ? { hasCredits: source.credits.hasCredits === true, unlimited: source.credits.unlimited === true }
    : null;
  return {
    primary: normalizeWindow(source.primary),
    secondary: normalizeWindow(source.secondary),
    credits,
  };
};

/**
 * Is the subscription's usage window spent?
 *
 * `null` (not fetched) is NOT exhausted — an unread quota may never take a
 * working provider off the page. Only a window that reports itself at or past
 * 100% counts.
 */
export const codexRateLimitsExhausted = (rateLimits) => {
  if (!rateLimits || typeof rateLimits !== 'object') return false;
  return [rateLimits.primary, rateLimits.secondary]
    .some((window) => typeof window?.usedPercent === 'number' && window.usedPercent >= 100);
};

/**
 * What `account/login/start` gives the browser, and nothing else.
 *
 * Both documented shapes are accepted: `authUrl` for the browser flow and
 * `verificationUrl` (+ a short user code) for the device-code flow. Everything
 * else in the response — including any token material a future Codex might add
 * — is dropped here rather than filtered downstream.
 *
 * Throws when there is no `loginId`: without it the login cannot be cancelled
 * or correlated with its completion notification, so returning a URL the user
 * could open would strand them in a flow PortOS can no longer settle.
 */
export const normalizeCodexLoginStart = (result) => {
  if (!result || typeof result !== 'object') throw new Error('login start returned a non-object result');
  const loginId = trimmedString(result.loginId);
  if (!loginId) throw new Error('login start returned no loginId');
  const httpsUrl = (value) => {
    const url = trimmedString(value);
    return url && URL.canParse(url) && new URL(url).protocol === 'https:' ? url : null;
  };
  const authUrl = httpsUrl(result.authUrl);
  const verificationUrl = httpsUrl(result.verificationUrl);
  if (!authUrl && !verificationUrl) throw new Error('login start returned no sign-in URL');
  return {
    loginId,
    authUrl,
    verificationUrl,
    userCode: trimmedString(result.userCode),
  };
};

/**
 * Does this protocol error mean the stored ChatGPT sign-in is gone (revoked,
 * expired, withdrawn from the workspace) rather than merely unreachable?
 *
 * Matched on the message because the app-server surfaces the upstream 401 as
 * free text; a false negative degrades to `unknown`, which is the safe side.
 */
export const isCodexAuthError = (error) => {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /\b(401|unauthorized|unauthenticated|invalid[_ -]?grant|token (?:expired|revoked)|re-?authenticate)\b/i
    .test(message);
};

/**
 * The whole state machine, in one pure function.
 *
 * @param {object} input
 * @param {boolean|null} input.runtimeInstalled — `null` = NOT PROBED
 * @param {boolean} input.accountFetched — did `account/read` actually answer?
 * @param {object|null} input.account — normalized account; `null` only means
 *   signed out when `accountFetched` is true
 * @param {object|null} input.rateLimits — `null` = NOT FETCHED
 * @param {boolean} input.loginPending — a PortOS-initiated login is in flight
 * @param {{code: string, message: string}|null} input.error
 * @returns {string} one of {@link CODEX_ACCOUNT_STATUS}
 */
export const deriveCodexAccountStatus = ({
  runtimeInstalled = null,
  accountFetched = false,
  account = null,
  rateLimits = null,
  loginPending = false,
  error = null,
} = {}) => {
  if (runtimeInstalled === false) return CODEX_ACCOUNT_STATUS.runtimeMissing;
  if (error?.code === CODEX_ERROR_CODES.authRevoked) return CODEX_ACCOUNT_STATUS.reauthRequired;
  if (!accountFetched) {
    return (!error && loginPending) ? CODEX_ACCOUNT_STATUS.loginPending : CODEX_ACCOUNT_STATUS.unknown;
  }
  if (!account) return loginPending ? CODEX_ACCOUNT_STATUS.loginPending : CODEX_ACCOUNT_STATUS.signedOut;
  if (codexRateLimitsExhausted(rateLimits)) return CODEX_ACCOUNT_STATUS.quotaExhausted;
  return CODEX_ACCOUNT_STATUS.ready;
};

/** One line for the card and the run log, per status. */
export const describeCodexAccountStatus = (status, account = null) => {
  switch (status) {
    case CODEX_ACCOUNT_STATUS.runtimeMissing: return 'Codex CLI is not installed';
    case CODEX_ACCOUNT_STATUS.signedOut: return 'No ChatGPT account is signed in';
    case CODEX_ACCOUNT_STATUS.loginPending: return 'Waiting for the ChatGPT sign-in to finish';
    case CODEX_ACCOUNT_STATUS.reauthRequired: return 'ChatGPT sign-in has expired — sign in again';
    case CODEX_ACCOUNT_STATUS.quotaExhausted: return 'ChatGPT usage limit reached for this window';
    case CODEX_ACCOUNT_STATUS.ready:
      return account?.planType ? `Signed in on the ${account.planType} plan` : 'Signed in';
    default: return 'Codex account state is unknown';
  }
};
