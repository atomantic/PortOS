/** Ephemeral worktree creation, adoption and release of branch holders. */

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { claimBranchAdmission } from '../../lib/claimContinuation.js';
import { ensureDir, isPathInsideDir } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { hasProcessCwdInside } from '../../lib/processCwdProbe.js';
import { PROTECTED_BRANCHES } from '../../lib/gitArgs.js';
import { enforceSafeBranchUpstream } from '../../lib/branchUpstreamGuard.js';
import { forkRemoteName, normalizeForkHead, forkLocalBranch } from '../../lib/forkHead.js';
import { worktreeAgentId, worktreeOwnershipReason } from '../../lib/worktreeOwnership.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { decideCleanPushedDetach, decideIdleNextHolderRelease, decideWith } from '../branchRetirementDecision.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { WORKTREES_DIR, pathsEqual } from './paths.js';
import { linkWorktreeDependencies, unlinkWorktreeDependencies } from './dependencies.js';
import { addWorktreeWithRetry, isPreexistingRefError } from './gitErrors.js';
import { queueWorktreeCreate } from './mutationQueue.js';
import { forceRemoveWorktreeDir, discardLockfileChanges } from './remove.js';
import { classifyWorktreeDirt, listWorktrees } from './status.js';

/**
 * Delete a branch a failed `git worktree add -b/-B` left orphaned (a ref with
 * no worktree), so failed adds don't accumulate orphan branches (#2193).
 * Best-effort: every step swallows its own error. Only call for NEW-branch
 * adds — never for attach-to-existing-branch, which would delete a branch we
 * didn't create.
 *
 * Takes the causing error so it can:
 *   - SKIP entirely when the add failed because the branch already existed
 *     (`isPreexistingRefError`) — that branch pre-dated us and may hold real
 *     commits; deleting it would be data loss. This keys off the FIRST
 *     attempt's error (`err.firstAttemptError`), not the final one: a retried
 *     `-b` add that created the branch on attempt 1 then failed with a
 *     retry-induced `branch already exists` on attempt 2 must still clean up
 *     the orphan branch it created (#2193).
 *   - PRUNE before deleting: a partial add can register a stale worktree AND
 *     create the branch, so a bare `git branch -D` fails with "used by
 *     worktree". `worktree prune` first clears that registration so the delete
 *     succeeds.
 */
export async function cleanupOrphanBranch(repo, branchName, err) {
  if (!branchName) return;
  // The original failure cause decides whether the branch pre-dated us — a
  // later attempt's `already exists` can be self-inflicted by attempt 1.
  const causeError = err?.firstAttemptError || err;
  if (isPreexistingRefError(causeError?.message)) return;
  await execGit(['worktree', 'prune'], repo).catch(() => {});
  await execGit(['branch', '-D', branchName], repo).catch(pruneErr => {
    console.log(`⚠️ Orphan branch cleanup failed for ${branchName}: ${pruneErr.message}`);
  });
}

/**
 * Run the upstream guard on a branch whose worktree ALREADY exists, undoing the
 * add if the guard refuses (#4172).
 *
 * `enforceSafeBranchUpstream` throws when a branch's upstream still aims at a
 * foreign ref after repair — correct, because every downstream push helper would
 * land there. But the throw happens AFTER `git worktree add` succeeded, so
 * without this the caller gets a failed create while a registered worktree (and,
 * for a fresh `-b` add, an orphan branch) stays on disk: exactly the debris
 * `cleanupOrphanBranch` already prevents on the add itself.
 *
 * `deleteBranch` is false on the attach paths — that branch pre-dates this add
 * and may hold real commits, the same distinction `cleanupOrphanBranch` makes.
 */
export async function enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch, remoteBranch = branchName, forkRemote = null }) {
  const configure = async () => {
    if (forkRemote) {
      await execGit(['config', `branch.${branchName}.remote`, forkRemote], worktreePath);
      await execGit(['config', `branch.${branchName}.merge`, `refs/heads/${remoteBranch}`], worktreePath);
      await execGit(['config', `branch.${branchName}.pushRemote`, forkRemote], worktreePath);
    }
    return enforceSafeBranchUpstream(sourceWorkspace, branchName, { remoteBranch });
  };
  return configure().catch(async (err) => {
    const undone = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
      label: `Undoing worktree add for ${branchName} after an unsafe upstream`,
      log: 'all',
      subject: branchName,
    });
    // A branch still held by the surviving checkout cannot be deleted; leave it
    // rather than attempt a `branch -D` that fails. The ORIGINAL error is what
    // the caller sees either way — the rollback outcome never replaces it.
    if (deleteBranch && undone.removed) await cleanupOrphanBranch(sourceWorkspace, branchName, err);
    throw err;
  });
}

