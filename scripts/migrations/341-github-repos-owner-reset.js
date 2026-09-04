/**
 * Clear the hardcoded maintainer default out of `data/github-repos.json`.
 *
 * Before this fix, `defaultData()` seeded `githubUser: 'atomantic'` and
 * `syncRepos()` never wrote a different value back — `const owner =
 * data.githubUser || 'atomantic'` read the field but nothing ever assigned to
 * it. So on every fork install that ever ran a sync, `gh repo list atomantic`
 * (the upstream maintainer's own login) executed regardless of which account
 * the local user actually authenticated as, and `githubUser` stayed
 * `'atomantic'` in the persisted file forever. `getRepos()` now filters by
 * that field (`reposForAccount`), so an install carrying the stale value would
 * otherwise see its cached list as "belonging to the current account" (if it
 * happens to also be `atomantic`) or get permanently 409'd on every mutation
 * with no obvious way out (if it is not).
 *
 * This resets `githubUser` to `null` wherever it is still exactly the shipped
 * default, forcing the same "sign in and sync" path a fresh install takes.
 * The underlying `repos` map is left untouched: per-repo `flags` /
 * `managedSecrets` are keyed by `fullName`, not by owner, so a real sync
 * afterward reattaches them to the correct entries automatically — including,
 * on the upstream maintainer's own machine, resolving right back to
 * `'atomantic'` with nothing lost.
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
