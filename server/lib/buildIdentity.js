/**
 * Build identity of the RUNNING install — which git commit this process was
 * started from (#4694).
 *
 * One PM2-managed server serves the whole machine while many worktrees hold
 * different code, and `package.json` version only reflects the last RELEASE. Distinct
 * from `buildId.js`, which hashes `client/dist/index.html` to detect a stale browser
 * BUNDLE; this answers WHICH CODE is up. It is served only over
 * `GET /api/system/build`, not pushed to sockets, because the socket path also
 * reaches peer relays (see services/socket.js).
 *
 * Privacy: commit / branch / dirty only — no absolute paths, hostname or checkout
 * directory, and no timestamp (uptime is already on the health payload).
 */

import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';

// The checkout the code was loaded from; NOT `installRoot`, which diverges under a
// worktree boot (PORTOS_DATA_ROOT).
const CODE_ROOT = PATHS.root;

// Short bound: runs at boot and behind a health route, which a wedged git must not hold open.
const GIT_TIMEOUT_MS = 5000;

// git's "no value" spellings in the porcelain-v2 header; both read as absent. A branch
// literally named `(detached)` is indistinguishable, which only mislabels a display string.
const NO_COMMIT = '(initial)';
const NO_BRANCH = '(detached)';

/**
 * Parse `git status --porcelain=v2 --branch` into the identity tuple: `# branch.oid`
 * is HEAD, `# branch.head` the branch, any non-`#` line a tree change. The header
 * lets a clean tree be told apart from a failed command that printed nothing.
 */
export function parsePorcelainV2(stdout) {
  const lines = String(stdout).split('\n');
  let commit = null;
  let branch = null;
  let dirty = false;

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      // Empty stays null: '' would compare unequal to every real commit (permanent false mismatch).
      if (value && value !== NO_COMMIT) commit = value;
    } else if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      if (value && value !== NO_BRANCH) branch = value;
    } else if (line.trim() !== '' && !line.startsWith('#')) {
      dirty = true;
    }
  }

  return { commit, shortCommit: commit ? commit.slice(0, 7) : null, branch, dirty };
}

// `dirty` null, not false: "could not check" differs from "clean".
const UNKNOWN_IDENTITY = { commit: null, shortCommit: null, branch: null, dirty: null };

/**
 * @returns {Promise<{identity: object, definitive: boolean}>} `definitive` is
 *   false only when the probe itself failed (timeout, spawn error) — a state
 *   that can clear on its own and so must not be cached forever.
 */
async function probe() {
  // `ignoreExitCode`: a non-repo resolves to a non-zero exit rather than rejecting.
  const result = await execGit(['status', '--porcelain=v2', '--branch'], CODE_ROOT, {
    ignoreExitCode: true,
    timeout: GIT_TIMEOUT_MS
  }).catch(() => null);

  // A REJECTION is transient (timeout or spawn failure, possible once at boot);
  // caching it would pin every field to null for the process lifetime.
  if (!result) return { identity: UNKNOWN_IDENTITY, definitive: false };

  // A non-zero EXIT is definitive (not a checkout, e.g. tarball install); cache it.
  if (result.exitCode !== 0) return { identity: UNKNOWN_IDENTITY, definitive: true };

  return { identity: parsePorcelainV2(result.stdout), definitive: true };
}

// Backoff after a transient probe failure: collapses reconnect bursts, still self-heals.
const RETRY_COOLDOWN_MS = 30_000;

let cached = null;
let resolved = null;
let retryBlockedUntil = 0;

/**
 * Resolve the running build's git identity. Cached for the process lifetime (loaded
 * code cannot change); the cache holds the PROMISE so concurrent first callers share
 * one spawn. `dirty` describes the tree at boot.
 *
 * Non-throwing; every field is independently nullable. A timeout is retried after a
 * cooldown; a definitive "not a repo" is not.
 *
 * @returns {Promise<{commit: string|null, shortCommit: string|null, branch: string|null, dirty: boolean|null}>}
  * Served only on GET /api/system/build, never on /health/details: peers scrape that payload and persist it verbatim, and the commit stays machine-local.
 */
export function getBuildIdentity() {
  if (!cached && retryBlockedUntil > Date.now()) return Promise.resolve(UNKNOWN_IDENTITY);
  cached ??= probe().then(({ identity, definitive }) => {
    // Release the cache when the probe merely FAILED; keep definitive answers.
    // `resolved` is set ONLY on a definitive answer: an all-null tuple is truthy and
    // would make the boot banner print "unknown" instead of deferring.
    if (definitive) {
      resolved = identity;
    } else {
      // The cooldown caps spawns: this is read per socket reconnect and request.
      cached = null;
      retryBlockedUntil = Date.now() + RETRY_COOLDOWN_MS;
    }
    return identity;
  });
  return cached;
}

/**
 * The identity if already resolved, else null — for synchronous callers
 * (`announceListening` in `services/bootstrap.js`); `formatBuildIdentity(null)`
 * degrades to "unknown".
 */
export function getCachedBuildIdentity() {
  return resolved;
}

/**
 * Single-line, human-readable summary for the boot log — `abc1234 (main, dirty)`.
 * Falls back to `unknown` rather than printing an empty parenthetical when git
 * is unavailable.
 */
export function formatBuildIdentity(identity) {
  if (!identity?.shortCommit) return 'unknown (no git metadata)';
  const parts = [identity.branch || 'detached'];
  if (identity.dirty === true) parts.push('dirty');
  if (identity.dirty === null) parts.push('cleanliness unknown');
  return `${identity.shortCommit} (${parts.join(', ')})`;
}
