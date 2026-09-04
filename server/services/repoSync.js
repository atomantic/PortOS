/**
 * Repo Sync — deterministic core for the `repo-sync` scheduled task.
 *
 * Walks every managed app's checkout (PortOS itself is one of them) and puts it
 * back in the state a fresh piece of work wants to start from: on the default
 * branch, level with origin in both directions, no leftover local branches or
 * worktrees, and an empty stash list.
 *
 * Two tiers, in the same shape branchReconcile.js uses:
 *
 *   Tier 1 (this module) — everything PROVABLE. Fetch, push branches that are
 *     strictly ahead of their upstream, fast-forward the default branch, return
 *     the checkout to the default branch when the branch it is on is already
 *     merged, delete merged branches/worktrees (delegated to
 *     `branchReconcile.reconcile`), and drop stash entries whose content is
 *     byte-identical to the default branch. No agent, no LLM call.
 *
 *   Tier 2 (the caller) — everything that needs JUDGMENT is returned as an
 *     `escalations` list for a coordinator CoS agent: a half-finished
 *     merge/rebase, uncommitted work of unknown provenance, a branch that has
 *     diverged from its upstream, unpushed commits with no PR, a stash that
 *     is NOT provably redundant. This module never spawns an agent, so it stays
 *     pure enough to unit-test.
 *
 * NOTHING here can lose work. Every mutating step is gated on a property that
 * makes it recoverable or a no-op:
 *   - push never uses `--force` and never runs on a branch that is behind.
 *   - the default branch only ever fast-forwards (`--ff-only`, or a
 *     `fetch origin <b>:<b>` refspec, which git itself refuses to non-FF).
 *   - the checkout only switches off a branch that is CLEAN and already merged.
 *   - branch/worktree deletion runs through branchReconcile's existing gates.
 *   - a stash is dropped only when every path it touches already has identical
 *     content on the default branch, i.e. applying it would produce no diff.
 * Anything that fails one of those gates is REPORTED, never forced.
 *
 * SCOPE BOUNDARY with branch-reconcile: this task reports an in-flight branch
 * (one that needs a PR opened, a conflict resolved, or a review driven) but does
 * NOT drive it. That is branch-reconcile's job, and it wraps the same classified
 * set in machinery this task has no equivalent of — the per-app openPr /
 * resolveConflicts / autoMerge / finishAbandoned toggles, per-agent batching, the
 * drain convergence guards, and the superseded ledger. Acting on those branches
 * here would bypass all of it, so the coordinator prompt names branch-reconcile
 * instead.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  execGitSafe, fetchOrigin, findActiveAgentInWorkspace, getBranch, getBranches,
  getDefaultBranch, getStatusPorcelain, isBranchMergedInto, isRepo
} from './git.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import {
  DEFAULT_REPO_SYNC_VERIFY_MODE, REPO_SYNC_ACTION_KEYS, REPO_SYNC_VERIFY_MODES, sanitizeTaskMetadata
} from '../lib/cosValidation.js';
import { stripManagedAgentOptionsFromOverride } from './taskScheduleRegistry.js';

// The action-toggle vocabulary lives in lib/cosValidation.js beside the
// allowlist that has to accept it — one list, so a new toggle cannot be added
// to the sanitizer and missed here (or vice versa). Re-exported at the address
// the generator reads it from.
export { REPO_SYNC_ACTION_KEYS };

/**
 * An action is ON unless the config explicitly set it to false (opt-out).
 *
 * Deliberately a local copy of `branchReconcile.actionOn` rather than an import:
 * that module is reached from here by a LAZY `import()` (its dependency graph
 * pulls in `gh`, the worktree manager, and the superseded ledger), and a static
 * import for a one-line predicate would put all of it back on this module's
 * startup graph. Keep the two in step if the opt-out convention ever changes.
 */
const actionOn = (actions, key) => actions?.[key] !== false;

/**
 * Escalation vocabulary. Kept as a frozen map (rather than bare strings at the
 * call sites) so the planner, the formatter, and the tests name the same set.
 */
export const ESCALATION_KINDS = Object.freeze({
  OPERATION_IN_PROGRESS: 'operation-in-progress',
  UNCOMMITTED_CHANGES: 'uncommitted-changes',
  DETACHED_HEAD: 'detached-head',
  DIVERGED_BRANCH: 'diverged-branch',
  DIVERGED_DEFAULT: 'diverged-default',
  UNPUSHED_BRANCH: 'unpushed-branch',
  OFF_DEFAULT_BRANCH: 'off-default-branch',
  STASH_ENTRIES: 'stash-entries',
  IN_FLIGHT_BRANCH: 'in-flight-branch',
  ORPHAN_REMOTE: 'orphan-remote',
  ACTION_FAILED: 'action-failed',
  AGENT_AT_WORK: 'agent-at-work',
  SCAN_FAILED: 'scan-failed'
});

/**
 * Half-finished git operations, mapped to the name a human would use. A repo in
 * any of these states is the "we hit a merge or rebase conflict" case: Tier 1
 * refuses to touch it at all (not even a fetch-driven fast-forward) and hands
 * the whole repo to the agent, because every safety property above assumes a
 * settled HEAD.
 *
 * Deliberately a superset of git.js's `SEQUENCER_STATE`, not a reuse of it: that
 * list answers "what does a forced checkout fail to clear?" (so it omits
 * `MERGE_HEAD`, which a checkout does clear) while this one answers "what makes
 * a repo unsafe to sync?". Same rows, different questions — a marker can belong
 * to one and not the other.
 */
const OPERATION_MARKERS = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect']
];

/**
 * Cap on how many paths one stash may touch and still be auto-classified. A
 * larger stash is reported instead: the `git diff --quiet <stash> <target> --
 * <paths>` probe below would otherwise build an argv long enough to hit the
 * platform limit, and a spawn that dies on E2BIG must not read as "not
 * superseded" for a reason that has nothing to do with the stash.
 */
