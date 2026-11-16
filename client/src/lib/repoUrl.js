/**
 * `parseRepoUrl(url)` / `repoBrowseUrl(parsed)` / `parseGitHubUrl(url)` /
 * `isGitHubRepoUrl(url)` — re-exported from `server/lib/repoUrl.js`, the authoritative repo-URL rule.
 */

/**
 * Repository URL parsing/normalization.
 *
 * Re-export of `server/lib/repoUrl.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/repoUrl` import path in the client is unchanged.
 */
export { isGitHubRepoUrl, parseGitHubUrl, parseRepoUrl, repoBrowseUrl } from '../../../server/lib/repoUrl.js';
