/**
 * Fork-head coordinates — where a cross-repository pull request's branch lives.
 *
 * A PR opened from a fork has no `origin/<headRefName>`: the branch is in the
 * contributor's repository, and the forge only exposes its tip on origin as the
 * read-only `refs/pull/<n>/head`, which nothing can push back to. Every PortOS
 * path that means "work on this PR's branch" therefore needs a second address
 * for it — the fork's clone URL plus the owner whose login names the remote.
 *
 * This module is that address, as a validated value object, so the four places
 * that touch it agree on one shape: the forge read that produces it
 * (`appPullRequests.js`), the task metadata that persists it
 * (`agentWorktreeCleanup.js`, `prRemediationFollowUp.js`), the spawn path that
 * threads it (`agentWorkspacePrep.js`), and the git layer that consumes it
 * (`worktreeManager.js`, which deliberately has no forge client of its own).
 *
 * Pure and fail-closed: anything that isn't a usable pair returns `null`, which
 * every caller reads as "no fork coordinates" and falls back to its existing
 * origin-only behavior rather than guessing.
 */

/**
 * Coerce forge-supplied (or metadata-round-tripped) fork coordinates into the
 * canonical `{ remoteUrl, ownerLogin }` pair, or `null` when they are unusable.
 *
 * The leading-`-` rejection is not cosmetic: both values reach a `git` argv, and
 * a value starting with `-` would be parsed as an option rather than as a URL or
 * a name.
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
 * The deterministic git remote name for a fork's owner.
 *
 * Deterministic so a re-run (a second review round, a retried remediation)
 * reuses the remote it already added instead of accumulating one per attach —
 * and so teardown can leave it in place, which is what makes the reuse free.
 *
 * Forge logins are conventionally `[A-Za-z0-9-]`, but the value arrives from a
 * forge read, so anything outside git's safe remote-name set is folded to `-`.
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
 * Read a task's fork coordinates out of its metadata.
 *
 * The key is deliberately generic (`forkHead`, not a review-loop-specific
 * name): both producers of a task pointed at a pre-existing PR branch — the
 * review-loop follow-up and the public-PR remediation agent — write it, and
 * `agentWorkspacePrep` is the single reader that threads it into
 * `createWorktree`. Naming it in one place is what keeps them from drifting,
 * the same job `resolveTaskTargetBranch` does for the branch name itself.
 *
 * Re-validates on read because task metadata round-trips through the tasks
 * markdown file, which a human may edit.
 *
 * @param {object} metadata - task metadata
 * @returns {{remoteUrl: string, ownerLogin: string}|null}
 */
export function resolveTaskForkHead(metadata) {
  return normalizeForkHead(metadata?.forkHead);
}

/**
 * Read fork coordinates off a `gh pr view`/`gh pr list --json` row.
 *
 * `gh pr view --json headRepository` answers `{id, name, nameWithOwner}` — it
 * carries no clone URL — so the remote URL is composed from the PR's OWN origin
 * plus `nameWithOwner`. That also keeps GitHub Enterprise correct: the fork is
 * on the same host as the PR, never hardcoded to github.com.
 *
 * A same-repo head returns null: `origin/<branch>` already resolves it, and
 * adding a fork remote for it would be wrong.
 *
 * Requires `isCrossRepository`, `headRepository`, `headRepositoryOwner`, and
 * `url` in the caller's `--json` field list.
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
  // The PR URL's scheme+host, without constructing a URL object for a value the
  // forge may have omitted entirely.
  const [, origin] = /^(https?:\/\/[^/]+)\//.exec(typeof pr?.url === 'string' ? pr.url : '') || [];
  if (!ownerLogin || !nameWithOwner || !origin) return null;
  return normalizeForkHead({ remoteUrl: `${origin}/${nameWithOwner}.git`, ownerLogin });
}
