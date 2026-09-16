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

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

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
  const parsed = URL.parse(raw);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password
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
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} token
 * @param {{method?: string, timeoutMs?: number}} [options]
 * @returns {Promise<Response>}
 */
export function githubRequest(fetchImpl, url, token, { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}) {
  return fetchImpl(url, {
    ...init,
    headers: {
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
