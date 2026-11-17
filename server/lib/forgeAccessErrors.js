/**
 * Tell a PERMANENT `gh` no-access failure apart from a transient one, and log it at most once per scope+repo.
 *
 * `Could not resolve to a Repository` is GitHub's 404-for-no-access: it only heals when the credential changes, so
 * it must NOT ride `execGh`'s consecutive-failure backoff, and polling jobs must not narrate it each tick. Pure
 * except for the process-lifetime de-dup set behind `logForgeNoAccessOnce` (once per process is deliberate: the
 * remedy is a user action with its own feedback).
 */

// `gh pr list` / `gh repo view` report no-access through GraphQL as an unresolvable node; `gh api`
// and REST-backed subcommands report the status line (`gh: Not Found (HTTP 404)`). Deliberately
// narrow: widening the GraphQL arm would classify a deleted PR or renamed user as a credential problem.
const NO_ACCESS_PATTERNS = [
  /could not resolve to a repository/i,
  /\bHTTP 404\b/i,
];

/**
 * True when `text` is `gh` stderr describing a no-access/404, not a transient failure.
 *
 * @param {string|null|undefined} text
 */
export function isForgeNoAccessMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return NO_ACCESS_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when an `execGh` rejection is a no-access/404; prefers the `ghNoAccess` flag, else re-reads stderr/message.
 *
 * @param {unknown} err
 */
export function isForgeNoAccessError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.ghNoAccess === true) return true;
  return isForgeNoAccessMessage(err.ghStderr) || isForgeNoAccessMessage(err.message);
}

/**
 * The one actionable line a no-access repo gets; names the fix (pin the account).
 *
 * @param {string} repoSpec
 */
export function forgeNoAccessRemedy(repoSpec) {
  return `${repoSpec} is not visible to the gh account PortOS resolved for it — `
    + 'log in to the owning account (`gh auth login`) or pin it on the app record\'s Forge account field';
}

// A credential that REACHES the repo but lacks an OAuth scope: permanent until it changes, so
// `execGh` keeps it out of the backoff too. GitHub phrases it per transport (GraphQL "without `workflow`
// scope", REST "needs the \"gist\" scope", gh preflight "missing required scopes [workflow]").
// Deliberately NOT "Resource not accessible by integration": an App-token grant no scope refresh fixes.
const MISSING_SCOPE_PATTERNS = [
  /without [`'"]?([\w:.-]+)[`'"]? scope/i,
  /needs? the [`'"]?([\w:.-]+)[`'"]? scope/i,
  /missing required scopes? \[([^\]]+)\]/i,
  /requires one of the following scopes: \[([^\]]+)\]/i,
];
const SCOPE_NAME = /^[a-z][a-z0-9:_.-]*$/i;

/**
 * Scope names a `gh` failure says the token lacks, [] if none; validated since they reach a displayed command and spawn argument.
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function parseForgeMissingScopes(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  for (const pattern of MISSING_SCOPE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const scopes = match[1].split(',').map((scope) => scope.replace(/['"`\s]/g, '')).filter((scope) => SCOPE_NAME.test(scope));
    if (scopes.length > 0) return [...new Set(scopes)];
  }
  return [];
}

/**
 * Whether the refusal names a PAT: `gh auth refresh` only re-scopes OAuth tokens, a PAT must be reissued.
 *
 * @param {string|null|undefined} text
 */
export const isForgePersonalTokenRefusal = (text) => typeof text === 'string' && /personal access token/i.test(text);

/**
 * Scopes a missing-scope `execGh` rejection names; prefers `ghMissingScopes`, else re-reads stderr/message.
 *
 * @param {unknown} err
 * @returns {string[]}
 */
export function forgeMissingScopesOf(err) {
  if (!err || typeof err !== 'object') return [];
  if (Array.isArray(err.ghMissingScopes) && err.ghMissingScopes.length > 0) return err.ghMissingScopes;
  const fromStderr = parseForgeMissingScopes(err.ghStderr);
  return fromStderr.length > 0 ? fromStderr : parseForgeMissingScopes(err.message);
}

/** Scopes the one-click refresh may request: a closed set of ordinary working scopes (never `admin:*` or `delete_repo`) since the user approves whatever is named; others still get the printed command. */
export const REFRESHABLE_FORGE_SCOPES = Object.freeze([
  'repo', 'workflow', 'read:org', 'gist', 'project', 'read:project',
  'read:packages', 'write:packages', 'notifications', 'read:user', 'user:email',
]);

/**
 * The command that fixes a missing scope by hand.
 * @param {string} host - forge host, e.g. `github.com` or an enterprise host
 * @param {string[]} scopes
 * @returns {string}
 */
export function forgeScopeRefreshCommand(host, scopes) {
  return `gh auth refresh -h ${host} -s ${scopes.join(',')}`;
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
