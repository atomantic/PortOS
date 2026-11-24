/**
 * Eidoverse Worlds source repository: the default URL and the GitHub URL normalizer.
 *
 * A leaf so `services/instanceFeatures.js` can resolve the configured source
 * without the `services/eidoverse.js` install graph.
 */
import { ServerError } from './errorHandler.js';
import { parseGitHubUrl } from './repoUrl.js';

export const DEFAULT_EIDOVERSE_WORLDS_REPO = 'https://github.com/atomantic/eidoverse-worlds';

export function normalizeEidoverseWorldsRepo(worldsRepoUrl) {
  const parsed = parseGitHubUrl(worldsRepoUrl);
  if (!parsed) {
    throw new ServerError('Choose a valid GitHub repository for Eidoverse Worlds.', {
      status: 400,
      code: 'EIDOVERSE_REPO_INVALID',
    });
  }
  return /^git@github\.com:/i.test(String(worldsRepoUrl).trim())
    ? `git@github.com:${parsed.owner}/${parsed.repo}.git`
    : `https://github.com/${parsed.owner}/${parsed.repo}`;
}
