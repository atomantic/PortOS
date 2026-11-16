/**
 * The repository metadata a Brain link carries, plus the compatibility shim keeping it readable across PortOS versions.
 *
 * The repository metadata a Brain link carries (`deriveRepoLinkFields(url)` / `normalizeRepoLinkFields(link)` / `linkIsRepo(link)` / `repoLinkLabel(link)`) plus the dual-write/tolerant-read shim keeping the pre-multi-host `isGitHubRepo` names readable across federated peers.
 *
 * The fields were GitHub-only (`isGitHubRepo` / `gitHubOwner` / `gitHubRepo`) and are now host-generic (`isRepo` / `repoHost` / `repoOwner` / `repoName`) so gitlab.com repos are first-class; migration 330 rewrites stored links. Brain links FEDERATE verbatim, so a rename alone would break a mixed-version tailnet both ways:
 * `deriveRepoLinkFields` writes BOTH shapes (a gitlab.com repo gets `isGitHubRepo: false` on purpose, so an old peer files it as a bookmark rather than handing a GitLab URL to a GitHub-only cloner); `normalizeRepoLinkFields` fills the new shape from the legacy one on READ (a record from an old peer or pre-migration still reads as a repo).
 */

import { parseRepoUrl } from './repoUrl.js';

const GITHUB_HOST = 'github.com';

/**
 * The repo fields for a captured URL, new shape plus the legacy mirror.
 *
 * @param {string} url
 * @returns {{ isRepo: boolean, repoHost: string|null, repoOwner: string|null,
 *   repoName: string|null, isGitHubRepo: boolean, gitHubOwner: string|null,
 *   gitHubRepo: string|null }}
 */
export function deriveRepoLinkFields(url) {
  const parsed = parseRepoUrl(url);
  const isGitHub = parsed?.host === GITHUB_HOST;
  return {
    isRepo: Boolean(parsed),
    repoHost: parsed?.host ?? null,
    repoOwner: parsed?.owner ?? null,
    repoName: parsed?.repo ?? null,
    isGitHubRepo: isGitHub,
    gitHubOwner: isGitHub ? parsed.owner : null,
    gitHubRepo: isGitHub ? parsed.repo : null,
  };
}

/**
 * Read a link's repo fields, falling back to the legacy GitHub-only shape; returns the record unchanged when it already carries `isRepo` (the post-migration path allocates nothing).
 *
 * @template {object|null|undefined} T
 * @param {T} link
 * @returns {T}
 */
export function normalizeRepoLinkFields(link) {
  if (!link || link.isRepo !== undefined) return link;
  if (!link.isGitHubRepo) return link;
  return {
    ...link,
    isRepo: true,
    repoHost: GITHUB_HOST,
    repoOwner: link.gitHubOwner ?? null,
    repoName: link.gitHubRepo ?? null,
  };
}

/**
 * True when a link record (either shape) names a cloneable repository.
 *
 * @param {object|null|undefined} link
 */
export const linkIsRepo = (link) => Boolean(link?.isRepo ?? link?.isGitHubRepo);

/**
 * `owner/repo` for a link record, else its display title; reads only the new shape (every link reaches a caller via a `brainStorage` read that already ran `normalizeRepoLinkFields`).
 *
 * @param {object|null|undefined} link
 */
export function repoLinkLabel(link) {
  return link?.repoOwner && link?.repoName
    ? `${link.repoOwner}/${link.repoName}`
    : (link?.title || link?.url || 'unknown repo');
}