export const MAX_STASH_PATHS_FOR_AUTO_CLASSIFY = 200;

/**
 * How many stashes are classified at once. Each costs 2–3 git spawns, and every
 * one of them is a rev-to-rev / tree-to-tree read — no index refresh, no
 * working-tree read, no lock — so they are safe to overlap. Bounded so a
 * checkout carrying dozens of stashes doesn't fork a hundred processes at once.
 */
const STASH_CLASSIFY_CONCURRENCY = 6;

// ============================================================
// Snapshot (Tier 1 reads)
// ============================================================

/**
 * The half-finished git operation this checkout is in, or null.
 * @param {string} repoPath
 * @returns {Promise<string|null>}
 */
async function detectOperationInProgress(repoPath) {
  const out = await execGitSafe(['rev-parse', '--git-dir'], repoPath, { ignoreExitCode: true });
  if (out.exitCode !== 0) {
    throw new Error(out.stderr || `could not inspect git operation state (exit code ${out.exitCode})`);
  }
  const raw = (out.stdout || '').trim();
  if (!raw) return null;
  const gitDir = isAbsolute(raw) ? raw : join(repoPath, raw);
  const found = OPERATION_MARKERS.find(([marker]) => existsSync(join(gitDir, marker)));
  return found ? found[1] : null;
}

/**
 * The TRACKED changed paths in a `git status --porcelain` dump — the set that
 * decides whether this checkout may be switched or fast-forwarded.
 *
 * Untracked entries are excluded because they do not block a branch switch (git
 * refuses only when a checkout would overwrite one, and that refusal is caught
 * and escalated) and are never discarded. This is the path-returning sibling of
 * git.js's `countDiscardable`, which applies the same filter for a count.
 *
 * Deliberately STRICTER than `worktreeManager.classifyWorktreeDirt`, which
 * treats lockfile-only churn as clean: that carve-out is right for deciding
 * whether an agent left real work behind, and wrong here — a regenerated
 * lockfile is still a tracked modification a branch switch would carry across.
 *
 * Pure.
 * @param {string} porcelain
 * @returns {string[]}
 */
export function dirtyTrackedPaths(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('??'))
    // Strip the status prefix, then take the post-rename name — `R  old -> new`
    // otherwise yields one path string naming two files.
    .map((line) => line.replace(/^\S+\s+/, '').split(' -> ').pop().trim())
    .filter(Boolean);
}

/**
 * Parse `git stash list --format=%gd%x1f%H%x1f%P%x1f%gs`. The parent count comes
 * along for free and tells us whether the entry even HAS an untracked-files
 * commit (a third parent, present only for `git stash -u`), which saves a
 * guaranteed-to-fail `ls-tree` spawn per ordinary stash.
 * Pure.
 * @param {string} stdout
 * @returns {{ref:string, sha:string, parentCount:number, message:string}[]}
 */
export function parseStashList(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter((parts) => parts.length >= 4 && parts[0].trim() && parts[1].trim())
    .map(([ref, sha, parents, ...rest]) => ({
      ref: ref.trim(),
      sha: sha.trim(),
      parentCount: parents.trim().split(/\s+/).filter(Boolean).length,
      message: rest.join('\x1f').trim()
    }));
}

/**
 * The paths a stash commit carries, kept in their two classes because each lives
 * in a DIFFERENT tree: the tracked changes are in the stash commit itself, while
 * the untracked snapshot a `git stash -u` captured is in its third parent. A
 * caller that flattens them and compares everything against the stash commit
 * would find an untracked path missing from BOTH sides and conclude the stash is
 * redundant — dropping work that only ever existed in `^3`.
 *
 * Fails CLOSED: an unreadable read yields `failed: true` rather than an empty
 * list, because "no paths" is the one answer that makes a stash look droppable.
 *
 * @param {string} repoPath
 * @param {string} sha - the stash commit
 * @param {number} parentCount - from `parseStashList`; 3 ⇒ carries untracked files
 * @returns {Promise<{tracked:string[], untracked:string[], failed:boolean}>}
 */
async function stashPaths(repoPath, sha, parentCount) {
  const hasUntracked = parentCount >= 3;
  const [tracked, untracked] = await Promise.all([
    execGitSafe(['diff', '--name-only', `${sha}^1`, sha], repoPath, { ignoreExitCode: true }),
    hasUntracked
      ? execGitSafe(['ls-tree', '-r', '--name-only', `${sha}^3`], repoPath, { ignoreExitCode: true })
      : Promise.resolve({ exitCode: 0, stdout: '' })
  ]);
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    return { tracked: [], untracked: [], failed: true };
  }
  const lines = (out) => out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { tracked: lines(tracked), untracked: lines(untracked), failed: false };
}

/**
 * Is this stash's content ALREADY what the default branch holds?
 *
 * The test is content equality on exactly the paths the stash touches: if every
 * one of them is byte-identical between the stash commit's tree and `target`,
 * then applying the stash there produces no diff, so dropping it cannot lose
 * anything. That is a strictly narrower (and provable) reading of the
 * "SUPERSEDED" classification the `stash-cleanup` prompt asks a model to make by
 * hand — everything this can't prove is left for that judgment call.
 *
 * Each path class is compared against the tree that HOLDS it — tracked changes
 * against the stash commit, the untracked snapshot against its third parent.
 * Comparing an untracked path against the stash commit would find it missing on
 * both sides and call the stash redundant, which is how this check would come to
 * delete the very work it exists to protect.
 *
 * Fails CLOSED in every direction: an unreadable path list, a too-large stash,
 * or a git error all yield `superseded: false`.
 *
 * @param {string} repoPath
 * @param {string} sha - the stash commit
 * @param {string} target - ref to compare against (origin/<default>, or <default>)
 * @param {number} [parentCount] - from `parseStashList`
 * @returns {Promise<{superseded:boolean, reason:string}>}
 */