/**
 * Point a deterministic remote at the fork that holds a cross-repository PR's
 * head branch, fetch that branch, and hand back the remote's name.
 *
 * A fork PR's branch has no `origin/<branch>` — the forge exposes its tip only
 * as the read-only `refs/pull/<n>/head`, which cannot be pushed back to — so a
 * worktree attach needs a second address for it. The coordinates arrive from a
 * caller that already read the PR (`normalizeForkHead`); this layer never calls
 * a forge, which is why it takes a URL rather than a PR number.
 *
 * The remote is named from the OWNER, not from the run, so a second review
 * round or a retried remediation reuses it instead of accumulating one remote
 * per attach — and so teardown can leave it alone, which is what makes that
 * reuse free. An existing remote pointing somewhere else is re-pointed rather
 * than treated as a conflict.
 *
 * Returns `null` for every unusable outcome (no coordinates, remote wouldn't
 * take, fetch failed, ref still missing afterwards) so the caller falls through
 * to its existing origin-only error instead of attaching to a ref it cannot
 * verify.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {unknown} forkHead - `{ remoteUrl, ownerLogin }` from the PR read
 * @param {string} branchName - the PR's head branch, as named in the fork
 * @param {{requireRef?: boolean}} options - existing local recovery needs only the remote configuration
 * @returns {Promise<string|null>} the fork remote's name, or null
 */
async function ensureForkRemote(sourceWorkspace, forkHead, branchName, { requireRef = true } = {}) {
  const remoteName = await pointForkRemote(sourceWorkspace, forkHead, branchName);
  if (!remoteName) return null;

  await execGit(['fetch', remoteName, branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Fork fetch of ${remoteName}/${branchName} failed: ${err.message}`);
  });
  // Verify rather than trust the fetch's exit code: a fetch that reported
  // success but left no remote-tracking ref would otherwise send `worktree add`
  // at a start point git resolves somewhere else entirely.
  const refExists = await execGit(['rev-parse', '--verify', `${remoteName}/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  return refExists || !requireRef ? remoteName : null;
}

/** Add or re-point the deterministic fork remote; its name, or null. */
async function pointForkRemote(sourceWorkspace, forkHead, branchName) {
  const coordinates = normalizeForkHead(forkHead);
  if (!coordinates) return null;
  const remoteName = forkRemoteName(coordinates.ownerLogin);
  if (!remoteName) return null;

  // Three outcomes, not two: `null` is "no such remote" (add it), an equal URL
  // is "already correct" (touch nothing), and a different URL is a stale remote
  // from a contributor who renamed or moved their fork (re-point it).
  const existingUrl = await execGit(['remote', 'get-url', remoteName], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? (r.stdout || '').trim() : null))
    .catch(() => null);
  const remoteOp = existingUrl === null
    ? ['remote', 'add', remoteName, coordinates.remoteUrl]
    : (existingUrl === coordinates.remoteUrl ? null : ['remote', 'set-url', remoteName, coordinates.remoteUrl]);
  if (remoteOp) {
    const pointed = await execGit(remoteOp, sourceWorkspace).then(() => true).catch(err => {
      console.log(`⚠️ Could not point ${remoteName} at the fork holding ${branchName}: ${err.message}`);
      return false;
    });
    if (!pointed) return null;
  }
  return remoteName;
}

/** `err.code` when a pinned attach finds the branch tip is not the reviewed commit. */
export const PINNED_HEAD_MOVED = 'PINNED_HEAD_MOVED';

function requirePinnedHeadSha(value) {
  const sha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Invalid pinned head commit');
  return sha;
}

function pinnedHeadMoved(branchName, pinnedHead, actual) {
  const err = new Error(`Cannot attach worktree to ${branchName}: the branch is ${actual ? `at ${actual}` : 'gone'}, not the reviewed head ${pinnedHead}`);
  err.code = PINNED_HEAD_MOVED;
  err.actualHeadSha = actual || null;
  return err;
}

/**
 * Attach `branchName` from `remote` at exactly `pinnedHead`, the commit that was
 * reviewed — the attached code is then executed, so nothing else may land.
 *
 * The tip comes from the remote itself (`ls-remote`), never a cached tracking
 * ref, and a branch the remote no longer has is a moved head too. The fetch
 * names its destination so the tracking ref cannot stay stale under a narrow
 * refspec. The checkout uses the SHA, so a ref update after the check cannot
 * swap code in; an existing local branch must already name that exact commit.
 * `detach` checks the commit out with no branch at all (see `holdsCheckedOutBranch`).
 */
async function attachPinnedHead(sourceWorkspace, worktreePath, branchName, remoteBranch, remote, pinnedHead, localExists, { detach = false } = {}) {
  const listed = await execGit(['ls-remote', '--exit-code', remote, `refs/heads/${remoteBranch}`], sourceWorkspace, { ignoreExitCode: true });
  // `--exit-code` answers 2 for "no such ref"; anything else non-zero is a
  // transport failure, which proves nothing about the branch.
  if (listed.exitCode === 2) throw pinnedHeadMoved(branchName, pinnedHead, null);
  if (listed.exitCode !== 0) throw new Error(`Cannot attach worktree to ${branchName}: could not read ${remote}: ${(listed.stderr || '').trim()}`);
  const remoteTip = (listed.stdout || '').trim().split(/\s+/)[0];
  if (remoteTip !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, remoteTip);

  const trackingRef = `refs/remotes/${remote}/${remoteBranch}`;
  await execGit(['fetch', remote, `+refs/heads/${remoteBranch}:${trackingRef}`], sourceWorkspace);
  const fetched = (await execGit(['rev-parse', '--verify', `${trackingRef}^{commit}`], sourceWorkspace)).stdout.trim();
  if (fetched !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, fetched);

  if (detach) {
    await addWorktreeWithRetry(['worktree', 'add', '--detach', worktreePath, pinnedHead], sourceWorkspace);
  } else if (localExists) {
    const localHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)).stdout.trim();
    if (localHead !== pinnedHead) {
      throw new Error(`Cannot attach worktree to ${branchName}: the local branch differs from the reviewed head; preserving it without reset`);
    }
    await addWorktreeWithRetry(['worktree', 'add', worktreePath, branchName], sourceWorkspace);
  } else {
    await addWorktreeWithRetry(['worktree', 'add', '--no-track', '-b', branchName, worktreePath, pinnedHead], sourceWorkspace);
  }
  // A concurrent external ref write must not hand unreviewed code to the agent.
  const attached = (await execGit(['rev-parse', '--verify', 'HEAD'], worktreePath)).stdout.trim();
  if (attached !== pinnedHead) throw pinnedHeadMoved(branchName, pinnedHead, attached);
}

