/**
 * Agent-branch upstream guard (#4172).
 *
 * `git worktree add -b <branch> <path> origin/main` records
 * `branch.<name>.merge = refs/heads/main` (default `autoSetupMerge`). `/do:pr`
 * derives its push destination from that config (`HEAD:$PUSH_BRANCH`), so such a
 * branch would push the agent's work STRAIGHT TO MAIN, skipping the PR.
 *
 * Invariant: an agent branch's upstream is ABSENT or names its OWN ref
 * (`refs/heads/<branch>`).
 *
 * Enforcement is REPAIR-then-verify: drop the bogus upstream, and throw only if the
 * repair doesn't take, since handing the worktree to an agent would risk the default
 * branch. Prevention is `--no-track` at the creation sites in
 * `services/worktreeManager.js`; this is the backstop for other paths.
 */

import { execGit } from './execGit.js';

/** Bound on every git call here — this sits on the agent-spawn path. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Read a branch's configured upstream as raw config values.
 *
 * Three outcomes, deliberately NOT collapsed: `''` is UNSET (healthy untracked
 * branch), a string is the configured ref, `null` is COULD NOT READ. Folding null
 * into `''` would let a wedged git report a branch tracking `main` as untracked.
 * `git config --get` exits 1 for an unset key and 128 for a bad repo. Non-throwing.
 */
export async function readBranchUpstream(repo, branchName) {
  if (!repo || !branchName) return { remote: '', merge: '' };
  const read = async (key) => {
    const result = await execGit(
      ['config', '--get', `branch.${branchName}.${key}`],
      repo,
      { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
    ).catch(() => null);
    if (!result) return null;
    if (result.exitCode === 0) return (result.stdout || '').trim();
    return result.exitCode === 1 ? '' : null;
  };
  const [remote, merge] = await Promise.all([read('remote'), read('merge')]);
  return { remote, merge };
}

/**
 * The invariant as a pure predicate: safe when ABSENT or the branch's OWN ref (not
 * merely "not the default branch"). Accepts the short form as well as
 * `refs/heads/<name>`. A `null` merge (unreadable) is NOT safe.
 */
export function isSafeBranchUpstream(branchName, merge) {
  if (merge === null || merge === undefined) return false;
  if (merge === '') return true;
  return merge === `refs/heads/${branchName}` || merge === branchName;
}

/**
 * Assert, and when violated repair, the upstream invariant for a branch a CoS agent
 * is about to be handed. Throws when the branch still tracks a foreign ref after the
 * repair, or when the config is unreadable; it runs inside `createWorktree`'s
 * promise chain, whose callers handle a rejected create and undo the `worktree add`.
 * `options.remoteBranch` is the explicit PR head when the local name is namespaced.
 */
export async function enforceSafeBranchUpstream(repo, branchName, { remoteBranch = branchName } = {}) {
  if (!repo || !branchName) return { safe: true, repaired: false, upstream: '' };
  const { merge } = await readBranchUpstream(repo, branchName);
  if (isSafeBranchUpstream(remoteBranch, merge)) return { safe: true, repaired: false, upstream: merge };
  // Unreadable config is not a clean bill of health.
  if (merge === null) {
    throw new Error(`Refusing to hand off branch ${branchName}: its upstream config could not be read, so a config-derived push (git push <remote> HEAD:<merge>) cannot be shown to be safe`);
  }

  console.error(`❌ Branch ${branchName} tracks ${merge} instead of its own ref — dropping the upstream so a config-derived push can't land there (#4172)`);
  await execGit(['branch', '--unset-upstream', branchName], repo, {
    ignoreExitCode: true,
    timeout: GIT_TIMEOUT_MS,
  }).catch(() => {});

  const after = await readBranchUpstream(repo, branchName);
  if (!isSafeBranchUpstream(remoteBranch, after.merge)) {
    const stillAt = after.merge === null ? 'an unreadable value' : after.merge;
    throw new Error(`Refusing to hand off branch ${branchName}: its upstream still resolves to ${stillAt} — a config-derived push (git push <remote> HEAD:<merge>) would land there instead of opening a PR`);
  }
  return { safe: true, repaired: true, upstream: merge };
}