export async function classifyStash(repoPath, sha, target, parentCount = 2) {
  const paths = await stashPaths(repoPath, sha, parentCount);
  if (paths.failed) return { superseded: false, reason: 'could not read the stash contents' };
  const total = paths.tracked.length + paths.untracked.length;
  if (total === 0) return { superseded: true, reason: 'empty stash (no changes recorded)' };
  if (total > MAX_STASH_PATHS_FOR_AUTO_CLASSIFY) {
    return { superseded: false, reason: `touches ${total} paths — too large to auto-classify` };
  }
  // Two probes, one per tree. A non-zero exit is "differs OR unreadable"; both
  // must keep the stash, so they share an answer.
  if (paths.tracked.length) {
    const diff = await execGitSafe(['diff', '--quiet', sha, target, '--', ...paths.tracked], repoPath, { ignoreExitCode: true });
    if (diff.exitCode !== 0) return { superseded: false, reason: `differs from ${target}` };
  }
  if (paths.untracked.length) {
    const diff = await execGitSafe(['diff', '--quiet', `${sha}^3`, target, '--', ...paths.untracked], repoPath, { ignoreExitCode: true });
    if (diff.exitCode !== 0) return { superseded: false, reason: `untracked content differs from ${target}` };
  }
  return { superseded: true, reason: `content identical to ${target} on all ${total} path(s)` };
}

/**
 * Read the whole checkout state one repo needs for a sync decision. Performs no
 * mutation beyond the fetch (which only writes remote-tracking refs).
 *
 * Issued in waves rather than one long serial chain: everything inside a wave is
 * an independent READ, and none of them contends for the index lock (`status` is
 * the only one that can take it, and nothing else in its wave wants it).
 *
 * @param {string} repoPath
 * @returns {Promise<object>} snapshot consumed by `planRepoSync`
 */
async function collectRepoState(repoPath) {
  if (!await isRepo(repoPath)) return { repoPath, isRepo: false };

  const [operationInProgress, origin] = await Promise.all([
    detectOperationInProgress(repoPath),
    getOriginInfo(repoPath)
  ]);
  const hasOrigin = Boolean(origin?.hasOrigin);

  // A repo mid-merge/rebase is reported and otherwise left completely alone —
  // fetching is harmless but every later read describes a transient tree, and
  // acting on it is exactly the case the user asked to route to an agent.
  //
  // Routed through git.js's `fetchOrigin`, not a raw `git fetch`: it retries an
  // `index.lock` collision and treats a lost compare-and-swap on refs another
  // PortOS surface already wrote as the success it is. Without that, a routine
  // concurrent fetch would surface here as `scan-failed` — and an escalation
  // dispatches the coordinator agent unconditionally, so a benign race would buy
  // a provider call on the one task built to avoid making them.
  let fetchError = null;
  if (hasOrigin && !operationInProgress) {
    fetchError = await fetchOrigin(repoPath, { prune: true }).then(() => null, (err) => err.message);
  }

  // EVERY read below feeds a safety decision, so a failure is recorded as such
  // rather than degrading into the value that happens to look safe. Left to
  // `.catch(() => '')`, an unreadable `git status` reads as a CLEAN tree, an
  // unreadable branch list as NO branches, and a failed stash list as NO stashes
  // — each of which unlocks a mutation the real state would have refused.
  const readFailures = [];
  const required = async (label, promise, fallback) => promise.catch((err) => {
    readFailures.push(`${label}: ${err.message}`);
    return fallback;
  });
  const [defaultBranch, headBranch, porcelain, branches, rawStashes, activeAgentId] = await Promise.all([
    required('default branch', getDefaultBranch(repoPath, { strict: true }), null),
    required('current branch', getBranch(repoPath), ''),
    required('working-tree status', getStatusPorcelain(repoPath), ''),
    required('branch list', getBranches(repoPath, { strict: true }), []),
    // The planner refuses to act on a repo mid-operation, so classifying its
    // stashes (2–3 git spawns each) buys nothing.
    operationInProgress
      ? Promise.resolve([])
      : execGitSafe(['stash', 'list', '--format=%gd%x1f%H%x1f%P%x1f%gs'], repoPath, { ignoreExitCode: true })
        .then((r) => {
          if (r.exitCode !== 0) {
            readFailures.push(`stash list: ${(r.stderr || '').trim().split('\n').slice(-1)[0] || 'git exited non-zero'}`);
            return [];
          }
          return parseStashList(r.stdout);
        }),
    // A lookup failure here must NOT read as "nobody is working in this
    // checkout" — that is the fact every mutating step below is gated on.
    required('active-agent lookup', findActiveAgentInWorkspace(repoPath, { includePaused: true, failClosed: true }), null)
  ]);

  if (!defaultBranch) readFailures.push('default branch: no default branch could be determined');

  const detached = headBranch === 'HEAD' || headBranch === '';
  const currentBranch = detached ? null : headBranch;
  const dirtyTracked = dirtyTrackedPaths(porcelain);
  const remoteDefault = hasOrigin ? `origin/${defaultBranch}` : null;
  const remoteResult = await execGitSafe(['remote'], repoPath, { ignoreExitCode: true });
  const remotes = remoteResult.exitCode === 0
    ? remoteResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  if (remoteResult.exitCode !== 0) {
    readFailures.push(`remote list: ${remoteResult.stderr || `git exited with code ${remoteResult.exitCode}`}`);
  }

  // How the LOCAL default branch stands against origin's copy — the number that
  // decides fast-forward vs "diverged, hand it to the agent". `getBranches`
  // already parsed `%(upstream:track)` for every local branch, so the common
  // case needs no extra spawn; the `rev-list` fallback covers a default branch
  // that tracks something other than `origin/<default>` (or nothing at all).
  const defaultEntry = branches.find((b) => b.name === defaultBranch);
  let defaultDivergence = null;
  if (remoteDefault) {
    defaultDivergence = defaultEntry?.tracking === remoteDefault
      ? { ahead: defaultEntry.ahead, behind: defaultEntry.behind }
      : await countAheadBehind(repoPath, defaultBranch, remoteDefault);
    if (!defaultDivergence) {
      readFailures.push(`default branch comparison: could not compare ${defaultBranch} with ${remoteDefault}`);
    }
  }

  // Compare stashes against origin's default when we have it (that is what the
  // branch will be after the fast-forward below) and the local default
  // otherwise, so an offline machine still gets a correct — just staler — answer.
  const stashTarget = remoteDefault && !fetchError ? remoteDefault : defaultBranch;

  // `getBranches` derives ahead/behind from `%(upstream:track)`, which is EMPTY
  // for a branch that was never pushed — so its `ahead` is 0 and the
  // unpushed-work escalation below could never fire for exactly the branches it
  // exists to catch. Measure those against the default branch instead. Bounded,
  // and only for the upstream-less ones, so a normal repo pays nothing.
  const localOnly = branches.filter((b) => !b.tracking && b.name !== defaultBranch);
  const localAheadByBranch = new Map(await mapWithConcurrency(localOnly, STASH_CLASSIFY_CONCURRENCY, async (b) => [
    b.name,
    (await countAheadBehind(repoPath, b.name, defaultBranch))?.ahead ?? null
  ]));
  for (const branch of localOnly) {
    if (localAheadByBranch.get(branch.name) === null) {
      readFailures.push(`local branch comparison for ${branch.name}: could not compare with ${defaultBranch}`);
    }
  }
  const branchesWithLocalAhead = branches.map((b) => (
    localAheadByBranch.has(b.name) ? { ...b, localAhead: localAheadByBranch.get(b.name) } : b
  ));

  const [stashes, currentBranchMerged] = await Promise.all([
    mapWithConcurrency(rawStashes, STASH_CLASSIFY_CONCURRENCY, async (entry) => ({
      ...entry,
      ...await classifyStash(repoPath, entry.sha, stashTarget, entry.parentCount)
        .catch(() => ({ superseded: false, reason: 'classification failed' }))
    })),
    // Is the branch we are standing on already landed? `getBranches` cannot
    // answer this — it computes `merged` with a `!b.current` guard, so the
    // CURRENT branch is always reported unmerged. Ask directly, against origin's
    // copy of the default branch when we have one (the local copy may not have
    // been fast-forwarded yet, which would read a landed branch as unmerged).
    // `isBranchMergedInto` also covers squash- and rebase-merges, and returns
    // true for a branch carrying no unique commits at all (a bare pointer
    // someone branched and never committed on).
    currentBranch && currentBranch !== defaultBranch
      ? isBranchMergedInto(repoPath, currentBranch, remoteDefault || defaultBranch).catch(() => false)
      : Promise.resolve(false)
  ]);

  return {
    repoPath,
    isRepo: true,
    hasOrigin,
    fetchError,
    readFailures,
    remotes,
    defaultBranch,
    remoteDefault,
    currentBranch,
    operationInProgress,
    dirtyTracked,
    branches: branchesWithLocalAhead,
    defaultDivergence,
    stashes,
    activeAgentId,
    currentBranchMerged
  };
}

