/**
 * Shared GitHub Actions REST plumbing for the CI gates in `scripts/`.
 *
 * Extracted because two scripts now talk to the Actions API from inside a
 * workflow — `cancel-current-ci-run.js` and `ci-retry-cancelled-run.js` — and
 * the piece they share is a SECURITY check, not boilerplate: `resolveApiBase`
 * decides which host a step-scoped `GITHUB_TOKEN` is sent to. Two copies of
 * that meant a hardening fix could land on one and silently miss the other.
 *
 * ZERO external dependencies — see githubOutput.js.
 */

export const GITHUB_API_VERSION = '2022-11-28';
const PUBLIC_API_BASE = 'https://api.github.com';
/** `owner/repo`, rejecting anything with a slash or whitespace in a segment. */
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Lowercased: HTTP header names are case-insensitive and `fetch` folds them. */
const FIXED_HEADER_NAMES = new Set(['accept', 'authorization', 'x-github-api-version']);

/** `String#trim` that tolerates a missing or non-string env value. */
export const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The API origin to send the token to, or null to send it nowhere.
 *
 * An unset `GITHUB_API_URL` means github.com. A set one must be a plain
 * https origin: no embedded credentials (which would travel in the request
 * line), and no query or fragment (which would be silently dropped once a
 * path is appended, so the caller would not be talking to the URL it read).
 *
 * @param {string} [configuredApiUrl] - raw `GITHUB_API_URL`
 * @returns {string|null} base with no trailing slash
 */
export function resolveApiBase(configuredApiUrl) {
  const raw = trimmed(configuredApiUrl);
  if (!raw) return PUBLIC_API_BASE;
  // `new URL` in try/catch rather than the tidier `URL.parse`: that landed in
  // Node 22.1, and the recovery workflow deliberately runs on the runner image's
  // DEFAULT node with no setup-node. A TypeError here would take out every
  // recovery run on an older image instead of returning null.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * `<base>/repos/<owner>/<repo>` from the Actions environment, or null.
 *
 * The repository is read only from `GITHUB_REPOSITORY`; no caller passes a
 * target in, so a pull request cannot redirect a request at another repo.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function repoApiPath(env) {
  const repository = trimmed(env.GITHUB_REPOSITORY);
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  const apiBase = resolveApiBase(env.GITHUB_API_URL);
  if (!apiBase) return null;
  const [owner, repo] = repository.split('/');
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * One authenticated Actions API call with the standard headers and a timeout.
 *
 * A caller may add headers (a POST body needs its `Content-Type`), but never one
 * of the three fixed ones: this helper decides which host the token is sent to,
 * and a caller that could rewrite `Authorization` would take that decision back
 * out of here. Dropping them is case-INSENSITIVE, because `fetch` folds
 * `authorization` and `Authorization` into one comma-joined value — filtering
 * only the exact spelling would let a caller append to the header instead.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} token
 * @param {{method?: string, timeoutMs?: number, headers?: Record<string, string>}} [options]
 * @returns {Promise<Response>}
 */
export function githubRequest(fetchImpl, url, token, { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...init } = {}) {
  const callerHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !FIXED_HEADER_NAMES.has(name.toLowerCase())),
  );
  return fetchImpl(url, {
    ...init,
    headers: {
      ...callerHeaders,
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * True for a 2xx response.
 *
 * Belt and braces: a real `Response` sets `ok` from the status, but these
 * callers inject `fetchImpl`, so a stub that reports only one of the two
 * still reads correctly.
 *
 * @param {{status?: number, ok?: boolean}} [response]
 */
export function isSuccess(response) {
  const status = Number(response?.status) || 0;
  return (status >= 200 && status < 300) || response?.ok === true;
}
