/**
 * Build identity of the RUNNING install — which git commit this process was
 * started from (#4694).
 *
 * The hazard this closes: one PM2-managed `portos-server` serves :5555 for the
 * whole machine while any number of worktrees (CoS agents, `/do:next` claims,
 * the primary checkout) hold different code. Anyone verifying a change by
 * hitting the running instance is, by default, observing whatever build PM2
 * last started, from whatever checkout, at whatever commit — and nothing in the
 * responses said so. `version` can't answer it: by project rule package.json's
 * version reflects the last RELEASE and is identical across every development
 * commit and every worktree.
 *
 * Distinct from `buildId.js`, which hashes `client/dist/index.html` to detect a
 * browser holding a stale BUNDLE relative to what is on disk right now. That
 * hash says nothing about which commit either side was built from: a `dist/`
 * built three days ago and one built this minute are both "current" to buildId
 * as long as the browser matches the file. This module answers the other half —
 * WHICH CODE is up. They travel separately on purpose: the bundle hash is pushed
 * to every socket, while this is served only over `GET /api/system/build`,
 * because the socket path also reaches peer relays (see services/socket.js).
 *
 * Privacy: commit / branch / dirty only. No absolute paths (they embed the OS
 * username), no hostname, no checkout directory — see the Sensitive Data
 * section of the root AGENTS.md. Deliberately no timestamp either: "how long
 * has this process been up" is already `system.uptime` on the health payload,
 * and a second spelling of it here would drift (uptime is recomputed per
 * request; this tuple is frozen at first read).
 */

import { execGit } from './execGit.js';
import { PATHS } from './fileUtils.js';

// `PATHS.root` is CODE_ROOT — the checkout this process's code was loaded
// from, which is exactly the question being asked. Deliberately NOT
// `installRoot`: under a worktree boot (PORTOS_DATA_ROOT, #1947) the data tree
// and the code tree diverge, and the commit that matters is the code's.
const CODE_ROOT = PATHS.root;

// A short bound, not execGit's 30s default: this runs at boot and behind a
// health route, and a git wedged on a locked index or a slow network mount must
// not hold either open.
const GIT_TIMEOUT_MS = 5000;

// git's own "there is no value here" spellings in the porcelain-v2 header:
// `(initial)` for a repo with no commits yet, `(detached)` for a detached HEAD.
// Both read as absent.
//
// git permits a branch literally named `(detached)` and prints it in this header
// byte-for-byte identically to a real detached HEAD, so the format itself cannot
// separate the two and neither can any parser over it. Reading it as detached is
// the right call anyway: the cost is one mislabeled branch in a display string,
// and `commit` — the field the drift comparison actually uses — is unaffected.
// (The mirror case does not exist on the client: git REFUSES to create a branch
// named `HEAD`, so `rev-parse --abbrev-ref` printing `HEAD` is always detached.)
const NO_COMMIT = '(initial)';
const NO_BRANCH = '(detached)';

/**
 * Parse `git status --porcelain=v2 --branch` into the identity tuple.
 *
 * One command answers all three questions: `# branch.oid` is HEAD,
 * `# branch.head` is the branch, and any non-`#` line is a change in the tree.
 * That is also why `dirty` can be read honestly here — a clean tree emits the
 * header and nothing else, which a bare `--porcelain` (no header) could not
 * distinguish from a command that failed and printed nothing.
 *
 * Exported for the test suite, which pins the parse against real git output
 * rather than re-implementing this logic in the assertions.
 */