/**
 * Is `branch` one a second worktree must never attach to by name: the repository's
 * default branch, or whatever the primary checkout has checked out? Git refuses the
 * second case outright, and the first is the branch a review fix must never be
 * pushed to without its own pull request (a release PR's head IS the default branch).
 */
async function holdsCheckedOutBranch(sourceWorkspace, branch, baseBranch) {
  const { getDefaultBranch } = await import('../git.js');
  const defaultBranch = baseBranch || await getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null);
  if (branch === defaultBranch) return { held: true, isDefault: true };
  const current = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true }).catch(() => null))?.stdout?.trim();
  return { held: current === branch, isDefault: false };
}

/**
 * Detached worktree at the reviewed head of a branch the primary checkout owns.
 * The follow-up can read, test and gate that exact commit; with no branch checked
 * out there is nothing for `git push` to default to and nothing for another
 * worktree to collide with. Fork heads never come here: they attach under their
 * own `fork/<owner>/<branch>` name.
 */
async function attachDetachedHead(sourceWorkspace, worktreePath, branch, pinnedHead, fetchSucceeded) {
  if (pinnedHead) {
    await attachPinnedHead(sourceWorkspace, worktreePath, branch, branch, 'origin', pinnedHead, false, { detach: true });
    return pinnedHead;
  }
  const head = await execGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], sourceWorkspace, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '');
  if (!head) throw new Error(`Cannot attach worktree to ${branch}: origin/${branch} unavailable${fetchSucceeded ? '' : ' (fetch failed)'}`);
  await addWorktreeWithRetry(['worktree', 'add', '--detach', worktreePath, head], sourceWorkspace);
  return head;
}

/**
 * Create a git worktree for an agent.
 *
 * Creates a new branch and worktree directory that the agent can work in
 * without disturbing the main workspace.
 *
 * For managed apps, the worktree is based on the latest remote default branch
 * (main/master) to ensure a clean starting point free from other agents' changes.
 *
 * When `options.existingBranch` is provided, the worktree tracks that pre-existing
 * branch instead of creating a new one — used for the Copilot review-loop follow-up
 * agent that needs to address comments on a PR branch the previous agent just pushed.
 *
 * Fork heads resolve only through their fork and use a namespaced local branch.
 * Same-repository heads retain local → origin resolution.
 *
 * @param {string} agentId - The agent identifier (used for branch/directory naming)
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} taskId - Task identifier (included in branch name for traceability)
 * @param {object} options - Optional configuration
 * @param {string} options.baseBranch - Branch to base the worktree on (auto-detected if omitted)
 * @param {string} options.baseCommit - Exact server-owned source commit for a fresh Deep resume
 * @param {string} options.existingBranch - Pre-existing branch to attach (creates from origin/<branch> if no local copy). When it is the default branch or the primary checkout's own branch the worktree is DETACHED at the branch's reviewed head instead (`detached: true` in the result).
 * @param {string} options.resumeBranch - Exact preserved local branch from a retry, including pre-namespace fork branches
 * @param {{remoteUrl: string, ownerLogin: string}} options.forkHead - Where `existingBranch` lives for a fork PR; checked out as fork/<owner>/<branch>.
 * @param {string} options.expectedHeadSha - Attach only at the reviewed remote tip; existing local work is never reset.
 * @param {string} options.planId - PLAN.md item slug ID — when provided, spliced into the branch name as `cos/<taskId>/<planId>/<agentId>` so other agents can detect this item is in flight by scanning branches/PRs
 * @param {boolean} options.linkDependencies - Link source dependencies unless explicitly false
 * @returns {{ worktreePath: string, branchName: string, baseBranch: string|null, existingBranch?: boolean }} paths for the new worktree
 */
export async function createWorktree(agentId, sourceWorkspace, taskId, options = {}) {
  // Serialize per source repo so two adds in the same evaluation tick can't
  // race on git's per-repo worktree lock (#2193). The whole body runs inside
  // the tail — not just the add — because the leading `git fetch origin` also
  // touches the shared ref store and two concurrent fetches on the same repo
  // can themselves hit `cannot lock ref` contention. Same-repo spawn prep is
  // low-frequency (a handful of tasks per tick), so serializing the fetch is a
  // cheap, safe trade for the race guarantee. See queueWorktreeCreate.
  return queueWorktreeCreate(sourceWorkspace, () => createWorktreeUnlocked(agentId, sourceWorkspace, taskId, options));
}

