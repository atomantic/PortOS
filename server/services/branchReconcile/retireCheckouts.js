import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { execGit } from '../../lib/execGit.js';
import { checkoutIdleMs } from './checkoutIdle.js';
import { PATHS } from '../../lib/fileUtils.js';
import { getOriginInfo } from '../../lib/gitRemote.js';
import { probeProcessCwdInside } from '../../lib/processCwdProbe.js';
import { isHumanClaimWorktree, worktreeAgentId, worktreeOwnershipReason } from '../../lib/worktreeOwnership.js';
import { githubRepoSpec } from '../../lib/workTracker.js';
import {
  MERGED_OWNERSHIP_HOLDS, STALE_CLAIM_IDLE_MS, SHIPPED_CLAIM_IDLE_MS, claimIssueOfBranch,
  decideBranchRetirement, decideDetachedRetirement, recoveryWorktreeReason, supersededPolicyHold,
} from '../branchRetirementDecision.js';
import { readClaimIssueReservation, readRepoClaimIssueReservation } from '../claimIssueReservation.js';
import { readClaimOwnershipAgents, withClaimOwnershipLock } from '../cos/cosClaimOwnership.js';
import { getDefaultBranch } from '../git/status.js';
import { hasBranchMergeEvidence, readBranchAgeMs, readBranchLineage, readBranchPublished } from '../git/branchEvidence.js';
import { recordVerdict, sameDirtyPaths } from '../supersededLedger.js';
import {
  classifyWorktreeDirt, deleteCompletedLocalBranch, forceRemoveWorktreeDir, listWorktrees, readCheckoutPresence,
  readWorktreeStatus,
} from '../worktreeManager.js';

// The idle floor a verified-SUPERSEDED branch's worktree must clear before the
// reap may take it from OUTSIDE the managed roots (an agent's `/tmp` checkout).
// Merged cleanup does not use this location gate: a named branch whose current
// head is integrated can retire from any directory, subject to the same live
// ownership, lock, completion-policy and content checks as managed checkouts.
export const SUPERSEDED_UNMANAGED_IDLE_MS = SHIPPED_CLAIM_IDLE_MS;

/**
 * Managed roots for detached-checkout cleanup and superseded-branch retirement.
 * Detached checkouts outside these roots stay inventoried; superseded branches
 * can clear the location hold after SUPERSEDED_UNMANAGED_IDLE_MS. Named merged
 * branches use their freshly verified holder and integration evidence instead
 * of a directory allowlist. Locks and live owners always remain protected.
 *
 * Arbitrary names are accepted inside these roots: claim checkouts are
 * `claim-*`, not `agent-*`, and still require exact completion evidence.
 *
 * @param {string} repoPath
 * @returns {Array<{path:string, requireAgentId:boolean}>}
 */
function reconcileWorktreeRoots(repoPath) {
  return [PATHS.worktrees, repoPath && join(repoPath, '.claude', 'worktrees')]
    .filter(Boolean)
    .map((path) => ({ path, requireAgentId: false }));
}

/**
 * A worktree's real uncommitted paths, [] when clean, or null when unreadable.
 *
 * `classifyWorktreeDirt` subtracts what is not work product — auto-generated
 * lockfiles and PortOS's own runtime scratch — so this list is only authored
 * changes. That matters here because it is what makes a branch ABANDONED_WIP,
 * the state that dispatches a coordinator agent.
 *
 * @param {string} worktreePath
 * @returns {Promise<string[]|null>}
 */
export async function worktreeDirtyPaths(worktreePath) {
  const status = await readWorktreeStatus(worktreePath);
  if (status === null) return null;
  const dirt = classifyWorktreeDirt(status);
  return dirt.hasRealChanges ? (dirt.realChangePaths || []) : [];
}

/**
 * Is a worktree's working tree carrying real (non-lockfile) uncommitted changes?
 * @param {string} worktreePath
 * @returns {Promise<boolean|null>}
 */
async function isWorktreeDirty(worktreePath) {
  const paths = await worktreeDirtyPaths(worktreePath);
  return paths === null ? null : paths.length > 0;
}

/**
 * Age of a worktree directory (ms since its last structural mtime), or null when
 * it can't be stat'd. The worktree root's mtime is set when `git worktree add`
 * lays down its top-level entries and doesn't move for deep-file edits, so for an
 * abandoned claim (no top-level churn after creation) it tracks "time since the
 * worktree was created" — exactly the staleness signal STALE_CLAIM_IDLE_MS needs.
 * @param {string} worktreePath
 * @returns {Promise<number|null>}
 */
export async function worktreeAgeMs(worktreePath) {
  const st = await stat(worktreePath).catch(() => null);
  return st ? Math.max(0, Date.now() - st.mtimeMs) : null;
}