export function parsePorcelainV2(stdout) {
  const lines = String(stdout).split('\n');
  let commit = null;
  let branch = null;
  let dirty = false;

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      // Empty stays null rather than becoming '': an empty-string commit
      // compares unequal to every real commit and would report a permanent
      // false mismatch downstream (root AGENTS.md's absent-vs-empty rule).
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

// Every field null, and `dirty` null rather than false — "we could not check"
// must stay distinguishable from "we checked and the tree is clean".
const UNKNOWN_IDENTITY = { commit: null, shortCommit: null, branch: null, dirty: null };

/**
 * @returns {Promise<{identity: object, definitive: boolean}>} `definitive` is
 *   false only when the probe itself failed (timeout, spawn error) — a state
 *   that can clear on its own and so must not be cached forever.
 */
async function probe() {
  // `ignoreExitCode` so a non-repo resolves to a readable non-zero exit rather
  // than rejecting — the house convention for probe-shaped git calls, see
  // `gitCommitProbe.js`.
  const result = await execGit(['status', '--porcelain=v2', '--branch'], CODE_ROOT, {
    ignoreExitCode: true,
    timeout: GIT_TIMEOUT_MS
  }).catch(() => null);

  // A REJECTION is transient: git timed out or could not be spawned. That can
  // genuinely happen once at boot — the 5s bound elapsing while migrations and
  // the DB hammer the disk, or a cold/dataless tree git has to materialize —
  // and caching it would pin every field to null for the process lifetime,
  // silently disabling the whole feature on a perfectly good checkout.
  if (!result) return { identity: UNKNOWN_IDENTITY, definitive: false };

  // A non-zero EXIT is definitive: git ran and told us this is not a checkout
  // (a tarball install). Cache it, or every health request would re-spawn git
  // to re-learn the same answer.
  if (result.exitCode !== 0) return { identity: UNKNOWN_IDENTITY, definitive: true };

  return { identity: parsePorcelainV2(result.stdout), definitive: true };
}

// Backoff after a transient probe failure — long enough that a burst of socket
// reconnects collapses to one attempt, short enough to self-heal unattended.
const RETRY_COOLDOWN_MS = 30_000;

let cached = null;
let resolved = null;
let retryBlockedUntil = 0;

/**
 * Resolve the running build's git identity. Cached for the life of the process:
 * the code a running process loaded cannot change under it, so re-probing git
 * per health request would spend a subprocess to re-learn a constant. The cache
 * holds the PROMISE, so concurrent first callers (the boot log and an early
 * request) share one spawn instead of racing to fire their own.
 *
 * `dirty` describes the tree this process booted FROM — a later edit on disk is
 * not code this process is executing, so freezing it is the honest reading, and
 * the UI labels it as an at-start fact.
 *
 * Non-throwing. Every field is independently nullable: a tarball install with
 * no `.git`, a detached checkout, or a git timeout reports `commit: null`. A
 * timeout is retried (after a cooldown); a definitive "not a repo" is not.
 *
 * @returns {Promise<{commit: string|null, shortCommit: string|null, branch: string|null, dirty: boolean|null}>}
 */
export function getBuildIdentity() {
  if (!cached && retryBlockedUntil > Date.now()) return Promise.resolve(UNKNOWN_IDENTITY);
  cached ??= probe().then(({ identity, definitive }) => {
    // Release the cache when the probe merely FAILED, so the next caller retries
    // instead of inheriting a transient null forever. A definitive answer —
    // including "not a git checkout" — is kept, preserving the one-spawn
    // property for real repos and tarball installs alike.
    //
    // `resolved` is set ONLY on a definitive answer, for the same reason: it
    // backs the synchronous accessor, and an all-null tuple parked there is
    // truthy, so the boot banner would print "unknown" instead of taking its
    // defer-and-retry path.
    if (definitive) {
      resolved = identity;
    } else {
      // Retry, but not on every caller. This is now read per socket reconnect
      // and per /api/system/build request, and Socket.IO retries up to 10 times
      // per tab — so on a host where git is missing (spawn ENOENT) or wedged
      // (the 5s timeout), an unbounded release would spawn a git per attempt,
      // per tab. The cooldown keeps the recovery while capping the cost.
      cached = null;
      retryBlockedUntil = Date.now() + RETRY_COOLDOWN_MS;
    }
    return identity;
  });
  return cached;
}

/**
 * The identity if it has already resolved, else null — for callers that must
 * log synchronously and cannot introduce an await.
 *
 * `announceListening` in `services/bootstrap.js` is the case: its caller does
 * not await it, so an await inside would let the rest of the boot banner print
 * around the yield. Boot primes the cache long before `listen()` fires, so this
 * is populated by then; if it somehow is not, `formatBuildIdentity(null)`
 * degrades to "unknown" rather than blocking or printing a placeholder.
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
