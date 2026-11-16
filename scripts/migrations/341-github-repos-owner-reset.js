/**
 * Clear the hardcoded maintainer default out of `data/github-repos.json`.
 *
 * `defaultData()` seeded `githubUser: 'atomantic'` and `syncRepos()` never wrote another value back (`const owner = data.githubUser || 'atomantic'` read the field, nothing assigned it), so on every fork install that ran a sync `gh repo list atomantic` executed regardless of the authenticated account and `githubUser` stayed `'atomantic'` forever. `getRepos()` now filters by that field (`reposForAccount`), so a stale value would show the cached list as the current account's (if it is also `atomantic`) or 409 every mutation with no way out.
 * This resets `githubUser` to `null` wherever it is still exactly the shipped default, forcing the "sign in and sync" path a fresh install takes. The `repos` map is untouched: per-repo `flags` / `managedSecrets` are keyed by `fullName`, not owner, so a real sync reattaches them (on the maintainer's own machine, resolving back to `'atomantic'` with nothing lost).
 */

import { join } from 'path';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';

const REPOS_PATH = join('data', 'github-repos.json');
const STALE_DEFAULT_OWNER = 'atomantic';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REPOS_PATH);
    const { ok, value: data } = await readJSONFileStrict(path, null);
    if (!ok || data === null) return { reset: false, reason: 'no readable github-repos.json' };
    if (data.githubUser !== STALE_DEFAULT_OWNER) {
      return { reset: false, reason: 'githubUser is not the shipped default' };
    }

    data.githubUser = null;
    await atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🔧 ${REPOS_PATH}: cleared the hardcoded '${STALE_DEFAULT_OWNER}' owner; next sync reattaches the authenticated account`);
    return { reset: true };
  },
};
