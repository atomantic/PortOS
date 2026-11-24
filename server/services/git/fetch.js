import { sleep } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { isBenignConcurrentFetchRefRace } from '../../lib/gitOutputParsers.js';
import { PROTECTED_BRANCHES } from '../../lib/gitArgs.js';
import { getRepoBranches } from './status.js';

const FETCH_MAX_ATTEMPTS = 4;
const FETCH_RETRY_DELAY_MS = 250;
const FETCH_FRESHNESS_MS = 15000;

const lastFetchTimes = new Map();
const activeFetches = new Map();

export function recordFetchSuccess(dir) {
  if (dir) lastFetchTimes.set(dir, Date.now());
}

export function isFetchFresh(dir, windowMs = FETCH_FRESHNESS_MS) {
  if (!dir) return false;
  const last = lastFetchTimes.get(dir);
  if (!last) return false;
  return (Date.now() - last) < windowMs;
}

export function clearFetchCache() {
  lastFetchTimes.clear();
  activeFetches.clear();
}

function fetchOriginAttempt(dir, attempt, prune = false) {
  return execGit(prune ? ['fetch', '--prune', 'origin'] : ['fetch', 'origin'], dir).then(
    () => {
      recordFetchSuccess(dir);
      return true;
    },
    async (err) => {
      // A concurrent fetch that already wrote the exact refs this one wanted is
      // a SUCCESS reported as a failure — git exits non-zero on the lost
      // compare-and-swap even though the remote-tracking refs now hold the
      // right commits. Retrying re-runs a whole network fetch to learn there is
      // nothing to do, and on a busy repo every attempt loses the same race, so
      // the caller surfaced a red error for work that had actually completed.
      if (isBenignConcurrentFetchRefRace(err.message)) {
        recordFetchSuccess(dir);
        return true;
      }
      // Another PortOS surface or agent may advance the same remote ref mid-fetch.
      if (attempt >= FETCH_MAX_ATTEMPTS) throw err;
      const { isGitLockError } = await import('../worktreeManager.js');
      if (!isGitLockError(err.message)) throw err;
      return sleep(FETCH_RETRY_DELAY_MS).then(() => fetchOriginAttempt(dir, attempt + 1, prune));
    }
  );
}

/**
 * Fetch origin with the concurrency handling a raw `git fetch` lacks: retries an
 * `index.lock` collision, and treats a lost compare-and-swap on refs another
 * PortOS surface already wrote as the SUCCESS it is.
 * @param {string} dir
 * @param {{prune?: boolean}} [opts] - `prune` also drops remote-tracking refs whose
 *   remote branch is gone, for callers that go on to reason about what origin still has.
 */
export async function fetchOrigin(dir, { prune = false } = {}) {
  return withGitMutationLifetime(() => fetchOriginAdmitted(dir, { prune }));
}

function fetchOriginAdmitted(dir, { prune = false } = {}) {
  return fetchOriginAttempt(dir, 1, prune);
}

/**
 * Get remote branches with merge status relative to the default branch.
 * Returns branches that exist on origin, indicating whether each has been
 * fully merged into the default branch and whether a local copy exists.
 */
export async function getRemoteBranches(dir, { force = false } = {}) {
  // Fetch latest refs if forced or not fresh within window
  if (force || !isFetchFresh(dir)) {
    const freshen = () => withGitMutationLifetime(async () => {
      if (activeFetches.has(dir)) {
        await activeFetches.get(dir);
      } else {
        const fetchPromise = execGit(['fetch', 'origin', '--prune'], dir, { ignoreExitCode: true })
          .then(res => {
            if (res.exitCode === 0 || isBenignConcurrentFetchRefRace(res.stderr || res.stdout || '')) {
              recordFetchSuccess(dir);
            }
            return res;
          })
          .finally(() => {
            activeFetches.delete(dir);
          });
        activeFetches.set(dir, fetchPromise);
        await fetchPromise;
      }
    });
    await freshen();
  }

  // Detect default branch
  const { baseBranch } = await getRepoBranches(dir);
  const defaultBranch = baseBranch || 'main';

  // Get all remote branches
  const result = await execGit(
    ['branch', '-r', '--format=%(refname:short)|%(committerdate:iso8601)|%(authorname)'],
    dir,
    { ignoreExitCode: true }
  );

  // Get merged remote branches relative to default branch
  const mergedResult = await execGit(
    ['branch', '-r', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)'],
    dir,
    { ignoreExitCode: true }
  );
  const mergedSet = new Set(mergedResult.stdout.trim().split('\n').filter(Boolean));

  // Get local branches for cross-reference
  const localResult = await execGit(['branch', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  const localSet = new Set(localResult.stdout.trim().split('\n').filter(Boolean));

  const remoteBranches = result.stdout.trim().split('\n').filter(Boolean)
    .map(line => {
      const [fullRef, date, author] = line.split('|');
      // Only include refs from origin remote
      if (!fullRef.startsWith('origin/')) return null;
      // Strip "origin/" prefix
      const name = fullRef.replace(/^origin\//, '');
      // Skip HEAD pointer and refs without a branch name (bare remote name)
      if (name === 'HEAD' || fullRef.includes('HEAD') || !name) return null;
      return {
        name,
        fullRef,
        merged: mergedSet.has(fullRef),
        hasLocal: localSet.has(name),
        lastCommitDate: date?.trim() || null,
        author: author?.trim() || null,
        isDefault: name === defaultBranch,
        isProtected: name === defaultBranch || PROTECTED_BRANCHES.includes(name)
      };
    })
    .filter(Boolean);

  return { branches: remoteBranches, defaultBranch };
}
