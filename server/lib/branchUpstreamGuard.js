/**
 * Agent-branch upstream guard (#4172).
 *
 * `git worktree add -b <branch> <path> origin/main` does NOT leave the new
 * branch untracked. With git's default `branch.autoSetupMerge=true`, branching
 * off a REMOTE-TRACKING ref records:
 *
 *     branch.<name>.remote = origin
 *     branch.<name>.merge  = refs/heads/main      <-- not the branch's own ref
 *
 * That config is load-bearing for push helpers. `/do:pr` deliberately derives
 * its push destination from it rather than from the local branch name —
 * `git push "$PUSH_REMOTE" "HEAD:$PUSH_BRANCH"` — so a branch whose upstream is
 * named differently from the branch still pushes to the right ref. With
 * `merge=refs/heads/main` that same guard resolves to `HEAD:refs/heads/main`
 * and pushes the agent's work STRAIGHT TO MAIN, skipping the PR entirely while
 * reporting success. The existing carve-outs don't catch it: the branch *has*
 * an upstream (so the "no upstream" skip doesn't apply) and the remote is a
 * real remote, not `.` (so the local-upstream guard doesn't fire).
 *
 * The invariant this module enforces: an agent branch's upstream is either
 * ABSENT or names its OWN ref (`refs/heads/<branch>` — what `git push -u origin
 * <branch>` records once the branch is published). Anything else is a
 * mis-aimed push waiting to happen.
 *
 * Enforcement is REPAIR-then-verify, not refuse: the fix is to drop the bogus
 * upstream, and an untracked branch is exactly what makes `/do:pr`'s
 * `git push -u origin <branch>` path correct. Repair is logged loudly because a
 * branch that reached this state means a creation path forgot `--no-track`.
 * `enforceSafeBranchUpstream` throws only when the repair itself doesn't take,
 * because at that point every downstream push helper is still aimed at the
 * wrong ref and handing the worktree to an agent would risk the default branch.
 *
 * Prevention lives at the creation sites (`--no-track` on every
 * `git worktree add -b … origin/<base>` in `services/worktreeManager.js`); this
 * guard is the backstop that also repairs branches created before the fix, or
 * by a path that doesn't route through the manager.
 */

import { execGit } from './execGit.js';

/** Bound on every git call here — this sits on the agent-spawn path. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Read a branch's configured upstream as raw config values. Both fields are
 * `''` when unset (an untracked branch), never null/undefined, so callers get
 * one shape to reason about. Non-throwing: an unreadable repo reads as unset.
 *
 * @param {string} repo - repository (or worktree) path to read config from
 * @param {string} branchName
 * @returns {Promise<{remote: string, merge: string}>}
 */
export async function readBranchUpstream(repo, branchName) {
  if (!repo || !branchName) return { remote: '', merge: '' };
  const read = async (key) => {
    const result = await execGit(
      ['config', '--get', `branch.${branchName}.${key}`],
      repo,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    // `--get` exits 1 for an unset key, which is the common case, not an error.
    return result && result.exitCode === 0 ? (result.stdout || '').trim() : '';
  };
  const [remote, merge] = await Promise.all([read('remote'), read('merge')]);
  return { remote, merge };
}

/**
 * The invariant, as a pure predicate: an upstream is safe when it is ABSENT or
 * names the branch's OWN ref. Deliberately NOT "is it the default branch" — a
 * branch tracking any ref other than its own is a push aimed somewhere the
 * branch name doesn't say, and the default branch is only the most destructive
 * instance of that. Accepts the short form (`main`) as well as the fully
 * qualified `refs/heads/main` that git actually writes, so a hand-edited config
 * is judged the same way.
 *
 * @param {string} branchName
 * @param {string} merge - the `branch.<name>.merge` value
 */
export function isSafeBranchUpstream(branchName, merge) {
  if (!merge) return true;
  return merge === `refs/heads/${branchName}` || merge === branchName;
}

/**
 * Assert — and, when violated, repair — the upstream invariant for a branch a
 * CoS agent is about to be handed.
 *
 * Returns `{ safe: true, repaired: false }` for the overwhelmingly common
 * healthy case, `{ safe: true, repaired: true, upstream }` when a bogus upstream
 * was dropped (with the offending ref carried so the caller can log what it
 * found), and THROWS when the branch still tracks a foreign ref after the
 * repair — the loud failure, because a push helper would land on it.
 *
 * Unlike the rest of the git-boundary helpers this one is allowed to throw: it
 * runs during worktree creation (inside `createWorktree`'s promise chain, whose
 * callers already handle a rejected create), and silently handing back a
 * worktree whose branch pushes to `main` is precisely the failure it exists to
 * prevent.
 *
 * @param {string} repo - repository path whose config holds the branch
 * @param {string} branchName
 * @returns {Promise<{safe: boolean, repaired: boolean, upstream: string}>}
 */
export async function enforceSafeBranchUpstream(repo, branchName) {
  if (!repo || !branchName) return { safe: true, repaired: false, upstream: '' };
  const { merge } = await readBranchUpstream(repo, branchName);
  if (isSafeBranchUpstream(branchName, merge)) return { safe: true, repaired: false, upstream: merge };

  console.error(`❌ Branch ${branchName} tracks ${merge} instead of its own ref — dropping the upstream so a config-derived push can't land there (#4172)`);
  await execGit(['branch', '--unset-upstream', branchName], repo, {
    ignoreExitCode: true,
    timeout: GIT_TIMEOUT_MS,
  }).catch(() => {});

  const after = await readBranchUpstream(repo, branchName);
  if (!isSafeBranchUpstream(branchName, after.merge)) {
    throw new Error(`Refusing to hand off branch ${branchName}: its upstream still resolves to ${after.merge} — a config-derived push (git push <remote> HEAD:<merge>) would land there instead of opening a PR`);
  }
  return { safe: true, repaired: true, upstream: merge };
}
