/**
 * Fork-head coordinates — where a cross-repository pull request's branch lives.
 *
 * A fork PR has no `origin/<headRefName>`; origin only exposes the read-only `refs/pull/<n>/head`,
 * so "work on this PR's branch" needs the fork's clone URL plus the owner login that names the
 * remote. Pure and fail-closed: anything that isn't a usable pair returns `null`, which callers read
 * as "no fork coordinates" and fall back to origin-only behavior.
 */

/**
 * Coerce forge-supplied (or metadata-round-tripped) coordinates into `{ remoteUrl, ownerLogin }`, or
 * `null`. Leading-`-` values are rejected: both reach a `git` argv and would parse as options.
 *
 * @param {unknown} value - candidate coordinates
 * @returns {{remoteUrl: string, ownerLogin: string}|null}
 */
export function normalizeForkHead(value) {
  if (!value || typeof value !== 'object') return null;
  const remoteUrl = typeof value.remoteUrl === 'string' ? value.remoteUrl.trim() : '';
  const ownerLogin = typeof value.ownerLogin === 'string' ? value.ownerLogin.trim() : '';
  if (!remoteUrl || !ownerLogin) return null;
  if (remoteUrl.startsWith('-') || ownerLogin.startsWith('-')) return null;
  return { remoteUrl, ownerLogin };
}

/**
 * Deterministic git remote name for a fork's owner (`fork-<login>`, null when nothing survives), so
 * re-runs reuse the remote. Characters outside git's safe remote-name set fold to `-`.
 *
 * @param {unknown} ownerLogin
 * @returns {string|null} e.g. `fork-contributor`, or null when nothing survives
 */
export function forkRemoteName(ownerLogin) {
  const slug = (typeof ownerLogin === 'string' ? ownerLogin : '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-.]+/, '');
  return slug ? `fork-${slug}` : null;
}

/**
 * A task's fork coordinates from its metadata. `forkHead` is deliberately generic: every producer of a
 * task aimed at an existing PR branch writes it. Re-validated on read since the tasks file may be hand-edited.
 *
 * @param {object} metadata - task metadata
 * @returns {{remoteUrl: string, ownerLogin: string}|null}
 */
export function resolveTaskForkHead(metadata) {
  return normalizeForkHead(metadata?.forkHead);
}

/**
 * Fork coordinates from a `gh pr view`/`gh pr list --json` row (needs `isCrossRepository`,
 * `headRepository`, `headRepositoryOwner`, `url`). `headRepository` has no clone URL, so it is composed
 * from the PR's OWN origin plus `nameWithOwner` (GitHub Enterprise stays correct). Same-repo head: null.
 *
 * @param {object} pr - a gh PR row
 * @returns {{remoteUrl: string, ownerLogin: string}|null}
 */
export function forkHeadFromGithubPr(pr) {
  if (pr?.isCrossRepository !== true) return null;
  const ownerLogin = typeof pr?.headRepositoryOwner?.login === 'string' ? pr.headRepositoryOwner.login.trim() : '';
  const repoName = typeof pr?.headRepository?.name === 'string' ? pr.headRepository.name.trim() : '';
  const nameWithOwner = typeof pr?.headRepository?.nameWithOwner === 'string' && pr.headRepository.nameWithOwner.trim()
    ? pr.headRepository.nameWithOwner.trim()
    : (ownerLogin && repoName ? `${ownerLogin}/${repoName}` : '');
  // Scheme+host of the PR URL, tolerating a value the forge omitted.
  const [, origin] = /^(https?:\/\/[^/]+)\//.exec(typeof pr?.url === 'string' ? pr.url : '') || [];
  if (!ownerLogin || !nameWithOwner || !origin) return null;
  return normalizeForkHead({ remoteUrl: `${origin}/${nameWithOwner}.git`, ownerLogin });
}

/** Keep a fork's checkout separate from same-named branches in the base repo. */
export function forkLocalBranch(branch, forkHead) {
  const coordinates = normalizeForkHead(forkHead);
  const remote = coordinates && forkRemoteName(coordinates.ownerLogin);
  return remote && branch ? `fork/${remote.slice(5)}/${branch}` : branch;
}