// A local checkout can be retired without owning the global issue reservation.
// Peer installs share a forge login, and a peer may reserve before its first
// commit/push. Neither that login nor an absent remote branch proves release
// authority, so markers are never written here. A read that shows no
// reservation to own (a closed issue, or an open one with no claim label and
// no assignee) settles the report; anything else stays a visible hold.
export async function retainedClaimMarkers(repoPath, branch, { origin, forgeExec = null } = {}) {
  const issue = /^claim\/issue-([1-9]\d*)$/.exec(branch)?.[1];
  if (!issue) return null;
  const target = origin === undefined ? await getOriginInfo(repoPath).catch(() => null) : origin;
  if (target && !githubRepoSpec(target)) return null;
  if (await claimIssueUnreserved(target, issue, forgeExec)) {
    console.log(`⏭️ branch-reconcile: issue #${issue} has no reservation left; markers untouched`);
    return null;
  }
  const hold = { branch, issue: Number(issue), reason: 'claim-reservation-owner-unverified', markerState: 'unknown', ownerState: 'unknown' };
  console.log(`🔒 branch-reconcile: issue #${issue} markers untouched; reservation owner/state unverified`);
  return hold;
}

/** True only on a parsed forge answer; an unreadable issue keeps the hold. */
async function claimIssueUnreserved(target, issue, forgeExec) {
  return await readClaimIssueReservation(target, issue, forgeExec) === false;
}

/**
 * Deterministically clean up fully-merged branches: remove the lingering
 * worktree, then delete the local branch. Safety gates (ALL must hold):
 *   1. `hasBranchMergeEvidence(default)` re-verified true (fail closed).
 *   2. the branch's worktree (if any) has no real uncommitted changes, unless
 *      the forge merged this exact head (those files are disposable).
 *   3. that worktree (if any) is unlocked and has no live owner. Its directory
 *      location does not block cleanup of a named, integrated branch.
 *   4. fresh ownership and completion policy permit retirement under the claim
 *      binding lock; a claim checkout has an exact successful run receipt, or
 *      the forge reports its exact head merged and it has idled past
 *      SHIPPED_CLAIM_IDLE_MS, or (no PR at that head) the forge reports no open
 *      PR for the branch and the checkout has been untouched that long (see
 *      manualClaimShippedHold).
 *   5. removal re-checks holder, owners, content and merge evidence, and the
 *      branch delete is pinned to its exact head.
 * A failed gate skips the branch with a reason. Age, an absent upstream, and
 * a cached merged flag never substitute for successful completion evidence.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} merged - gathered inputs whose state === 'MERGED'
 * @param {{ activeAgentIds?: Set<string>|null }} [opts] - CoS agents currently running;
 *   their worktrees are never torn down even when the branch is merged + clean.
 *   Omitted or null is unknown liveness and holds every `agent-*` worktree.
 *   A `claim-*` checkout keeps its claim hold; only exact completion evidence
 *   (see `admitBranchRetirement`) waives it.
 * @returns {Promise<{cleaned:string[], skipped:{branch:string,reason:string,retryAt?:string}[]}>}
 *   A skip carries `retryAt` when its hold is known to lift at a specific time.
 */
export async function cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds, claimOwners, origin, forgeExec, forgeAccount = null, appId = null } = {}) {
  const cleaned = [];
  const skipped = [];
  const claimMarkersHeld = [];
  for (const b of merged) {
    const retired = await retireBranch(repoPath, b, {
      activeAgentIds,
      claimOwners,
      mergedRetirement: true,
      appId,
      mergeTarget: defaultBranch,
      forgeAccount,
      origin,
      forgeExec,
      label: `🔀 branch-reconcile: remove worktree for ${b.branch}`,
    });
    if (!retired.ok) {
      const { ok, ...failure } = retired;
      if (MERGED_OWNERSHIP_HOLDS.has(failure.reason)) {
        console.log(`⏭️ branch-reconcile: kept ${b.branch}${b.worktreePath ? ` and ${b.worktreePath}` : ''}: ${failure.reason}${failure.retryAt ? ` until ${failure.retryAt}` : ''}`);
      }
      skipped.push({ branch: b.branch, ...(failure.reason !== 'not-merged-on-recheck' && b.worktreePath && { path: b.worktreePath }), ...failure });
      continue;
    }
    const markerHold = await retainedClaimMarkers(repoPath, b.branch, { origin, forgeExec });
    if (markerHold) claimMarkersHeld.push(markerHold);
    cleaned.push(b.branch);
  }
  return { cleaned, skipped, claimMarkersHeld };
}