/**
 * `{ahead, behind}` of `ref` relative to `base`, or null when either ref is
 * unreadable (a branch with no remote-tracking counterpart yet).
 * @param {string} repoPath
 * @param {string} ref
 * @param {string} base
 * @returns {Promise<{ahead:number, behind:number}|null>}
 */
async function countAheadBehind(repoPath, ref, base) {
  const out = await execGitSafe(['rev-list', '--left-right', '--count', `${base}...${ref}`], repoPath, { ignoreExitCode: true });
  if (out.exitCode !== 0) return null;
  const [behind, ahead] = (out.stdout || '').trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

// ============================================================
// Planner (PURE)
// ============================================================

/**
 * Decide what Tier 1 may do to this checkout and what has to go to the agent.
 * Pure — takes a snapshot, returns steps + escalations, touches nothing.
 *
 * @param {object} state - `collectRepoState` output
 * @param {object} [actions] - the per-app toggles (see REPO_SYNC_ACTION_KEYS)
 * @returns {{steps:object[], escalations:object[]}}
 */
export function planRepoSync(state, actions = {}) {
  const steps = [];
  const escalations = [];
  const escalate = (kind, detail) => escalations.push({ kind, detail });

  if (!state?.isRepo) return { steps, escalations };

  // Everything below decides what to MUTATE from what the snapshot observed, so
  // each of these three says "the snapshot is not a sound basis for that" and
  // returns no steps at all. Reporting without acting is always available; acting
  // on state we could not establish is what loses work.

  // A settled HEAD is the precondition for every safety property in this module.
  if (state.operationInProgress) {
    escalate(ESCALATION_KINDS.OPERATION_IN_PROGRESS,
      `a ${state.operationInProgress} is in progress — resolve it before this checkout can be synced`);
    return { steps, escalations };
  }

  // A read that failed leaves a fact missing, and every missing fact defaults to
  // the value that looks safe (clean tree, no branches, no stashes, no agent) —
  // precisely the values that unlock mutations. Refuse until the snapshot is whole.
  if (state.readFailures?.length) {
    for (const failure of state.readFailures) {
      escalate(ESCALATION_KINDS.SCAN_FAILED, `could not read ${failure} — no automatic action taken on this repo`);
    }
    return { steps, escalations };
  }

  if (state.hasOrigin !== true) {
    escalate(ESCALATION_KINDS.SCAN_FAILED,
      'no origin remote is configured — the repository cannot be synchronized automatically');
    return { steps, escalations };
  }

  // Somebody's agent is working in this checkout right now. Pushing its branch,
  // fast-forwarding under it, dropping its stashes, or reaping its worktrees all
  // race live work — the switch-back gate below is NOT enough on its own.
  if (state.activeAgentId) {
    escalate(ESCALATION_KINDS.AGENT_AT_WORK,
      `agent ${state.activeAgentId} is running in this checkout — left untouched`);
    return { steps, escalations };
  }

  // Without a successful fetch every remote-derived number is stale, so the
  // remote-dependent steps (push, fast-forward) would act on a guess. Report and
  // stop; the next run re-fetches.
  if (state.fetchError) {
    escalate(ESCALATION_KINDS.SCAN_FAILED,
      `could not fetch from origin (${state.fetchError}) — origin state is unknown, so no automatic action was taken`);
    return { steps, escalations };
  }

  const clean = state.dirtyTracked.length === 0;
  if (!clean) {
    escalate(ESCALATION_KINDS.UNCOMMITTED_CHANGES,
      `${state.dirtyTracked.length} uncommitted change(s) on ${state.currentBranch || 'a detached HEAD'}: ${state.dirtyTracked.slice(0, 10).join(', ')}`);
  }

  if (!state.currentBranch) {
    escalate(ESCALATION_KINDS.DETACHED_HEAD, 'HEAD is detached — no branch to sync or return from');
  }

  // --- push: a branch strictly AHEAD of its upstream is safe to publish. A
  // branch that is also behind has diverged (someone rewrote the remote, or a
  // peer pushed), and a non-forced push would just be rejected — that is a
  // judgment call, not a sync step.
  for (const branch of state.branches) {
    if (!branch.tracking) {
      // No upstream at all, so `ahead` is 0 by construction — the snapshot
      // measured these against the default branch instead (`localAhead`). A bare
      // pointer at the default tip is just cruft the merged-branch cleanup
      // handles; a branch with commits of its own is unreviewed work.
      if (branch.localAhead > 0 && !branch.isDefault) {
        escalate(ESCALATION_KINDS.UNPUSHED_BRANCH,
          `${branch.name} has ${branch.localAhead} commit(s) not on ${state.defaultBranch} and no upstream — never pushed, no PR`);
      }
      continue;
    }
    if (branch.ahead > 0 && branch.behind > 0) {
      escalate(ESCALATION_KINDS.DIVERGED_BRANCH,
        `${branch.name} is ${branch.ahead} ahead / ${branch.behind} behind ${branch.tracking} — needs a rebase or merge`);
      continue;
    }
    if (branch.ahead > 0 && actionOn(actions, 'syncPush')) {
      // A branch checked out in another worktree may belong to a live agent or
      // a human. Publishing it from the source checkout would race that work
      // and could expose an unfinished branch, so leave it for judgment. The
      // branch-reconcile pass has the worktree ownership gates needed to decide
      // whether that tree is safe to clean up later.
      if (branch.worktree) {
        escalate(ESCALATION_KINDS.IN_FLIGHT_BRANCH,
          `${branch.name} is checked out in another worktree — left untouched`);
        continue;
      }
      // The ahead count was measured against THIS branch's configured upstream,
      // so the push has to go there. `git push origin <local name>` would publish
      // to a different ref whenever the upstream is on another remote or carries
      // another name — landing commits somewhere nobody is watching while the
      // real upstream stays behind.
      const upstream = parseUpstream(branch.tracking, state.remotes);
      if (!upstream) {
        escalate(ESCALATION_KINDS.UNPUSHED_BRANCH,
          `${branch.name} is ${branch.ahead} ahead of ${branch.tracking}, whose remote is not one of this repo's (${state.remotes.join(', ') || 'none'}) — push it by hand`);
        continue;
      }
      steps.push({ kind: 'push', branch: branch.name, ahead: branch.ahead, remote: upstream.remote, remoteRef: upstream.ref });
    }
  }

  // --- return to the default branch. Only ever off a branch that is CLEAN and
  // whose commits are already in the default branch, so the switch can strand
  // nothing. A dirty tree, a live agent, or unmerged commits are all reported
  // instead: which of those the user wants done with the branch is precisely the
  // judgment this module refuses to make.
  const onDefault = state.currentBranch === state.defaultBranch;
  if (!onDefault && state.currentBranch) {
    if (!clean) {
      escalate(ESCALATION_KINDS.OFF_DEFAULT_BRANCH,
        `checkout is on ${state.currentBranch} with uncommitted changes — decide what to do with them before returning to ${state.defaultBranch}`);
    } else if (state.activeAgentId) {
      escalate(ESCALATION_KINDS.OFF_DEFAULT_BRANCH,
        `checkout is on ${state.currentBranch} and agent ${state.activeAgentId} is running in it — left alone`);
    } else if (state.currentBranchMerged !== true) {
      escalate(ESCALATION_KINDS.OFF_DEFAULT_BRANCH,
        `checkout is on ${state.currentBranch}, whose work is not in ${state.defaultBranch} yet — ship it before switching`);
    } else if (actionOn(actions, 'switchDefault')) {
      steps.push({ kind: 'switch-default', from: state.currentBranch, to: state.defaultBranch });
    }
  }

  // --- fast-forward the default branch. `behind > 0 && ahead === 0` is exactly
  // the fast-forwardable shape; anything else is a diverged local default, which
  // is never resolved automatically (it holds commits origin does not).
  const div = state.defaultDivergence;
  if (div && div.behind > 0 && div.ahead === 0 && actionOn(actions, 'syncPull')) {
    // A dirty tree only blocks the pull when the default branch is the one
    // checked out — a refspec fetch into a non-checked-out branch never touches
    // the working tree. No second escalation when it does block: the dirty tree
    // was already reported above, and reporting one problem twice inflates the
    // count that drives both the dispatch reason and the agent's stated workload.
    const willBeOnDefault = onDefault || steps.some((s) => s.kind === 'switch-default');
    if (!willBeOnDefault || clean) {
      steps.push({ kind: 'ff-default', branch: state.defaultBranch, behind: div.behind, checkedOut: willBeOnDefault });
    }
  }
  if (div && div.ahead > 0 && div.behind > 0) {
    escalate(ESCALATION_KINDS.DIVERGED_DEFAULT,
      `${state.defaultBranch} is ${div.ahead} ahead / ${div.behind} behind ${state.remoteDefault} — the default branch itself has diverged`);
  }

  // --- stashes. Only the provably-redundant ones are dropped; the rest are
  // named so the agent (or the `stash-cleanup` task) can judge them.
  const redundant = state.stashes.filter((s) => s.superseded);
  const keep = state.stashes.filter((s) => !s.superseded);
  if (actionOn(actions, 'dropStashes')) {
    // Descending index order: `git stash drop` renumbers everything BELOW the
    // entry it removes, so dropping the highest index first leaves every
    // still-pending ref valid. The executor re-verifies each sha anyway.
    for (const entry of [...redundant].sort((a, b) => stashIndex(b.ref) - stashIndex(a.ref))) {
      steps.push({ kind: 'drop-stash', ref: entry.ref, sha: entry.sha, reason: entry.reason });
    }
  }
  if (keep.length) {
    escalate(ESCALATION_KINDS.STASH_ENTRIES,
      `${keep.length} stash entr${keep.length === 1 ? 'y is' : 'ies are'} not provably redundant: `
      + keep.map((s) => `${s.ref} "${s.message}" (${s.reason})`).join('; '));
  }

  return { steps, escalations };
}

/**
 * Split a `%(upstream:short)` value (`origin/feature/x`) into the remote and the
 * branch name on it, or null when the leading segment is not one of this repo's
 * remotes. Remote names cannot contain `/`, so the first segment is the remote
 * and everything after it is the ref — which is what keeps a branch named
 * `feature/x` from being mistaken for a remote called `feature`. Pure.
 * @param {string} tracking
 * @param {string[]} remotes
 * @returns {{remote:string, ref:string}|null}
 */
export function parseUpstream(tracking, remotes = []) {
  const value = String(tracking || '');
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const remote = value.slice(0, slash);
  const ref = value.slice(slash + 1);
  if (!ref || !remotes.includes(remote)) return null;
  return { remote, ref };
}

/** Numeric index of a `stash@{N}` ref; -1 when unparseable. Pure. */
export function stashIndex(ref) {
  const m = /^stash@\{(\d+)\}$/.exec(String(ref || '').trim());
  return m ? Number.parseInt(m[1], 10) : -1;
}

// ============================================================
// Executor (Tier 1 writes)
// ============================================================

/**
 * Run one planned step. Never forces, never discards. A step that fails becomes
 * an `action-failed` escalation rather than throwing, because one stuck repo in
 * a sweep must not abort the others.
 *
 * @param {string} repoPath
 * @param {object} step
 * @returns {Promise<{ok:boolean, step:object, detail?:string}>}
 */
async function runStep(repoPath, step) {
  const fail = (detail) => ({ ok: false, step, detail });
  // One place that decides what "the step failed" means and how git's output is
  // summarized, so a fifth step kind can't invent a fifth answer.
  const attempt = async (args) => {
    const r = await execGitSafe(args, repoPath, { ignoreExitCode: true });
    return r.exitCode === 0 ? { ok: true, step } : fail((r.stderr + r.stdout).trim().split('\n').slice(-3).join(' '));
  };

  if (step.kind === 'push') return attempt(['push', step.remote, `${step.branch}:${step.remoteRef}`]);
  if (step.kind === 'switch-default') return attempt(['checkout', step.to]);

  if (step.kind === 'ff-default') {
    // Two shapes, both non-destructive by construction: `merge --ff-only`
    // refuses anything that is not a fast-forward, and a `<branch>:<branch>`
    // refspec fetch into a branch that is not checked out is refused by git for
    // the same reason.
    //
    // Which one applies is re-read from HEAD rather than taken from the plan's
    // `checkedOut` prediction. The prediction assumes the `switch-default` step
    // queued ahead of this one SUCCEEDED; if it did not (a checkout blocked by an
    // untracked file it would overwrite, say), `merge --ff-only origin/main`
    // would run while still on the feature branch and merge the default branch
    // INTO it — a real change to the wrong branch, from a step that is supposed
    // to be a no-op-or-fast-forward.
    const head = await getBranch(repoPath).catch(() => '');
    return attempt(head === step.branch
      ? ['merge', '--ff-only', `origin/${step.branch}`]
      : ['fetch', 'origin', `${step.branch}:${step.branch}`]);
  }

  if (step.kind === 'drop-stash') {
    // Re-resolve the ref before dropping: an earlier drop in this same run (or
    // anything else that touched the stash list since the scan) renumbers the
    // refs, and dropping the wrong index is the one irreversible mistake
    // available here. Mismatch ⇒ skip, and the next run re-classifies.
    const at = await execGitSafe(['rev-parse', step.ref], repoPath, { ignoreExitCode: true });
    if (at.stdout.trim() !== step.sha) {
      return fail(`${step.ref} no longer points at ${step.sha.slice(0, 8)} — skipped`);
    }
    return attempt(['stash', 'drop', step.ref]);
  }

  return fail(`unknown step kind '${step.kind}'`);
}

/**
 * Human-readable one-liner for a planned/performed step. Pure.
 * @param {object} step
 * @returns {string}
 */
export function describeStep(step) {
  switch (step.kind) {
    case 'push': return `pushed ${step.branch} (${step.ahead} commit(s)) to ${step.remote}/${step.remoteRef}`;
    case 'switch-default': return `switched checkout from ${step.from} to ${step.to}`;
    case 'ff-default': return `fast-forwarded ${step.branch} (${step.behind} behind origin)`;
    case 'drop-stash': return `dropped ${step.ref} — ${step.reason}`;
    default: return step.kind;
  }
}

/**
 * Sync ONE repo: snapshot → plan → execute → hand back what still needs a human
 * or an agent. Never throws; a scan that blows up is reported as a `scan-failed`
 * escalation so the sweep continues.
 *
 * @param {{repoPath:string, appId?:string, name?:string, actions?:object}} repo
 * @param {{activeAgentIds?:Set<string>}} [deps]
 * @returns {Promise<object>} per-repo result
 */
export async function syncRepo(repo, { activeAgentIds = new Set() } = {}) {
  const { repoPath, appId = null, name = repoPath, actions = {} } = repo;
  const base = { appId, name, repoPath, performed: [], escalations: [] };

  if (!repoPath || !existsSync(repoPath)) {
    return { ...base, missing: true, escalations: [{ kind: ESCALATION_KINDS.SCAN_FAILED, detail: `repo path does not exist: ${repoPath || '(unset)'}` }] };
  }

  const state = await collectRepoState(repoPath).catch((err) => ({ repoPath, isRepo: true, scanError: err.message }));
  if (state.scanError) {
    return { ...base, escalations: [{ kind: ESCALATION_KINDS.SCAN_FAILED, detail: state.scanError }] };
  }
  if (!state.isRepo) {
    return {
      ...base,
      notARepo: true,
      escalations: [{ kind: ESCALATION_KINDS.SCAN_FAILED, detail: 'managed app path is not a git repository' }]
    };
  }

  const { steps, escalations } = planRepoSync(state, actions);
  const performed = [];
  for (const step of steps) {
    const result = await runStep(repoPath, step);
    if (result.ok) {
      performed.push(describeStep(step));
    } else {
      escalations.push({
        kind: ESCALATION_KINDS.ACTION_FAILED,
        detail: `${describeStep(step)} FAILED: ${result.detail}`
      });
    }
  }

  // Merged-branch + worktree cleanup is branchReconcile's job and its safety
  // gates (locked worktrees, live claims, running agents, dirty trees) are the
  // ones this task wants — so delegate rather than re-derive them. Its
  // classified `inFlight` set is REPORTED, not driven: see the scope boundary in
  // the module header for why finishing those branches belongs to
  // branch-reconcile and not here.
  // Gated on the same facts the planner refuses to act without: reconcile
  // DELETES branches and worktrees, so an incomplete snapshot, a live agent, or
  // an unfetched origin must keep it out exactly as they keep out the steps above.
  const reconcileSafe = state.hasOrigin === true
    && Boolean(state.defaultBranch && state.remoteDefault)
    && !state.operationInProgress
    && !state.readFailures?.length
    && !state.activeAgentId
    && !state.fetchError;
  if (actionOn(actions, 'cleanupMerged') && reconcileSafe) {
    const { reconcile } = await import('./branchReconcile.js');
    const result = await reconcile(repoPath, {
      cleanup: true,
      reapRemotes: actions.reapRemotes === true,
      activeAgentIds
    }).catch((err) => {
      escalations.push({ kind: ESCALATION_KINDS.SCAN_FAILED, detail: `branch cleanup failed: ${err.message}` });
      return null;
    });
    if (result) {
      for (const branch of result.cleaned || []) performed.push(`deleted merged branch/worktree ${branch}`);
      for (const branch of result.reapedSuperseded || []) performed.push(`reaped superseded branch/worktree ${branch} (backed up)`);
      for (const entry of result.inFlight || []) {
        escalations.push({
          kind: ESCALATION_KINDS.IN_FLIGHT_BRANCH,
          detail: `${entry.branch} is ${entry.state} — unfinished work that has not landed on ${state.defaultBranch}`
        });
      }
      for (const entry of result.orphanRemotes?.reported || []) {
        const branch = typeof entry === 'string' ? entry : entry.branch;
        if (branch) {
          escalations.push({
            kind: ESCALATION_KINDS.ORPHAN_REMOTE,
            detail: `origin/${branch} exists on the remote with nothing local pointing at it`
          });
        }
      }
      for (const branch of result.orphanRemotes?.reaped || []) performed.push(`deleted merged orphan remote branch origin/${branch}`);
    }
  }

  return {
    ...base,
    defaultBranch: state.defaultBranch,
    currentBranch: state.currentBranch,
    performed,
    escalations
  };
}

/**
 * Sweep every repo in `repos`, sequentially. Sequential on purpose: these are
 * network + working-tree operations against the user's real checkouts, and a
 * parallel sweep interleaves push output and git index locks across repos that
 * may share a worktree parent.
 *
 * @param {{repoPath:string, appId?:string, name?:string, actions?:object}[]} repos
 * @param {{activeAgentIds?:Set<string>}} [deps]
 * @returns {Promise<object[]>}
 */
export async function syncRepos(repos, { activeAgentIds = new Set() } = {}) {
  const results = [];
  for (const repo of repos) {
    results.push(await syncRepo(repo, { activeAgentIds }));
  }
  return results;
}

// ============================================================
// Reporting
// ============================================================

/**
 * Roll a sweep up into the numbers the caller's dispatch decision needs. Pure.
 * @param {object[]} results
 * @returns {{repos:number, mutated:number, actionCount:number, escalated:number, escalationCount:number}}
 */
export function summarizeSync(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    repos: list.length,
    mutated: list.filter((r) => r.performed?.length).length,
    actionCount: list.reduce((n, r) => n + (r.performed?.length || 0), 0),
    escalated: list.filter((r) => r.escalations?.length).length,
    escalationCount: list.reduce((n, r) => n + (r.escalations?.length || 0), 0)
  };
}