async function createWorktreeUnlocked(agentId, sourceWorkspace, taskId, options = {}) {
  if (!existsSync(WORKTREES_DIR)) {
    await ensureDir(WORKTREES_DIR);
  }

  const worktreePath = join(WORKTREES_DIR, agentId);

  // Stamp the producing machine's federation identity onto the worktree
  // metadata (issue #1563, acceptance criterion 1). The branch is named
  // `cos/<taskId>/<agentId>`, so recording which instance created it lets a
  // federated node pair attribute every worktree/branch to its origin instance
  // once CoS history federates. `ensureInstanceId()` creates the identity on the
  // cold path so the worktree is never tagged `unknown`.
  const instanceId = await ensureInstanceId();

  // Fetch latest from origin so we base off up-to-date refs
  const fetchSucceeded = await execGit(['fetch', 'origin'], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Worktree fetch failed (will use local refs): ${err.message}`);
      return false;
    });

  // Existing-branch path: attach the worktree to a branch that already lives on
  // the remote (e.g. the PR branch from the previous agent in a review loop).
  if (options.existingBranch) {
    const remoteBranch = options.existingBranch;
    const pinnedHead = options.expectedHeadSha === undefined ? null : requirePinnedHeadSha(options.expectedHeadSha);
    const forkHead = normalizeForkHead(options.forkHead);
    if (options.forkHead && !forkHead) throw new Error('Invalid fork head coordinates');
    const checkedOut = forkHead || options.resumeBranch
      ? { held: false, isDefault: false }
      : await holdsCheckedOutBranch(sourceWorkspace, remoteBranch, options.baseBranch);
    if (checkedOut.held) {
      const headSha = await attachDetachedHead(sourceWorkspace, worktreePath, remoteBranch, pinnedHead, fetchSucceeded);
      if (options.linkDependencies === false) {
        await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
      } else {
        await linkWorktreeDependencies(sourceWorkspace, worktreePath);
      }
      console.log(`🌳 Created detached worktree for ${agentId} at ${worktreePath} on ${remoteBranch}@${headSha.slice(0, 12)} (primary checkout holds the branch)`);
      return {
        worktreePath, branchName: remoteBranch, baseBranch: null, existingBranch: true, instanceId,
        detached: true, headSha, headIsDefaultBranch: checkedOut.isDefault,
      };
    }
    const branchName = options.resumeBranch || forkLocalBranch(remoteBranch, forkHead);
    const localExists = (await execGit(['branch', '--list', branchName], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
    if (options.resumeBranch && !localExists) throw new Error(`Cannot resume missing local branch ${branchName}`);
    // A pin must be verified against the fork itself, never origin's same-named branch.
    const forkRemote = forkHead ? await (pinnedHead ? pointForkRemote(sourceWorkspace, forkHead, remoteBranch)
      : ensureForkRemote(sourceWorkspace, forkHead, remoteBranch, { requireRef: !localExists })) : null;
    if (forkHead && !forkRemote) throw new Error(`Cannot attach worktree to fork branch ${remoteBranch}: fork ref unavailable`);
    if (pinnedHead) {
      await attachPinnedHead(sourceWorkspace, worktreePath, branchName, remoteBranch, forkRemote || 'origin', pinnedHead, !!localExists);
    } else if (localExists) {
      // Preserve unpublished local work. Never reset an existing checkout branch.
      await addWorktreeWithRetry(['worktree', 'add', worktreePath, branchName], sourceWorkspace);
    } else {
      const startPoint = forkRemote ? `${forkRemote}/${remoteBranch}` : `origin/${remoteBranch}`;
      const remoteExists = forkRemote || await execGit(['rev-parse', '--verify', startPoint], sourceWorkspace, { ignoreExitCode: true })
        .then(r => r.exitCode === 0).catch(() => false);
      if (!remoteExists) throw new Error(`Cannot attach worktree to ${branchName}: branch missing locally and origin/${branchName} unavailable${fetchSucceeded ? '' : ' (fetch failed)'}`);
      await addWorktreeWithRetry(['worktree', 'add', ...(forkRemote ? ['--no-track', '-b'] : ['-B']), branchName, worktreePath, startPoint], sourceWorkspace);
    }
    await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, {
      deleteBranch: false, remoteBranch, forkRemote: forkRemote || (pinnedHead ? 'origin' : null),
    });
    if (options.linkDependencies === false) {
      await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
    } else {
      await linkWorktreeDependencies(sourceWorkspace, worktreePath);
    }
    console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} on existing branch ${branchName}`);
    return { worktreePath, branchName, baseBranch: null, existingBranch: true, instanceId };
  }

  const branchName = options.planId
    ? `cos/${taskId}/${options.planId}/${agentId}`
    : `cos/${taskId}/${agentId}`;

  // Determine the base: explicit option > remote default branch > current HEAD
  let baseBranch = options.baseBranch;
  if (!baseBranch) {
    const { getDefaultBranch } = await import('../git.js');
    baseBranch = await getDefaultBranch(sourceWorkspace, { allowRemote: fetchSucceeded }).catch(() => null);
    if (!baseBranch) {
      baseBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace)).stdout.trim();
    }
  }

  // Prefer the remote ref (freshest state) if available
  let baseRef;
  if (options.baseCommit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.baseCommit)) throw new Error('Invalid pinned source commit');
    // Missing pins fail closed; falling back to moving main would erase coverage.
    baseRef = (await execGit(['rev-parse', '--verify', `${options.baseCommit}^{commit}`], sourceWorkspace)).stdout.trim();
  } else {
    baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
      .then(() => `origin/${baseBranch}`)
      .catch(() => baseBranch);
  }

  // Create worktree with a new branch based on the latest default branch.
  // `--no-track` is load-bearing, not tidiness (#4172): `baseRef` is normally the
  // remote-tracking `origin/<default>`, and git's default `branch.autoSetupMerge`
  // would record `branch.<name>.merge = refs/heads/main` on the new branch. Push
  // helpers derive their destination from that config — `/do:pr` pushes
  // `HEAD:$(git config branch.<name>.merge)` — so the agent's work lands straight
  // on main, skipping the PR. Untracked is what makes `git push -u origin <branch>`
  // the correct path. See lib/branchUpstreamGuard.js.
  // On final failure, delete the partially-created branch so a failed add
  // doesn't leave an orphan branch with no worktree (#2193).
  await addWorktreeWithRetry(
    ['worktree', 'add', '--no-track', '-b', branchName, worktreePath, baseRef],
    sourceWorkspace
  ).catch(async (err) => {
    await cleanupOrphanBranch(sourceWorkspace, branchName, err);
    throw err;
  });

  // Backstop the flag above — an older git, or a repo-level `branch.autoSetupMerge`
  // setting, must not be able to hand an agent a branch aimed at the default branch.
  await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, worktreePath, { deleteBranch: true });
  if (options.linkDependencies === false) {
    await unlinkWorktreeDependencies(sourceWorkspace, worktreePath);
  } else {
    await linkWorktreeDependencies(sourceWorkspace, worktreePath);
  }

  console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} (branch: ${branchName}, base: ${baseRef})`);

  return { worktreePath, branchName, baseBranch, instanceId };
}

/**
 * Locate the worktree that currently holds `branchName`, when it is one PortOS
 * may take over — i.e. a tree `adoptWorktree` could legitimately move.
 *
 * `git worktree add` refuses to attach a second tree to a checked-out branch, so
 * a task pointed at an existing branch (a review-loop/merge follow-up, a resume)
 * cannot start while another tree holds it. Usually that holder is the finished
 * run's own worktree, still there because `removeWorktree` won't delete a dirty
 * tree — and it IS that branch's workspace, so adopting it is both the fastest
 * path and the one that preserves the leftover work. Waiting for a teardown that
 * is never coming just strands the pull request the follow-up exists to land.
 *
 * Refuses (returns null) for every holder PortOS doesn't own outright, because
 * adoption MOVES the directory:
 *   - the primary checkout, or any tree outside `data/cos/worktrees/` — moving
 *     the user's own checkout out from under them is exactly the branch-jacking
 *     guarded against everywhere else;
 *   - a human `/claim` tree (`claim-*`), owned by the claim flow's cleanup —
 *     unless the caller passes `allowLiveClaim` (see below);
 *   - a tree whose agent is still running — it is mid-edit in that directory;
 *   - a locked worktree, whose lock means "don't touch" regardless of owner.
 *
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} branchName - branch to find a holder for (no `refs/heads/`)
 * @param {object} [options]
 * @param {Set<string>} [options.activeAgentIds] - agents currently running
 * @param {string} [options.preferredPath] - cached holder path to validate first
 * @param {boolean} [options.allowLiveClaim=false] - recover a claim holder only
 *   after the supplied full registry passes branch/repository owner admission.
 * @param {Array<object>|null} [options.agents] - required for claim recovery
 * @param {string|null} [options.requestingAgentId] - the requesting run, not its predecessor
 * @returns {Promise<{ path: string, agentId: string }|null>}
 */
export async function findAdoptableWorktreeForBranch(sourceWorkspace, branchName, {
  activeAgentIds = new Set(),
  preferredPath = null,
  allowLiveClaim = false,
  agents = null,
  requestingAgentId = null,
} = {}) {
  if (!sourceWorkspace || !branchName) return null;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!worktrees) return null;
  if (allowLiveClaim && !claimBranchAdmission({
    branchName, preferredPath, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  // Git permits one holder per branch. A resume pointer is merely a cache of that
  // answer, so validate it against the current worktree list first and then fall
  // back to discovery when the cached path went stale or was moved.
  const holders = worktrees.filter(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  const holder = preferredPath
    ? holders.find(wt => pathsEqual(wt.path, preferredPath)) || holders[0]
    : holders[0];
  if (!holder?.path) return null;

  const agentId = worktreeAgentId(holder.path);
  const ownershipReason = worktreeOwnershipReason({
    path: holder.path,
    locked: holder.locked,
    activeAgentIds,
    roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
    requireKnownLiveness: true,
    allowLiveClaim,
  });
  if (ownershipReason) return null;

  return { path: holder.path, agentId };
}

// How long a sibling `/do:next` tree must sit untouched before a follow-up may
// release its branch. An agent that finished and kept its tree (waiting on CI,
// say) goes quiet for far longer; owner admission must pass independently.
export const SIBLING_NEXT_HOLDER_IDLE_MS = 10 * 60 * 1000;

/**
 * Free `branchName` from an idle slashdo `/do:next` worktree that sits OUTSIDE
 * `data/cos/worktrees/`, by DETACHING that tree's HEAD in place.
 *
 * `/do:next` cuts `next/<slug>` into a sibling directory of the repo
 * (`../next-issue-<n>`). A run that finished but kept its tree still holds the
 * branch, and the review-loop follow-up for that PR then cannot `worktree add`
 * it — adoption refuses any tree outside the managed root, so the follow-up
 * waits out its whole `worktree-busy` budget and blocks. Unlike adoption this
 * never moves or deletes the directory: a detached HEAD at the same commit keeps
 * every file, and `git switch <branch>` restores it.
 *
 * Refuses (returns false) unless ALL hold: the branch is `next/…`; the holder is
 * a linked worktree (never the primary checkout) outside the managed root,
 * unlocked; the readable registry has no branch/repository owner or running/paused
 * agent inside it; nothing in it changed for `idleMs`; the tree is clean, untracked files included
 * (unless `allowUntracked`: a detach leaves untracked files exactly where they are, so a
 * coordinator follow-up may take over a tree whose only dirt is stray untracked files such as
 * Finder "name 2.js" duplicates — tracked or staged changes still refuse); and HEAD is already on
 * the remote, so nothing is left only in that tree.
 *
 * @param {string} sourceWorkspace
 * @param {string} branchName
 * @param {{ activeWorkspacePaths?: string[], agents?: object[], requestingAgentId?: string, idleMs?: number, nowMs?: number, allowUntracked?: boolean }} [options]
 * @returns {Promise<{ path: string }|null>} the released holder, or null
 */
export async function releaseIdleSiblingNextHolder(sourceWorkspace, branchName, options = {}) {
  if (!sourceWorkspace || !branchName?.startsWith('next/')) return null;
  return withGitMutationLifetime(() => releaseIdleSiblingNextHolderAdmitted(sourceWorkspace, branchName, options));
}

async function releaseIdleSiblingNextHolderAdmitted(sourceWorkspace, branchName, {
  activeWorkspacePaths = [],
  agents = null,
  requestingAgentId = null,
  idleMs = SIBLING_NEXT_HOLDER_IDLE_MS,
  nowMs = Date.now(),
  allowUntracked = false,
} = {}) {
  if (!sourceWorkspace || !branchName?.startsWith('next/')) return null;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!claimBranchAdmission({
    branchName, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  const holderIndex = worktrees.findIndex(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  // Index 0 is the main worktree — the user's own checkout is never released.
  const holder = worktrees[holderIndex];
  const decision = await decideWith(facts => decideIdleNextHolderRelease({
    branchName, holderIndex, holder: { ...holder, exists: holder.path ? existsSync(holder.path) : false }, worktreesDir: WORKTREES_DIR,
    activeWorkspacePaths, samePath: pathsEqual, idleMs, nowMs, allowUntracked, facts,
  }), {
    // Idleness first: the status read below could otherwise refresh the index and reset the clock.
    lastTouchMs: () => readHolderLastTouchMs(holder.path),
    ...cleanPushedReaders(holder.path, branchName),
  });
  if (!decision.admit) return null;
  if (!await detachHolder(holder.path, branchName)) return null;
  console.log(`🌳 Released ${branchName} from idle /do:next worktree ${holder.path} (HEAD detached in place)`);
  return { path: holder.path };
}

/**
 * Detach `holderPath`'s HEAD in place iff the tree holds nothing the branch ref
 * does not: tracked/staged state clean (untracked files too unless
 * `allowUntracked`; git-ignored caches never count) and HEAD already on the
 * remote. A detached HEAD keeps every file where it is and `git switch <branch>`
 * restores it. Any unreadable check refuses (false).
 */
async function detachCleanPushedHolder(holderPath, branchName, { allowUntracked = false } = {}) {
  // Stricter than `classifyWorktreeDirt` on purpose: this tree isn't PortOS's,
  // so no path counts as disposable scratch.
  const decision = await decideWith(facts => decideCleanPushedDetach({ allowUntracked, facts }), cleanPushedReaders(holderPath, branchName));
  return decision.admit ? detachHolder(holderPath, branchName) : false;
}

/** Newest mtime of the git-dir files a commit, checkout or index refresh touches; null when the git directory is unreadable. */
async function readHolderLastTouchMs(holderPath) {
  const gitDir = await execGit(['rev-parse', '--absolute-git-dir'], holderPath).then(r => r.stdout.trim(), () => null);
  if (!gitDir) return null;
  const mtimes = await Promise.all(['index', 'HEAD', join('logs', 'HEAD')]
    .map(f => stat(join(gitDir, f)).then(s => s.mtimeMs, () => 0)));
  return Math.max(...mtimes);
}

// `--no-optional-locks` keeps `status` from refreshing the index and so resetting the idle clock.
const cleanPushedReaders = (holderPath, branchName) => {
  const git = (args) => execGit(args, holderPath).then(r => r.stdout.trim());
  return {
    porcelain: () => git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']).catch(() => null),
    remoteRef: () => git(['rev-parse', '--verify', '--quiet', `${branchName}@{upstream}`])
      .catch(() => git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`]))
      .catch(() => null),
    pushed: ({ remoteRef }) => execGit(['merge-base', '--is-ancestor', 'HEAD', remoteRef], holderPath).then(() => true, () => false),
  };
};