/**
 * Reap the branches whose SUPERSEDED verdict is cached and still verifies:
 * back the branch up, remove its worktree, delete the local branch.
 *
 * Why this is deterministic cleanup and not a recommendation. A SUPERSEDED
 * branch is the one terminal state nothing else can retire. Its work landed on
 * the default branch under other file and function names, so `isMerged` is false
 * forever and `cleanupMerged` never sees it; merging it would REGRESS what
 * shipped, so no agent may finish it either. Left as a report, it survives every
 * pass — and every recheck either re-derives the verdict at full coordinator cost
 * or (once cached) prints the same "a human should run these two commands" block
 * that nobody runs. Nine verdicts had accumulated in this install that way, each
 * one a branch and a worktree still on disk.
 *
 * What makes deleting safe here is the verdict (the work landed on the default
 * branch under other names, so the forge already holds it) together with a clean
 * worktree: nothing is copied before removal, so a tree with uncommitted or
 * untracked work is held and reported rather than reaped.
 *
 * Ordering is deliberate and costs nothing to get right: the verdict/branch
 * pairing is a pure contract check for a direct caller (through `reconcile` it is
 * already proven by `isVerdictFresh`, but this function is exported and deletes
 * things, so it does not take the pairing on faith), then `retireBranch`'s own
 * pure protection gate, and only then — as its `prepare` hook, past every way
 * this can still refuse — the holder recheck. A branch permanently held by a
 * lock or a live CoS agent therefore costs no I/O at all on a recurring pass.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} superseded - `applySupersededLedger`'s superseded entries, each
 *   carrying the ledger `verdict` it matched
 * @param {{ activeAgentIds?: Set<string>, cosDir?: string }} [opts]
 * @returns {Promise<{reaped:string[], held:object[], skipped:{branch:string,reason:string,retryAt?:string}[]}>}
 *   `held` is the live entries the reap could not take, for the caller to report.
 */
export async function reapSupersededBranches(repoPath, defaultBranch, superseded, { activeAgentIds, claimOwners, cosDir, appId = null } = {}) {
  const reaped = [];
  const held = [];
  const skipped = [];
  // A held entry names its own hold (and when it lifts, if on a clock) so the
  // coordinator prompt and the park log can say WHY rather than "something".
  const hold = (b, failure) => {
    held.push({ ...b, holdReason: failure.reason, ...(failure.retryAt ? { holdRetryAt: failure.retryAt } : {}) });
    skipped.push({ branch: b.branch, ...failure });
  };

  for (const b of superseded || []) {
    const verdict = b.verdict || {};
    // Same comparison isVerdictFresh makes, via the same helper — a raw compare
    // here would hold a pre-upgrade entry that the partition just accepted.
    if (!b.tip || b.tip !== verdict.tip || !sameDirtyPaths(verdict.dirtyPaths, b.dirtyPaths)) {
      hold(b, { reason: 'verdict-does-not-match-branch' });
      continue;
    }
    const retired = await retireBranch(repoPath, b, {
      claimOwners,
      activeAgentIds,
      appId,
      allowLiveClaim: true,
      superseded: true,
      label: `🔀 branch-reconcile: remove superseded worktree for ${b.branch}`,
      // A worktree outside the managed roots is reachable here and nowhere else —
      // the fresh verdict and a clean tree supply the preservation proof, and the
      // idle floor covers a process still in the tree. See the constant.
      unmanagedIdleMs: SUPERSEDED_UNMANAGED_IDLE_MS,
      prepare: async () => {
        if (!b.worktreePath) return null;
        const tree = (await listWorktrees(repoPath)).find(holder => holder.path === b.worktreePath);
        if (!tree || tree.head !== b.tip || tree.branch !== `refs/heads/${b.branch}`) return { error: 'worktree-holder-changed' };
        return null;
      },
    });
    if (!retired.ok) {
      const { ok, ...failure } = retired;
      hold(b, failure);
      continue;
    }
    // Keep the verdict, stamped with what happened to it. The entry is now a
    // record rather than a cache.
    await recordVerdict(
      { ...verdict, branch: b.branch, repoPath, reapedAt: new Date().toISOString() },
      cosDir
    ).catch((err) => console.error(`⚠️ branch-reconcile: reaped ${b.branch} but could not update the verdict ledger: ${err.message}`));
    console.log(`🔀 branch-reconcile: reaped superseded branch ${b.branch}`);
    reaped.push(b.branch);
  }
  return { reaped, held, skipped };
}