/**
 * Whether a coordinator agent should be dispatched after this sweep.
 *
 * An escalation ALWAYS dispatches — that is the "hit a conflict / found
 * unfinished work" case the user asked to route to an agent. Beyond that the
 * verify mode decides, and the default (`when-changed`) buys the double-check
 * only for runs that actually changed something, so a scheduled sweep over an
 * already-clean machine makes no provider call at all. Pure.
 *
 * @param {object} summary - `summarizeSync` output
 * @param {string} [verifyMode]
 * @returns {{dispatch:boolean, reason:string}}
 */
export function shouldDispatchVerifier(summary, verifyMode = DEFAULT_REPO_SYNC_VERIFY_MODE) {
  if (summary.escalationCount > 0) {
    return { dispatch: true, reason: `${summary.escalationCount} unresolved item(s) across ${summary.escalated} repo(s)` };
  }
  const mode = REPO_SYNC_VERIFY_MODES.includes(verifyMode) ? verifyMode : DEFAULT_REPO_SYNC_VERIFY_MODE;
  if (mode === 'always') return { dispatch: true, reason: 'verify mode is `always`' };
  if (mode === 'when-changed' && summary.actionCount > 0) {
    return { dispatch: true, reason: `${summary.actionCount} action(s) applied across ${summary.mutated} repo(s) — verifying` };
  }
  return { dispatch: false, reason: mode === 'never' ? 'nothing to escalate (verify mode `never`)' : 'every repo was already in sync — nothing to verify' };
}