const detachHolder = (holderPath, branchName) => execGit(['switch', '--detach', '--quiet'], holderPath).then(() => true, (err) => {
  console.warn(`⚠️ Could not detach ${holderPath} to release ${branchName}: ${err.message}`);
  return false;
});

/**
 * Free `branchName` from a worktree PortOS did not create and nothing owns
 * anymore — typically one a terminal agent session cut under its own scratchpad
 * and left behind after pushing its PR (#12845). Detaches the holder in place
 * (never moves or deletes it), so no content can be lost; the caller then
 * retries `git worktree add`.
 *
 * Refuses (null) unless ALL hold, each failing closed when unreadable: the
 * holder is a linked worktree (never the primary checkout) OUTSIDE the managed
 * `data/cos/worktrees/` root, unlocked, with no branch/repository owner or
 * running/paused agent registered in or on it; no process has its cwd inside it
 * (`hasProcessInside`); it is clean (git-ignored caches excepted) and its HEAD
 * is already on the remote.
 *
 * @param {string} sourceWorkspace
 * @param {string} branchName
 * @param {{ activeWorkspacePaths?: string[], agents?: object[]|null, requestingAgentId?: string, hasProcessInside?: (dir: string) => Promise<boolean> }} [options]
 * @returns {Promise<{ path: string }|null>} the released holder, or null
 */