/**
 * Remove a branch's worktree (when it has one) and delete the local branch.
 *
 * The destructive tail shared by `cleanupMerged` and `reapSupersededBranches`.
 * Both prove their own safety FIRST — one that the work is merged, the other
 * that it is superseded — and then run exactly this: the same
 * protection gate, the same dirty-tree refusal, the same removal order (the
 * branch delete fails while a worktree still has it checked out). Extracted so
 * the two cannot drift, since a guard added to one and missed on the other is a
 * data-loss bug rather than an inconsistency.
 *
 * @param {string} repoPath
 * @param {object} b - a gathered branch entry
 * @param {{ activeAgentIds?: Set<string>, staleClaimIdleMs?: number, allowLiveClaim?: boolean, label: string, requireCleanWorktree?: boolean, unmanagedIdleMs?: number, prepare?: () => Promise<{ error: string }|null> }} opts
 *   `prepare` runs after every gate has passed and before the first irreversible
 *   step, and aborts the retirement by resolving to `{ error }`. That is the only
 *   place a last recheck belongs: earlier it is paid for branches that are
 *   then refused, later it is too late to matter. It runs inside the
 *   claim-ownership section, so it must stay a local read (no fetch or forge call).
 *
 *   `requireCleanWorktree` (default true) is the caller's answer to "could this
 *   tree hold work that is not accounted for?". For `cleanupMerged` it can, so a
 *   dirty tree refuses: merged proves the COMMITS landed and says nothing about
 *   the working tree; a superseded verdict does not either, and nothing is
 *   copied before removal, so both callers keep the default.
 *
 *   `unmanagedIdleMs` (default none) admits a worktree outside the managed roots
 *   once it has sat idle that long (see SUPERSEDED_UNMANAGED_IDLE_MS).
 *   Merged retirement instead admits the actual holder of the named branch
 *   regardless of location after re-proving integration at its current head.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, retryAt?: string }>}
 */
async function retireBranch(repoPath, b, opts) {
  const supplied = opts.claimOwners;
  if (supplied === null || (supplied !== undefined && (typeof supplied !== 'object'
    || Array.isArray(supplied) || (supplied.readAgents !== undefined && typeof supplied.readAgents !== 'function')))) {
    return { ok: false, reason: 'claim-ownership-unreadable' };
  }
  // A caller's snapshot can add a hold, never grant retirement permission.
  if (supplied && Object.hasOwn(supplied, 'agents')) {
    const snapshotHold = claimCheckoutOwnerReason({
      branchName: b.branch, holderPath: b.worktreePath, sourceWorkspace: repoPath, agents: supplied.agents,
    });
    if (snapshotHold) return { ok: false, reason: snapshotHold };
  }
  const reader = supplied?.readAgents || readClaimOwnershipAgents;
  const readAgents = () => Promise.resolve().then(reader).catch(() => null);
  opts = { ...opts, claimOwners: { ...supplied, readAgents } };
  // A live claim run may still be finishing this branch (CI wait, merge handoff,
  // its own cleanup) — never remove its checkout or ref from under it. The scan's
  // answer is stale by now, so with a registry reader the owners are re-read
  // under the lock binding takes: a bind lands before this check or after the
  // removal, never between them.
  if (b.claimOwnerReason) return { ok: false, reason: b.claimOwnerReason };
  // Forge reads for merged retirement, asked here outside the ownership lock;
  // admission and removal re-bind each answer to the head they observe. A PR
  // merged at the branch's exact head proves it shipped (a new or published
  // branch is otherwise held, #16625) and makes uncommitted and untracked files
  // disposable.
  const head = opts.mergedRetirement
    ? (await execGit(['rev-parse', '--verify', `refs/heads/${b.branch}`], repoPath).catch(() => null))?.stdout?.trim()
    : null;
  if (head) {
    // Each forge read only where its answer can change the outcome: dirt, or a
    // hold that only a PR merged at this head lifts. Admission re-reads the
    // local facts under the lock; an answer not asked for here holds there.
    const dirty = opts.requireCleanWorktree !== false && Boolean(b.worktreePath) && await isWorktreeDirty(b.worktreePath) !== false;
    const lineage = await readBranchLineage(repoPath, b.branch, head, opts.mergeTarget);
    const ownershipHold = lineage !== 'patch' || b.published === true || await readBranchPublished(repoPath, b.branch) !== false;
    const { isMergedPrHead } = await import('../prProbe.js');
    if ((dirty || ownershipHold) && await isMergedPrHead(repoPath, b.branch, head)) {
      opts = { ...opts, shippedHead: head, ...(dirty && { disposableHead: head }) };
    }
    const issue = claimIssueOfBranch(b.branch);
    if (issue && (lineage === 'ancestry' || lineage === 'new')) {
      // Reconcile's per-cycle gh credential when it has one; otherwise (the Git
      // page passes none, a GitLab origin has none) read the origin's tracker.
      const claimReserved = opts.forgeExec
        ? await readClaimIssueReservation(opts.origin === undefined ? await getOriginInfo(repoPath).catch(() => null) : opts.origin, issue, opts.forgeExec)
        : await readRepoClaimIssueReservation(repoPath, issue, { forgeAccount: opts.forgeAccount ?? null });
      opts = { ...opts, claimReserved };
    }
  }
  // One ownership critical section re-reads owners, gates and removes, so a bind
  // lands before the owner read or after the removal. The forge reads above and
  // the caller's fetch stay outside it. The caller's `allowLiveClaim` stands: a
  // merged claim's hold is waived only by completion evidence.
  return withClaimOwnershipLock(async () => {
    const gated = await admitBranchRetirement(repoPath, b, opts);
    if (gated.result) return gated.result;
    const prepared = gated.prepare ? await gated.prepare() : null;
    if (prepared?.error) return { ok: false, reason: prepared.error };
    return finishBranchRetirement(repoPath, gated);
  });
}