/**
 * Render the sweep as the `{repoSyncReport}` block injected into the coordinator
 * prompt. Pure.
 * @param {object[]} results
 * @param {{verifyReason?:string}} [opts]
 * @returns {string}
 */
export function formatRepoSyncReport(results, { verifyReason = '' } = {}) {
  const list = Array.isArray(results) ? results : [];
  const summary = summarizeSync(list);
  const lines = [
    '## Programmatic sync pass — already applied',
    '',
    `Swept ${summary.repos} repo(s): ${summary.actionCount} action(s) applied, ${summary.escalationCount} item(s) left for you.`,
  ];
  if (verifyReason) lines.push('', `Dispatched because: ${verifyReason}.`);

  for (const repo of list) {
    lines.push('', `### ${repo.name}${repo.appId ? ` (${repo.appId})` : ''}`, `- Path: \`${repo.repoPath}\``);
    if (repo.missing) { lines.push('- **Repo path does not exist.**'); continue; }
    if (repo.notARepo) { lines.push('- Not a git repository — skipped.'); continue; }
    lines.push(`- Branch: \`${repo.currentBranch || 'DETACHED'}\` (default: \`${repo.defaultBranch}\`)`);
    if (repo.performed.length) {
      lines.push('- Applied automatically:');
      for (const action of repo.performed) lines.push(`  - ${action}`);
    } else {
      lines.push('- Applied automatically: nothing (already in sync)');
    }
    if (repo.escalations.length) {
      lines.push('- **Needs your judgment:**');
      for (const esc of repo.escalations) lines.push(`  - \`${esc.kind}\` — ${esc.detail}`);
    } else {
      lines.push('- Needs your judgment: nothing');
    }
  }
  return lines.join('\n');
}

