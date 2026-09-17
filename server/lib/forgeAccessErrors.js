/**
 * Tell a PERMANENT `gh` no-access failure apart from a transient one, and log it
 * at most once per scope+repo.
 *
 * `Could not resolve to a Repository` is GitHub's 404-for-no-access: the repo
 * exists, the credential in use cannot see it. That does not heal on its own the
 * way a network blip or a rate limit does — it stays broken until the credential
 * changes — so it must NOT ride `execGh`'s consecutive-failure backoff (which
 * caps at 15 minutes and then re-fires and re-logs forever), and the polling
 * jobs must not narrate it once per tick.
 *
 * Pure except for the process-lifetime de-dup set behind `logForgeNoAccessOnce`.
 * Once per process (rather than a re-log window) is deliberate: the remedy is a
 * credential change, which on this install means a `gh auth login` or an edit to
 * the app record — both user actions that carry their own feedback.
 */

// `gh pr list` / `gh repo view` answer a no-access repo through GraphQL, which
// reports it as an unresolvable node rather than an HTTP status; `gh api` and
// the REST-backed subcommands answer with the status line instead (gh's own
// "Not Found" phrasing carries it — `gh: Not Found (HTTP 404)`), so these two
// patterns cover both transports.
//
// Deliberately narrow. Widening the GraphQL arm to other node types would
// classify a deleted PR or a renamed user — an ordinary missing SUB-resource —
// as a credential problem and print a remedy that does not apply.
const NO_ACCESS_PATTERNS = [
  /could not resolve to a repository/i,
  /\bHTTP 404\b/i,
];

/**
 * True when `text` is `gh` stderr describing a no-access/404, not a transient
 * failure.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isForgeNoAccessMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return NO_ACCESS_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when an `execGh` rejection is a no-access/404. Prefers the `ghNoAccess`
 * flag `execGh` stamps on, and falls back to re-reading the stderr/message for a
 * caller that received the error through a wrapper that dropped the flag.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isForgeNoAccessError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.ghNoAccess === true) return true;
  return isForgeNoAccessMessage(err.ghStderr) || isForgeNoAccessMessage(err.message);
}

/**
 * The one actionable line a no-access repo gets. Names the fix rather than the
 * symptom: an owner-match against a locally logged-in account already covers the
 * common multi-account case, so what is left to say is "pin the account".
 * @param {string} repoSpec
 * @returns {string}
 */
export function forgeNoAccessRemedy(repoSpec) {
  return `${repoSpec} is not visible to the gh account PortOS resolved for it — `
    + 'log in to the owning account (`gh auth login`) or pin it on the app record\'s Forge account field';
}

const loggedNoAccess = new Set();

/**
 * Log a no-access failure ONCE per scope+repo for this process. Returns true
 * when it logged, so a caller can branch on "first time seen".
 * @param {string} scope - The polling job's log prefix, e.g. `branch-reconcile`
 * @param {string} repoSpec
 * @param {string} [detail] - gh's own message, appended when present
 * @returns {boolean}
 */
export function logForgeNoAccessOnce(scope, repoSpec, detail = '') {
  const key = `${scope} :: ${repoSpec}`;
  if (loggedNoAccess.has(key)) return false;
  loggedNoAccess.add(key);
  const because = detail ? ` (${String(detail).split('\n')[0].slice(0, 160)})` : '';
  console.error(`❌ ${scope}: ${forgeNoAccessRemedy(repoSpec)}${because}`);
  return true;
}

/** Test seam — drops the once-per-process de-dup set between runs. */
export function __resetForgeNoAccessLog() {
  loggedNoAccess.clear();
}