/**
 * Every gate before removal. Returns `{ result }` to stop, else the context
 * removal needs. The gates and their order are `decideBranchRetirement`'s; this
 * only reads each fact when the decision asks for it.
 */
async function admitBranchRetirement(repoPath, b, { activeAgentIds, staleClaimIdleMs = STALE_CLAIM_IDLE_MS, allowLiveClaim = false, label, requireCleanWorktree = true, unmanagedIdleMs, prepare, claimOwners, mergedRetirement = false, mergeTarget, forgeAccount = null, appId = null, disposableHead = null, shippedHead = null, claimReserved, superseded = false }) {
  const completionPolicy = await import('../branchCompletionPolicy.js');
  const completionEvidence = () => import('../completedCheckoutEvidence.js');
  const readPolicyHold = async (tip) => {
    const input = { repoPath, branch: b.branch, tip, retirement: mergedRetirement };
    if (!superseded || b.openPr) return completionPolicy.readBranchCompletionHold(input);
    const agents = await completionPolicy.readBranchCompletionPolicies({ repoPath, branch: b.branch }).catch(() => null);
    const detail = await completionPolicy.readBranchCompletionHoldDetail({ ...input, agents });
    return supersededPolicyHold({ hold: detail.reason, superseded, openPr: b.openPr, detail }).hold;
  };
  const readers = {
    agents: () => claimOwners.readAgents().catch(() => null),
    defaultBranch: () => getDefaultBranch(repoPath, { strict: true }).catch(() => null),
    head: async () => (await execGit(['rev-parse', '--verify', `refs/heads/${b.branch}`], repoPath).catch(() => null))?.stdout?.trim(),
    policyHold: facts => readPolicyHold(facts.head),
    // Completion audits may know only the branch: resolve its actual holder.
    holders: () => listWorktrees(repoPath).catch(() => null),
    // Merge evidence pinned to the current commit rather than the scan's flag.
    mergedAtHead: facts => hasBranchMergeEvidence(repoPath, facts.head, mergeTarget).catch(() => false),
    dirty: (facts, path) => isWorktreeDirty(path),
    completionRecords: () => completionPolicy.readBranchCompletionPolicies({ repairIndex: false }).catch(() => null),
    receipt: async (facts, path) => (await completionEvidence()).hasCompletedCheckoutEvidence(facts.completionRecords, {
      repoPath, branch: b.branch, path, head: facts.head, worktrees: facts.holders,
    }),
    forgeMerge: async facts => (await completionEvidence()).readMergedClaimEvidence({ repoPath, branch: b.branch, head: facts.head, forgeAccount }).catch(() => null),
    githubOrigin: async () => Boolean(githubRepoSpec(await getOriginInfo(repoPath).catch(() => null))),
    idleMs: (facts, path) => checkoutIdleMs(path),
    lineage: facts => readBranchLineage(repoPath, b.branch, facts.head, mergeTarget),
    // The gather's ls-remote answer, else the local remote-tracking refs.
    published: () => b.published === true || readBranchPublished(repoPath, b.branch),
    claimReserved: () => claimReserved,
    checkoutPresent: (facts, path) => readCheckoutPresence(path),
    branchAgeMs: () => readBranchAgeMs(repoPath, b.branch),
    checkoutProcess: (facts, path) => probeProcessCwdInside(path),
    mergedPrAtHead: facts => Boolean(shippedHead) && shippedHead === facts.head,
  };
  const facts = {};
  for (;;) {
    const step = decideBranchRetirement({
      repoPath, branch: b.branch, scan: b, activeAgentIds, mergedRetirement, headMustMatchScan: Boolean(prepare),
      requireCleanWorktree, disposableHead, roots: reconcileWorktreeRoots(repoPath),
      staleClaimIdleMs, unmanagedIdleMs, allowLiveClaim, nowMs: Date.now(), facts,
    });
    if (step.hold) return { result: { ok: false, ...step.hold } };
    if (step.admit) {
      const { expectedHead, worktreePath, worktreeLocked, claimCompletion, requireCleanWorktree: requireClean } = step.admit;
      return { b: { ...b, worktreePath, worktreeLocked }, expectedHead, readPolicyHold: (tip = expectedHead) => readPolicyHold(tip), mergeTarget, label, requireCleanWorktree: requireClean, prepare, claimOwners, mergedRetirement, claimCompletion, appId };
    }
    // Checkout reads follow the holder the decision resolved, not the scan's path.
    const path = mergedRetirement ? facts.holders?.find(wt => wt.branch === `refs/heads/${b.branch}`)?.path || null : b.worktreePath;
    // An undefined answer would be asked for again forever; it is a failed read.
    facts[step.need] = (await readers[step.need](facts, path)) ?? null;
  }
}