export async function releaseOwnerlessForeignHolder(sourceWorkspace, branchName, options = {}) {
  if (!sourceWorkspace || !branchName || PROTECTED_BRANCHES.includes(branchName)) return null;
  return withGitMutationLifetime(() => releaseOwnerlessForeignHolderAdmitted(sourceWorkspace, branchName, options));
}

async function releaseOwnerlessForeignHolderAdmitted(sourceWorkspace, branchName, {
  activeWorkspacePaths = [],
  agents = null,
  requestingAgentId = null,
  hasProcessInside = hasProcessCwdInside,
} = {}) {
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
  if (!claimBranchAdmission({
    branchName, agentId: requestingAgentId, sourceWorkspace, worktrees, agents,
  }).admit) return null;
  const holderIndex = worktrees.findIndex(wt => wt.branch?.replace('refs/heads/', '') === branchName);
  // Index 0 is the main worktree — the user's own checkout is never released.
  if (holderIndex <= 0) return null;
  const holder = worktrees[holderIndex];
  if (holder.locked || holder.prunable || !existsSync(holder.path)) return null;
  // Managed trees have their own owners and reapers (adoption, claim cleanup).
  if (isPathInsideDir(WORKTREES_DIR, holder.path)) return null;
  if (activeWorkspacePaths.some(p => p && (pathsEqual(p, holder.path) || isPathInsideDir(holder.path, p)))) return null;
  if (await hasProcessInside(holder.path).catch(() => true)) return null;
  if (!await detachCleanPushedHolder(holder.path, branchName)) return null;
  console.log(`🌳 Released ${branchName} from ownerless foreign worktree ${holder.path} (HEAD detached in place)`);
  return { path: holder.path };
}

