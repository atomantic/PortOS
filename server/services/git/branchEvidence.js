import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { rmGuarded } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { repoObservationEnv } from '../repoBranchSnapshot.js';

const COMMIT_SHA_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

/**
 * How a branch's `head` came to be inside `target`, for merged retirement
 * (#16625). Ancestry alone cannot tell a merged branch from one created at the
 * default branch a minute ago, so this separates them:
 *
 * - `'patch'`: the head is not an ancestor of target, so the branch holds
 *   commits of its own that reached target only as patch-equivalents (a rebase
 *   or squash merge). No reflog is needed for this answer.
 * - `'new'`: the head is an ancestor and is still the commit the branch was
 *   created at (the oldest entry of its reflog), so it has no commits of its own.
 * - `'ancestry'`: the head is an ancestor and moved since creation.
 * - `null`: a read failed, or the reflog is empty (`git gc` expires every entry
 *   of a branch idle past `gc.reflogExpire`). Unknown, never "merged".
 *
 * @returns {Promise<'patch'|'new'|'ancestry'|null>}
 */
export async function readBranchLineage(dir, branch, head, target) {
  if (!dir || !branch || !COMMIT_SHA_RE.test(head || '') || !target) return null;
  const options = { ignoreExitCode: true };
  const ancestor = await execGit(['merge-base', '--is-ancestor', head, target], dir, options)
    .then(r => (r.exitCode === 0 ? true : r.exitCode === 1 ? false : null)).catch(() => null);
  if (ancestor === null) return null;
  if (!ancestor) return 'patch';
  const log = await execGit(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], dir, options).catch(() => null);
  if (log?.exitCode !== 0) return null;
  const created = log.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!COMMIT_SHA_RE.test(created || '')) return null;
  return created.toLowerCase() === head.toLowerCase() ? 'new' : 'ancestry';
}

/**
 * How long ago `branch` was created, from the oldest entry of its reflog, in ms.
 * Answers how long a branch with no commits of its own and no checkout has sat
 * unused. null when unreadable or the reflog is empty.
 *
 * @returns {Promise<number|null>}
 */