/**
 * The `{repoSyncReport}` block for a run whose deterministic sweep was WITHHELD
 * because the task requires approval. The sweep mutates checkouts, so running it
 * to build a report would be the very mutation the approval gate exists to hold —
 * the agent is told to do the whole job itself instead, once it is approved. Pure.
 * @param {{repoPath:string, appId?:string, name?:string}[]} targets
 * @returns {string}
 */
export function formatWithheldSweepReport(targets) {
  return [
    '## Programmatic sync pass — WITHHELD (this task requires approval)',
    '',
    'No automatic pass ran: it mutates checkouts, and this task is configured to',
    'require approval before that happens. **You are doing the whole sync yourself**,',
    'so treat the list below as your job, not as a verification pass.',
    '',
    'For each repository: fetch and prune, push any branch strictly ahead of its own',
    'configured upstream (never `--force`, never one that has diverged), fast-forward',
    'the default branch (`--ff-only` only), return the checkout to the default branch',
    'when the branch it is on is clean and already merged, delete branches and',
    'worktrees already merged into the default branch, and drop only stash entries',
    'whose content is already identical to the default branch. Skip — and report —',
    'any repository mid-merge/rebase or with an agent running in it.',
    '',
    ...(targets || []).map((t) => `- **${t.name}**${t.appId ? ` (${t.appId})` : ''} — \`${t.repoPath}\``)
  ].join('\n');
}

