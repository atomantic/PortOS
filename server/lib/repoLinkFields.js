/**
 * The repository metadata a Brain link carries, and the compatibility shim that
 * keeps it readable across PortOS versions.
 *
 * The fields used to be GitHub-only (`isGitHubRepo` / `gitHubOwner` /
 * `gitHubRepo`). They are now host-generic (`isRepo` / `repoHost` / `repoOwner`
 * / `repoName`) so gitlab.com repos are first-class, and migration 330 rewrites
 * every stored link.
 *
 * PortOS is DISTRIBUTED and brain links FEDERATE verbatim between peers, so a
 * rename alone would break a mixed-version tailnet in both directions. Hence:
 *
 *   - `deriveRepoLinkFields` writes BOTH shapes, so a peer still on the old code
 *     keeps recognising a captured GitHub repo. A gitlab.com repo is written
 *     with `isGitHubRepo: false` on purpose — an old peer must file it as a
 *     plain bookmark rather than hand a GitLab URL to a GitHub-only cloner.
 *   - `normalizeRepoLinkFields` fills the new shape from the legacy one on READ,
 *     so a record arriving from an old peer (or written before the migration
 *     ran) still reads as a repo.
 */

import { parseRepoUrl } from './repoUrl.js';

/** The one host the legacy GitHub-only mirror can describe. */
const GITHUB_HOST = 'github.com';

/**
 * The repo fields for a captured URL — new shape plus the legacy mirror.
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
 * Read a link's repo fields, falling back to the legacy GitHub-only shape.
 * Returns the record unchanged when it already carries `isRepo`, so the common
 * (post-migration) path allocates nothing.
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
 * @returns {boolean}
 */
export const linkIsRepo = (link) => Boolean(link?.isRepo ?? link?.isGitHubRepo);

/**
 * `owner/repo` for a link record, else its display title. Reads only the new
 * shape: every link reaches a caller through a `brainStorage` read, which has
 * already run `normalizeRepoLinkFields`.
 *
 * @param {object|null|undefined} link
 * @returns {string}
 */
export function repoLinkLabel(link) {
  return link?.repoOwner && link?.repoName
    ? `${link.repoOwner}/${link.repoName}`
    : (link?.title || link?.url || 'unknown repo');
}