export async function readBranchAgeMs(dir, branch, nowMs = Date.now()) {
  if (!dir || !branch) return null;
  const log = await execGit(['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`, '--'], dir, { ignoreExitCode: true }).catch(() => null);
  if (log?.exitCode !== 0) return null;
  const seconds = Number(/@\{(\d+)\}$/.exec(log.stdout.trim().split('\n').filter(Boolean).at(-1) || '')?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(0, nowMs - seconds * 1000) : null;
}

/**
 * Whether `branch` is published: some configured remote has a remote-tracking
 * ref of the same name, or the branch's upstream resolves to an existing
 * remote-tracking ref (a branch may track one named differently). An upstream
 * that is a remote's default branch (its `<remote>/HEAD` target) is not
 * publication: `git worktree add -b x path origin/main` makes origin/main the
 * new branch's upstream, and reading that as published held every merged
 * claim checkout forever as `published-claim-unmerged`. Local refs only, so
 * it is safe inside an ownership section. null when unreadable.
 *
 * @returns {Promise<boolean|null>}
 */
export async function readBranchPublished(dir, branch) {
  if (!dir || !branch) return null;
  const lines = r => r.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const read = await Promise.all([
    execGit(['remote'], dir).then(lines),
    execGit(['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/'], dir).then(lines),
    // A pattern also matches refs nested under it, so the exact ref is picked below.
    execGit(['for-each-ref', '--format=%(refname)%00%(upstream)', `refs/heads/${branch}`], dir).then(lines),
  ]).catch(() => null);
  if (!read) return null;
  const [remotes, remoteRefs, heads] = read;
  const refs = remoteRefs.map(line => line.split('\0'));
  const tracking = new Set(refs.map(([ref]) => ref));
  const remoteDefaults = new Set(refs.filter(([ref, target]) => ref.endsWith('/HEAD') && target).map(([, target]) => target));
  const upstream = heads.map(line => line.split('\0')).find(([ref]) => ref === `refs/heads/${branch}`)?.[1] || null;
  const publishedUpstream = Boolean(upstream && tracking.has(upstream) && !remoteDefaults.has(upstream));
  return remotes.some(remote => tracking.has(`refs/remotes/${remote}/${branch}`)) || publishedUpstream;
}

/**
 * True means the merge probes found evidence; false means they did not establish
 * it, including missing inputs, self-comparison, unresolved refs, and probe failures.
 *
 * - Normal / ff / no-ff merge: the branch tip becomes reachable from target, so
 *   `git merge-base --is-ancestor` settles it immediately.
 * - Rebase-and-merge replays the branch commits as new SHAs; the original tip is
 *   not an ancestor, so we ask `git cherry` whether each branch commit has a
 *   patch-equivalent commit in target.
 * - Squash merge: the branch's commits are collapsed into a single NEW commit on
 *   target; synthesize a commit holding the branch's full tree on top of the
 *   merge-base and ask `git cherry` whether target contains that combined patch.
 *
 * Fails CLOSED: any git error (or unresolvable ref) returns false, so a detection
 * failure can never authorize a delete. This is the gate the merged-worktree
 * reaper relies on — see reapMergedWorktrees in worktreeManager.js.
 *
 * @param {string} dir - Repo working directory
 * @param {string} branch - Branch whose work we're checking (local name or ref)
 * @param {string} target - Branch it should be merged into (e.g. 'main')
 * @returns {Promise<boolean>}
 */
export async function hasBranchMergeEvidence(dir, branch, target, observedTips) {
  // Equal immutable commits prove inclusion; equal symbolic branch names do
  // not prove that a feature branch landed anywhere else.
  if (!branch || !target || (branch === target && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(branch))) return false;

  const readOptions = { ignoreExitCode: true, env: repoObservationEnv() };
  const resolveRef = ref => {
    if (observedTips?.has(ref)) return observedTips.get(ref);
    // A single-branch checkout can resolve the target outside refs/heads.
    // Resolve that shared target once for this scan. Mutation callers omit
    // the inventory and always read the current names.
    const read = execGit(['rev-parse', '--verify', `${ref}^{commit}`], dir, readOptions)
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
      .catch(() => null);
    observedTips?.set(ref, read);
    return read;
  };

  const [branchSha, targetSha] = await Promise.all([resolveRef(branch), resolveRef(target)]);
  if (!branchSha || !targetSha) return false;

  // Fast path: branch tip already reachable from target (normal / ff / no-ff merge,
  // or the branch carries no unique commits).
  const ancestor = await execGit(['merge-base', '--is-ancestor', branchSha, targetSha], dir, readOptions)
    .then(r => r.exitCode === 0)
    .catch(() => false);
  if (ancestor) return true;

  // Rebase/cherry-pick path: does target contain every branch commit as an
  // individual patch-equivalent commit?
  const individualCherry = await execGit(['cherry', targetSha, branchSha], dir, readOptions)
    .then(r => r.exitCode === 0 ? r.stdout.trim() : null)
    .catch(() => null);
  if (individualCherry === null) return false;
  if (individualCherry !== '' && individualCherry.split('\n').every(line => line.startsWith('-'))) {
    return true;
  }

  // Squash path: does target already contain the branch's combined patch?
  const mergeBase = await execGit(['merge-base', targetSha, branchSha], dir, readOptions)
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!mergeBase) return false;
  // No unique work beyond the merge base → nothing would be lost.
  if (mergeBase === branchSha) return true;

  const branchTree = await execGit(['rev-parse', `${branchSha}^{tree}`], dir, readOptions)
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!branchTree) return false;

  // Polling must not add dangling synthetic commits to the shared object store:
  // that invalidates an otherwise stable preservation snapshot. Both commands
  // use a private object directory with the original store as a read alternate.
  return probeCombinedPatch(dir, branchTree, mergeBase, targetSha, readOptions).catch(() => false);
}

async function probeCombinedPatch(dir, branchTree, mergeBase, targetSha, readOptions) {
  const objects = await execGit(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], dir, readOptions);
  if (objects.exitCode !== 0 || !objects.stdout.trim()) return false;
  const scratch = await mkdtemp(join(tmpdir(), 'portos-merge-probe-'));
  try {
    const options = { ...readOptions, env: { ...readOptions.env,
      GIT_OBJECT_DIRECTORY: scratch,
      // Git accepts C-quoted entries, including paths containing the platform
      // list separator, quotes or backslashes. Existing alternates remain valid.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [JSON.stringify(objects.stdout.trim()),
        readOptions.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter)
    } };
    // Preserve configured-identity behavior: an unavailable identity fails closed.
    const synthetic = await execGit(['commit-tree', branchTree, '-p', mergeBase, '-m', 'merged-check-probe'], dir, options);
    if (synthetic.exitCode !== 0 || !synthetic.stdout.trim()) return false;
    const result = await execGit(['cherry', targetSha, synthetic.stdout.trim()], dir, options);
    if (result.exitCode !== 0) return false;
    const lines = result.stdout.trim();
    return lines === '' || lines.split('\n').every(line => line.startsWith('-'));
  } finally {
    // Only this invocation's exclusively created scratch directory is removed.
    await rmGuarded(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