/**
 * Resolve the repos a sweep covers from the managed-app registry.
 *
 * OPT-OUT, not opt-in: the whole point of this task is "every managed app", so
 * an app is included unless it explicitly carries
 * `taskTypeOverrides['repo-sync'].taskMetadata.skipRepoSync === true`.
 *
 * Deliberately NOT the neighbouring `enabled` flag, and not
 * `isTaskTypeEnabledForApp`: both express the opt-IN convention the per-app
 * SCHEDULED tasks want, and `createApp` seeds `{ enabled: false }` for every
 * task type — so `enabled` cannot tell "leave this repo alone" apart from "never
 * configured", and either reading would sweep nothing at all on a fresh install.
 *
 * Apps with no `repoPath` are skipped silently — an app registered for process
 * management alone has no repo to sync. Two apps pointing at one checkout are
 * swept once.
 *
 * @param {object[]} apps - `getActiveApps()` output
 * @param {object} [actions] - schedule-level action toggles applied to each repo
 * @returns {{repoPath:string, appId:string, name:string, actions:object}[]}
 */
export function resolveSyncTargets(apps, actions = {}) {
  const seen = new Set();
  const targets = [];
  for (const app of apps || []) {
    const repoPath = app?.repoPath;
    if (!repoPath) continue;
    // This reads the RAW app record, so the override goes through the same two
    // steps a scheduled dispatch applies: drop the agent-options the task type
    // manages internally (they are locked, and would otherwise ride along into
    // the actions bag), then value-constrain what's left.
    const override = sanitizeTaskMetadata(
      stripManagedAgentOptionsFromOverride('repo-sync', app?.taskTypeOverrides?.['repo-sync']?.taskMetadata)
    ) || {};
    if (override.skipRepoSync === true) continue;
    const key = resolve(repoPath);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      repoPath,
      appId: app.id,
      name: app.name || app.id,
      // A per-app override may switch an individual action off for one repo
      // (e.g. leave one checkout's stashes alone) without opting the repo out.
      actions: { ...actions, ...override }
    });
  }
  return targets;
}