/**
 * Adopt an INTERRUPTED agent's surviving worktree on behalf of the agent that is
 * retrying its task, instead of building a fresh one from the default branch.
 *
 * When an agent dies without completing (a server restart is the common case —
 * PM2 kills the PTY, so no completion hook ever runs), `removeWorktree` refuses to
 * delete a dirty tree and leaves the whole worktree in place. That tree holds the
 * dead run's uncommitted edits and untracked files, which no branch pointer can
 * carry: without adoption the retry starts from origin/main and redoes the work.
 *
 * The tree is MOVED to the retry's own `<worktrees>/<agentId>` directory rather
 * than adopted where it sits, because "directory name == the agent that owns this
 * tree" is the invariant `cleanupOrphanedWorktrees` reaps on — left at the dead
 * agent's path, the live retry's worktree would be reaped out from under it. The
 * move carries tracked edits, untracked files, and git's own bookkeeping intact.
 *
 * Returns null (never throws) whenever adoption isn't possible — the source tree
 * is gone, the target path is occupied, or git refuses the move (a locked worktree,
 * or one with initialized submodules), or its status suggests a partial removal.
 * The refused tree and branch stay intact for recovery: a fresh attachment to
 * that same branch will remain blocked while this checkout holds it.
 *
 * @param {string} agentId - the RETRYING agent (names the destination directory)
 * @param {string} sourceWorkspace - the parent git repository
 * @param {string} existingWorktreePath - absolute path of the dead agent's worktree
 * @param {string} branchName - the branch that worktree has checked out
 * @returns {Promise<{worktreePath: string, branchName: string, baseBranch: null, existingBranch: true, adopted: true, instanceId: string}|null>}
 */
export async function adoptWorktree(agentId, sourceWorkspace, existingWorktreePath, branchName, options = {}) {
  return queueWorktreeCreate(sourceWorkspace, () => adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName, options));
}