/**
 * Removal and branch deletion, in the same ownership section as admission. Agent
 * registration and checkout content change without that lock, so removal
 * re-checks them at Git's mutation boundary.
 */
async function finishBranchRetirement(repoPath, { b, expectedHead, readPolicyHold, mergeTarget, label, requireCleanWorktree, claimOwners, mergedRetirement, claimCompletion, appId }) {
  let removal = null;
  if (b.worktreePath) {
    const verifyRemoval = async (holder, worktrees) => {
      if (!holder || holder.branch !== `refs/heads/${b.branch}` || holder.head !== expectedHead) return 'worktree-holder-changed';
      if (claimOwners !== undefined) {
        const agents = claimOwners?.readAgents ? await claimOwners.readAgents().catch(() => null) : claimOwners?.agents;
        const reason = claimCheckoutOwnerReason({ branchName: b.branch, holderPath: b.worktreePath, sourceWorkspace: repoPath, agents });
        if (reason) return reason;
      }
      const policyHold = await readPolicyHold(expectedHead);
      if (policyHold) return policyHold;
      // A forge-merged exact head cannot un-merge, and the holder check above
      // pins that head; only a run receipt can be superseded by a later owner.
      if (mergedRetirement && isHumanClaimWorktree(worktreeAgentId(b.worktreePath)) && claimCompletion !== 'forge-merged') {
        const { readBranchCompletionPolicies } = await import('../branchCompletionPolicy.js');
        const { hasCompletedCheckoutEvidence } = await import('../completedCheckoutEvidence.js');
        const records = await readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
        if (!records || !await hasCompletedCheckoutEvidence(records, {
          repoPath, branch: b.branch, path: b.worktreePath, head: expectedHead, worktrees,
        })) return 'claim-completion-unverified';
      }
      const dirtyPaths = await worktreeDirtyPaths(b.worktreePath);
      if (dirtyPaths === null) return 'worktree-status-unavailable';
      if (requireCleanWorktree && dirtyPaths.length) return 'worktree-dirty';
      if (mergedRetirement && !await hasBranchMergeEvidence(repoPath, expectedHead, mergeTarget).catch(() => false)) return 'not-merged-on-recheck';
      return null;
    };
    // Merge evidence does not cover ignored local content; removal checks it separately.
    removal = await forceRemoveWorktreeDir(repoPath, b.worktreePath, { label, log: 'all', verifyRemoval });
    // The branch is still checked out by a surviving worktree: deleting it would
    // fail, and reporting success would mark the branch reconciled while it is held.
    if (!removal.removed) return { ok: false, reason: removal.reason || 'worktree-remove-failed' };
    // One line per removal so a vanished checkout is attributable to this pass (#16618).
    console.log(`${label}: removed ${b.worktreePath} at ${expectedHead.slice(0, 12)} (${mergedRetirement ? `head contained in ${mergeTarget}` : 'verified superseded'})`);
  }
  const latestPolicyHold = await readPolicyHold(expectedHead);
  if (latestPolicyHold) return { ok: false, reason: latestPolicyHold };
  if (claimOwners !== undefined) {
    const agents = claimOwners?.readAgents ? await claimOwners.readAgents().catch(() => null) : claimOwners?.agents;
    const reason = claimCheckoutOwnerReason({ branchName: b.branch, holderPath: b.worktreePath, sourceWorkspace: repoPath, agents });
    if (reason) return { ok: false, reason };
  }
  const holders = removal?.entries || await listWorktrees(repoPath).catch(() => null);
  if (!holders || holders.some(wt => wt.branch === `refs/heads/${b.branch}`)) return { ok: false, reason: 'branch-has-new-holder' };
  if (mergedRetirement) {
    if (!await hasBranchMergeEvidence(repoPath, expectedHead, mergeTarget).catch(() => false)) return { ok: false, reason: 'not-merged-on-recheck' };
    // A squash/rebase-equivalent branch can contain unique commit objects even
    // without a checkout. Keep an immutable recovery ref before retiring it.
    const backupRef = `refs/portos/completed/${expectedHead}`;
    const backup = await execGit(['update-ref', backupRef, expectedHead], repoPath, { ignoreExitCode: true }).catch(() => null);
    if (backup?.exitCode !== 0) return { ok: false, reason: 'recovery-ref-failed' };
  }
  if (appId && !b.worktreePath) {
    const { getAppById } = await import('../apps.js');
    const app = await getAppById(appId);
    if (!app?.repoPath || resolve(app.repoPath) !== resolve(repoPath)) return { ok: false, reason: 'retirement-receipt-scope-unavailable' };
  }
  const deleted = await deleteCompletedLocalBranch(repoPath, b.branch, expectedHead, {
    // Display history only: a failed write never fails a completed removal.
    onRetired: async () => {
      if (!appId) return;
      const absent = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${b.branch}`], repoPath, { ignoreExitCode: true });
      if (absent.exitCode !== 1) return;
      const { recordHeldCheckoutRetirement } = await import('../branchReconcileOutcome.js');
      await recordHeldCheckoutRetirement(appId, {
        ...(b.worktreePath && { path: b.worktreePath }),
        branch: b.branch, head: expectedHead, branchDeleted: true,
      }).catch(error => console.error(`❌ Retirement history not recorded for ${b.branch}: ${error.message}`));
    },
  }).catch(() => false);
  if (!deleted) return { ok: false, reason: 'branch-ref-changed-or-delete-failed' };
  return { ok: true };
}

/**
 * Gather every worktree whose HEAD is detached — a tree with no branch, which
 * `gatherBranchState` (keyed by local branch) can never see. Only trees sitting
 * at a commit already on the default branch are returned: that is the trash this
 * exists for, and a detached tree at unmerged commits may be someone's work.
 * The main checkout, bare and prunable entries are never gathered.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @returns {Promise<{path:string, head:string|null, locked:boolean, worktreeAgeMs:number|null, dirtyPaths:string[]}[]>}
 */
export async function gatherDetachedWorktrees(repoPath, defaultBranch, preloadedTrees = null) {
  const worktrees = preloadedTrees || await listWorktrees(repoPath).catch(() => []);
  const detached = [];
  for (const [index, entry] of worktrees.entries()) {
    // git lists the main checkout first; the path check covers a caller whose list is not ordered.
    if (index === 0 || entry.branch || entry.bare || entry.prunable || entry.path === repoPath || !entry.head) continue;
    if (!await isCommitOnBranch(repoPath, entry.head, defaultBranch)) continue;
    detached.push({
      path: entry.path,
      head: entry.head,
      locked: Boolean(entry.locked),
      worktreeAgeMs: await worktreeAgeMs(entry.path),
      dirtyPaths: await worktreeDirtyPaths(entry.path),
    });
  }
  return detached;
}

const isCommitOnBranch = (repoPath, sha, branch) =>
  execGit(['merge-base', '--is-ancestor', sha, branch], repoPath, { ignoreExitCode: true })
    .then((r) => r?.exitCode === 0)
    .catch(() => false);

// Read after cleanup so removed holders cannot survive in the recovery report.
// No content or ownership inference: retirement still uses its existing gates.
export async function gatherRecoveryWorktrees(repoPath, preloadedTrees = null) {
  const trees = preloadedTrees || await listWorktrees(repoPath).catch(() => null);
  if (!trees?.length) return null;
  return trees.slice(1).filter(tree => !tree.bare).map(tree => {
    const managed = worktreeOwnershipReason({ path: tree.path, roots: reconcileWorktreeRoots(repoPath), allowLiveClaim: true }) !== 'worktree-unmanaged-location';
    return {
      path: tree.path,
      observedAt: new Date().toISOString(),
      ...(tree.branch && { branch: tree.branch.replace(/^refs\/heads\//, '') }),
      head: tree.head ?? null,
      detached: !tree.branch,
      locked: Boolean(tree.locked),
      lockReason: tree.lockReason ?? null,
      managed,
      reason: recoveryWorktreeReason({ prunable: tree.prunable, locked: tree.locked, managed }),
    };
  });
}

const isStillDetachedOnMerged = async (repoPath, treePath, defaultBranch) => {
  const onBranch = await execGit(['symbolic-ref', '-q', 'HEAD'], treePath, { ignoreExitCode: true })
    .then((r) => r?.exitCode === 0)
    .catch(() => true);
  if (onBranch) return false;
  const head = await execGit(['rev-parse', 'HEAD'], treePath, { ignoreExitCode: true })
    .then((r) => (r?.stdout || '').trim())
    .catch(() => '');
  return Boolean(head) && isCommitOnBranch(repoPath, head, defaultBranch);
};

/**
 * Best-effort display history for a removed detached checkout: it has no
 * branch, so the row must not claim one was deleted. Never gates the removal.
 */
async function recordDetachedRetirement(repoPath, appId, { path, head }) {
  const receipt = { path, head, branchDeleted: false, checkoutOnly: true };
  const outcomes = await import('../branchReconcileOutcome.js');
  await (appId ? outcomes.recordHeldCheckoutRetirement(appId, receipt) : outcomes.recordWorkspaceCheckoutRetirement(repoPath, receipt))
    .catch(error => console.error(`❌ Retirement history not recorded for ${path}: ${error.message}`));
}

/**
 * Retire the detached worktrees `gatherDetachedWorktrees` found, with the same
 * gate order as `retireBranchNow` (protection → still clean → remove), minus the
 * branch deletion a detached tree does not have.
 *
 * A tree outside the managed roots is REPORTED, never removed (#10270): nothing
 * about it proves its creator is finished, so the coordinator decides. A held
 * tree inside the roots is `skipped` with its `worktree-*` reason; both are in
 * `held` so the park log can name them.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} detached - `gatherDetachedWorktrees`' entries
 * @param {{ activeAgentIds?: Set<string>, claimOwners?: { agents: object[]|null } }} [opts]
 * @returns {Promise<{cleaned:string[], skipped:object[], held:{path:string, head:string|null, reason:string, managed:boolean, retryAt?:string}[]}>}
 */
export async function reapDetachedWorktrees(repoPath, defaultBranch, detached, { activeAgentIds, claimOwners, appId = null } = {}) {
  const cleaned = [];
  const skipped = [];
  const held = [];
  const roots = reconcileWorktreeRoots(repoPath);
  const hold = (tree, reason, retryAt) => {
    const managed = reason !== 'worktree-unmanaged-location';
    held.push({ path: tree.path, head: tree.head, reason, managed, ...(retryAt ? { retryAt } : {}) });
    // `detached` keeps the entry out of describeIdleReconcilePark's merged-branch count.
    if (managed) skipped.push({ branch: tree.path, path: tree.path, detached: true, reason, ...(retryAt ? { retryAt } : {}) });
  };
  for (const tree of detached) {
    const decide = facts => decideDetachedRetirement({
      ownersReadable: claimOwners === undefined || Array.isArray(claimOwners?.agents),
      path: tree.path, locked: tree.locked, activeAgentIds, ageMs: tree.worktreeAgeMs, roots,
      scanDirtyPaths: tree.dirtyPaths, nowMs: Date.now(), facts,
    });
    let step = decide({});
    if (step.need) step = decide({ dirty: await isWorktreeDirty(tree.path) });
    if (step.hold) {
      hold(tree, step.hold.reason, step.hold.retryAt);
      continue;
    }
    // Re-verify at action time against what the tree holds NOW: its HEAD may have
    // been switched to a branch or an unmerged commit since the gather.
    if (!await isStillDetachedOnMerged(repoPath, tree.path, defaultBranch)) continue;
    const verifyRemoval = async (holder) => {
      if (!holder || holder.branch) return 'worktree-holder-changed';
      if (claimOwners !== undefined) {
        const agents = claimOwners?.readAgents ? await claimOwners.readAgents().catch(() => null) : claimOwners?.agents;
        // Detached HEAD has no claim branch, but a run may occupy its directory.
        const reason = claimCheckoutOwnerReason({ branchName: 'HEAD', holderPath: tree.path, sourceWorkspace: repoPath, agents });
        if (reason) return reason;
      }
      const dirty = await isWorktreeDirty(tree.path);
      if (dirty === null) return 'worktree-status-unavailable';
      if (dirty) return 'worktree-dirty';
      return await isStillDetachedOnMerged(repoPath, tree.path, defaultBranch) ? null : 'worktree-head-changed';
    };
    // One ownership section: a bind lands before the owner read or after removal.
    const removal = await withClaimOwnershipLock(async () => {
      const current = (await listWorktrees(repoPath).catch(() => null))?.find(holder => holder.path === tree.path);
      if (!current || current.head !== tree.head || current.branch) return { removed: false, reason: 'worktree-holder-changed' };
      const initialHold = await verifyRemoval(current);
      if (initialHold) return { removed: false, reason: initialHold };
      const removed = await forceRemoveWorktreeDir(repoPath, tree.path, {
        label: '🔀 branch-reconcile: remove detached worktree', log: 'all',
        verifyRemoval: async holder => (holder && holder.head !== current.head ? 'worktree-holder-changed' : verifyRemoval(holder)),
      });
      if (!removed.removed) return removed;
      await recordDetachedRetirement(repoPath, appId, { path: tree.path, head: tree.head });
      return removed;
    });
    if (!removal.removed) {
      hold(tree, removal.reason || 'worktree-remove-failed');
      continue;
    }
    cleaned.push(tree.path);
  }
  return { cleaned, skipped, held };
}