async function adoptWorktreeUnlocked(agentId, sourceWorkspace, existingWorktreePath, branchName, options) {
  if (!agentId || !sourceWorkspace || !existingWorktreePath || !branchName) return null;
  if (!existsSync(existingWorktreePath)) {
    console.log(`🌳 Cannot adopt worktree for ${agentId} — ${existingWorktreePath} no longer exists`);
    return null;
  }

  const targetPath = join(WORKTREES_DIR, agentId);
  const instanceId = await ensureInstanceId();
  const adopted = {
    worktreePath: targetPath, branchName, baseBranch: null,
    existingBranch: true, adopted: true, instanceId
  };

  if (!pathsEqual(existingWorktreePath, targetPath) && existsSync(targetPath)) {
    console.log(`🌳 Cannot adopt worktree for ${agentId} — ${targetPath} is already occupied`);
    return null;
  }

  // A killed removal can leave thousands of unstaged deletions. The resume
  // prompt attributes all surviving changes to the agent, so do not hand it a
  // likely damaged checkout. Keep intentional small deletions and staged work;
  // this conservative threshold requires operator recovery for ambiguous bulk
  // deletions instead of silently restoring or detaching somebody's work.
  const status = await execGit(['status', '--porcelain', '--untracked-files=no'], existingWorktreePath)
    .then(r => r.stdout)
    .catch(() => null);
  if (status === null) {
    console.warn(`⚠️ Cannot adopt worktree for ${agentId} — status unreadable; preserved for recovery`);
    return null;
  }
  const trackedChanges = status.split(/\r?\n/).filter(Boolean);
  const deletions = trackedChanges.filter(line => line.startsWith(' D ')).length;
  if (deletions >= 100 && deletions > trackedChanges.length / 2) {
    console.warn(`⚠️ Cannot adopt worktree for ${agentId} — ${deletions} unstaged tracked deletions suggest an interrupted removal; preserved for recovery`);
    return null;
  }

  // Re-entered prep still needs the damage check before resuming in place.
  if (pathsEqual(existingWorktreePath, targetPath)) return adopted;

  await ensureDir(WORKTREES_DIR);

  if (options.deepResume) {
    try {
      const entries = (await execGit(['ls-files', '--stage'], existingWorktreePath)).stdout;
      if (/^160000 /m.test(entries)) {
        // Git cannot move linked worktrees containing submodules, even after
        // deinit. Preserve the admitted inactive tree intact and transfer only
        // its clean branch attachment, all under the same repository queue.
        const currentBranch = (await execGit(['symbolic-ref', '--short', 'HEAD'], existingWorktreePath)).stdout.trim();
        const head = (await execGit(['rev-parse', 'HEAD'], existingWorktreePath)).stdout.trim();
        const status = (await execGit(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], existingWorktreePath)).stdout.trim();
        const listed = await listWorktrees(sourceWorkspace);
        // Git and Node can spell the same Windows directory differently. Fall
        // back to filesystem identity, never case-fold or guess at ownership.
        const identity = await stat(existingWorktreePath, { bigint: true }).catch(() => null);
        const matches = [];
        for (const entry of listed) {
          if (pathsEqual(entry.path, existingWorktreePath)) { matches.push(entry); continue; }
          const other = await stat(entry.path, { bigint: true }).catch(() => null);
          if (identity?.isDirectory() && other?.isDirectory() && typeof identity.ino === 'bigint' && identity.ino > 0n &&
            identity.dev === other.dev && identity.ino === other.ino) matches.push(entry);
        }
        const holder = matches.length === 1 ? matches[0] : null;
        const refusal = currentBranch !== branchName ? 'branch identity changed'
          : !holder ? 'worktree registration could not be matched'
            : holder.locked ? 'worktree is locked' : status ? 'workspace has uncommitted or nested changes' : null;
        if (refusal) throw new Error(`Retained Deep submodule ${refusal}; preserve it for explicit recovery`);
        await execGit(['checkout', '--detach', head], existingWorktreePath);
        const branchHead = (await execGit(['rev-parse', `refs/heads/${branchName}`], sourceWorkspace)).stdout.trim();
        if (branchHead !== head) throw new Error('Deep resume branch changed during handoff; preserved old workspace');
        const replacement = await createWorktreeUnlocked(agentId, sourceWorkspace, null, { existingBranch: branchName });
        return { ...replacement, adopted: true };
      }
    } catch (error) {
      throw Object.assign(new Error(`Deep submodule handoff stopped; retained work is preserved: ${error.message}`, { cause: error }), { code: 'DEEP_RESUME_PRESERVED' });
    }
  }

  // Through the retry wrapper, not raw execGit: `worktree move` mutates the same
  // `.git/worktrees` bookkeeping whose per-repo lock motivated the retry (#2193).
  const moved = await addWorktreeWithRetry(['worktree', 'move', existingWorktreePath, targetPath], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Worktree adopt failed for ${agentId} (${existingWorktreePath} → ${targetPath}): ${err.message}`);
      return false;
    });
  if (!moved) return null;

  // Mirror removeWorktree's treatment of auto-generated lockfile churn: it discards
  // those changes rather than preserving them, so an adopted tree must not carry
  // them either. The resume prompt tells the retry that everything uncommitted is
  // its own in-progress work to finish and commit — which would ship a
  // `package-lock.json` bump from the dead run's `npm install` that nobody
  // intended. Only when the churn is ALL there is: a tree with real changes keeps
  // everything, exactly as removeWorktree preserves it.
  const porcelain = await execGit(['status', '--porcelain'], targetPath)
    .then(r => r.stdout.trim())
    .catch(() => '');
  const dirt = classifyWorktreeDirt(porcelain, { preserveLockfiles: options.preserveLockfiles === true });
  if (dirt.lockfileOnly) {
    console.log(`🧹 Discarding ${dirt.lockfilePaths.length} auto-generated lockfile change(s) in adopted worktree ${agentId}`);
    await discardLockfileChanges(targetPath, dirt).catch(err => {
      console.log(`⚠️ Lockfile discard failed in adopted worktree ${agentId}: ${err.message}`);
    });
  }

  console.log(`🌳 Adopted worktree for ${agentId} at ${targetPath} (branch: ${branchName}) — resuming interrupted work`);
  return adopted;
}
