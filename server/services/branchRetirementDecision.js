/**
 * Pure hold/retire decisions for branch-reconcile checkout retirement (#16115).
 *
 * Each decision is "decide or ask": given the facts inspected so far it returns
 * a hold, an admission, or `{ need }` naming the ONE fact it needs next. The
 * production driver in branchReconcile.js reads that fact and asks again, so the
 * I/O order and short-circuits stay exactly as the gates are listed here (a lock
 * or live owner costs no status read), while every permutation of holder, head,
 * merge, dirt, lock and owner can be tested without building a repository.
 *
 * A fact that is `undefined` has not been read yet. `null` is a failed read and
 * always holds: an unreadable answer never reads as clean, merged or unowned.
 */
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { isHumanClaimWorktree, knownAgentIds, worktreeAgentId, worktreeHoldExpiresAt, worktreeOwnershipReason } from '../lib/worktreeOwnership.js';

// Why seven days: a claim tree at the default commit loses nothing recoverable
// when reaped, but mtime alone cannot prove abandonment, so a paused session
// returned to within a week keeps its worktree (see branchReconcile.js).
export const STALE_CLAIM_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

// Proof that a claim SHIPPED collapses the wait but does not prove the local
// /claim process exited: a session that just merged its own PR (or whose PR a
// peer machine merged) spends seconds to minutes tearing down in that state.
// An hour is far longer than any teardown and still turns a week-long park
// into a single recheck.
export const SHIPPED_CLAIM_IDLE_MS = 60 * 60 * 1000;

const COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const holdOn = (reason, retryAt) => ({ hold: { reason, ...(retryAt ? { retryAt } : {}) } });

/**
 * The teardown gate's options for `worktreeOwnershipReason`: stale claims
 * reclaimable, unknown liveness held.
 */
export function teardownGate({ path, locked, activeAgentIds, ageMs, staleClaimIdleMs = STALE_CLAIM_IDLE_MS, allowLiveClaim = false, roots = [], unmanagedIdleMs }) {
  return { path, locked, activeAgentIds, roots, allowStaleClaim: true, allowLiveClaim, ageMs, staleClaimIdleMs, unmanagedIdleMs, requireKnownLiveness: true };
}

/** A protection hold with the instant its clock lifts it, when one does. */
function protectionHold(gate, nowMs) {
  const reason = worktreeOwnershipReason(teardownGate(gate));
  return reason ? { reason, retryAt: worktreeHoldExpiresAt({ ...teardownGate(gate), nowMs }) } : null;
}

/**
 * Why a merged manual `claim-*` checkout without a run receipt stays held, or
 * null once the forge proves it shipped (#12849). The forge must report a merged
 * PR at exactly this head, merged at least SHIPPED_CLAIM_IDLE_MS ago, on a
 * checkout created at least that long ago. With no PR at the exact head (a
 * reused branch, or one that shipped from elsewhere) a GitHub PR read showing
 * no open PR plus an idle checkout is the evidence instead; elsewhere "no open
 * PR" is the default, not an answer. No retryAt: no clock alone lifts it.
 *
 * @returns {{ need: string } | { hold: object } | { shipped: true }}
 */
// `openPr` undefined (an entry no forge listing produced) is not "no open PR".
function manualClaimShipped({ worktreeAgeMs, openPr, prStateUnavailable, nowMs }, facts) {
  const unverified = holdOn('claim-completion-unverified');
  if (!Number.isFinite(worktreeAgeMs) || worktreeAgeMs < SHIPPED_CLAIM_IDLE_MS) return unverified;
  if (facts.forgeMerge === undefined) return { need: 'forgeMerge' };
  if (facts.forgeMerge) return nowMs - Date.parse(facts.forgeMerge.mergedAt) < SHIPPED_CLAIM_IDLE_MS ? unverified : { shipped: true };
  if (openPr !== null || prStateUnavailable !== false) return unverified;
  if (facts.githubOrigin === undefined) return { need: 'githubOrigin' };
  if (!facts.githubOrigin) return unverified;
  if (facts.idleMs === undefined) return { need: 'idleMs' };
  return Number.isFinite(facts.idleMs) && facts.idleMs >= SHIPPED_CLAIM_IDLE_MS ? { shipped: true } : unverified;
}

/**
 * Admission for retiring a named branch and its checkout, evaluated inside the
 * claim-ownership critical section. Gates, in order:
 *
 * 1. registered claim owners (`agents`), re-read under the binding lock;
 * 2. protected and default branches;
 * 3. the branch head, which must still be the scanned tip when a `prepare`
 *    recheck follows admission;
 * 4. completion-policy holds (review obligations, human handoffs);
 * 5. merged retirement only: the branch's actual holder and merge evidence at
 *    its current head, so a completion audit that knows only the branch name
 *    cannot retire a checkout that moved;
 * 6. the checkout's protection gate (live agent, lock, location, claim grace),
 *    then its content: unreadable status holds, real dirt holds unless a merged
 *    PR at this exact head made it disposable;
 * 7. merged retirement of a `claim-*` checkout: a recorded completed owner, or
 *    the forge's proof that a manual session shipped. Registry silence and age
 *    never waive a claim hold (#12990).
 *
 * @param {object} input
 * @param {string} input.repoPath
 * @param {string} input.branch
 * @param {{ worktreePath?: string|null, worktreeLocked?: boolean, worktreeAgeMs?: number|null, openPr?: object|null, prStateUnavailable?: boolean, tip?: string|null }} input.scan
 *   the gathered branch entry this admission was asked about
 * @param {Set<string>|null|undefined} input.activeAgentIds - runtime liveness; anything but a Set is unknown
 * @param {boolean} [input.mergedRetirement]
 * @param {boolean} [input.headMustMatchScan] - a `prepare` recheck follows admission
 * @param {boolean} [input.requireCleanWorktree=true]
 * @param {string|null} [input.disposableHead] - head a merged PR made uncommitted content disposable at
 * @param {Array<{path:string, requireAgentId?:boolean}>} [input.roots] - managed roots (non-merged retirement)
 * @param {number} [input.staleClaimIdleMs]
 * @param {number} [input.unmanagedIdleMs]
 * @param {boolean} [input.allowLiveClaim]
 * @param {number} [input.nowMs]
 * @param {object} input.facts - inspected so far: agents, defaultBranch, head, policyHold,
 *   holders, mergedAtHead, dirty, completionRecords, receipt, forgeMerge, githubOrigin, idleMs
 * @returns {{ need: string } | { hold: { reason: string, retryAt?: string } } | { admit: { activeAgentIds: Set<string>|null, expectedHead: string, worktreePath: string|null, worktreeLocked: boolean, claimCompletion: 'receipt'|'forge-merged'|null, requireCleanWorktree: boolean } }}
 */
export function decideBranchRetirement({
  repoPath, branch, scan = {}, activeAgentIds, mergedRetirement = false, headMustMatchScan = false,
  requireCleanWorktree = true, disposableHead = null, roots = [], staleClaimIdleMs = STALE_CLAIM_IDLE_MS,
  unmanagedIdleMs, allowLiveClaim = false, nowMs = Date.now(), facts = {},
}) {
  if (facts.agents === undefined) return { need: 'agents' };
  const ownerReason = claimCheckoutOwnerReason({ branchName: branch, holderPath: scan.worktreePath ?? null, sourceWorkspace: repoPath, agents: facts.agents });
  if (ownerReason) return holdOn(ownerReason);
  // Workspace owners from the registry read under the lock join the runtime ids.
  const ownerIds = buildActiveOwnerIds(activeAgentIds, facts.agents);

  if (PROTECTED_BRANCHES.includes(branch)) return holdOn('protected-branch');
  if (facts.defaultBranch === undefined) return { need: 'defaultBranch' };
  if (!facts.defaultBranch) return holdOn('default-branch-unavailable');
  if (branch === facts.defaultBranch) return holdOn('protected-branch');
  if (facts.head === undefined) return { need: 'head' };
  const expectedHead = facts.head;
  if (!COMMIT_SHA.test(expectedHead || '')) return holdOn(mergedRetirement ? 'not-merged-on-recheck' : 'branch-head-unavailable');
  if (headMustMatchScan && expectedHead !== scan.tip) return holdOn('branch-head-changed');
  if (facts.policyHold === undefined) return { need: 'policyHold' };
  if (facts.policyHold) return holdOn(facts.policyHold);

  let worktreePath = scan.worktreePath ?? null;
  let worktreeLocked = Boolean(scan.worktreeLocked);
  if (mergedRetirement) {
    if (facts.holders === undefined) return { need: 'holders' };
    if (!facts.holders) return holdOn('worktree-ownership-unreadable');
    const holder = facts.holders.find(wt => wt.branch === `refs/heads/${branch}`);
    if (facts.mergedAtHead === undefined) return { need: 'mergedAtHead' };
    if (!facts.mergedAtHead) return holdOn('not-merged-on-recheck');
    if (worktreePath && worktreePath !== holder?.path) return holdOn('worktree-holder-changed');
    if (holder?.path === repoPath) return holdOn('currently-checked-out');
    worktreePath = holder?.path || null;
    worktreeLocked = holder?.locked || false;
  }
  const disposable = disposableHead === expectedHead;
  const admit = (claimCompletion = null) => ({ admit: {
    activeAgentIds: ownerIds, expectedHead, worktreePath, worktreeLocked, claimCompletion,
    requireCleanWorktree: requireCleanWorktree && !disposable,
  } });
  if (!worktreePath) return admit();

  // Location adds no completion evidence for a named merged branch: external
  // checkouts get the same owner, lock, claim and content checks as managed ones.
  // External sessions retain a clean checkout with `git worktree lock`; an
  // arbitrary directory or unregistered process alone is not a cleanup hold.
  const gate = {
    path: worktreePath, locked: worktreeLocked, activeAgentIds: ownerIds, ageMs: scan.worktreeAgeMs,
    staleClaimIdleMs, allowLiveClaim, roots: mergedRetirement ? [] : roots, unmanagedIdleMs,
  };
  const protection = protectionHold(gate, nowMs);
  // The claim gate runs LAST, so `worktree-human-claim` means every other hold
  // cleared. For a merged claim that one hold is waivable, but only by the
  // completion evidence below.
  if (protection && !(protection.reason === 'worktree-human-claim' && mergedRetirement)) return holdOn(protection.reason, protection.retryAt);
  if (facts.dirty === undefined) return { need: 'dirty' };
  if (facts.dirty === null) return holdOn('worktree-status-unavailable');
  if (requireCleanWorktree && facts.dirty && !disposable) return holdOn('worktree-dirty');
  if (!mergedRetirement) return admit();

  let claimCompletion = null;
  if (isHumanClaimWorktree(worktreeAgentId(worktreePath))) {
    if (facts.completionRecords === undefined) return { need: 'completionRecords' };
    if (!facts.completionRecords) return holdOn('claim-ownership-unreadable');
    if (facts.receipt === undefined) return { need: 'receipt' };
    if (facts.receipt) claimCompletion = 'receipt';
    else {
      const shipped = manualClaimShipped({ ...scan, nowMs }, facts);
      if (!shipped.shipped) return shipped;
      claimCompletion = 'forge-merged';
    }
  }
  const tree = facts.holders.find(wt => wt.path === worktreePath);
  if (!tree || tree.head !== expectedHead) return holdOn('worktree-holder-changed');
  return admit(claimCompletion);
}

/**
 * The completion-policy hold that applies to a superseded retirement. A
 * verified-superseded branch is never merged, so a review-then-merge obligation
 * that never recorded a PR has no merge left to gate; a recorded PR, a human
 * handoff, an open PR and unreadable policy records still hold. `detail` is the
 * obligation's detail read (`{ reason, unshipped }`), undefined until asked for
 * and null when unreadable.
 *
 * @returns {{ need: 'detail' } | { hold: string|null }}
 */
export function supersededPolicyHold({ hold, superseded, openPr, detail }) {
  if (!superseded || openPr || hold !== 'pr-completion-review-required') return { hold };
  if (detail === undefined) return { need: 'detail' };
  return { hold: detail?.reason === hold && detail.unshipped === true ? null : hold };
}

/**
 * The runtime ids plus every running or paused record's id and workspace
 * basename (a claim tree uses a branch-shaped directory name, not the run's
 * `agent-*` id). Unknown stays unknown: non-Set runtime ids or an unreadable
 * registry return null, never an empty Set.
 *
 * @param {Set<string>|null|undefined} runtimeIds
 * @param {object[]|null} liveAgents
 * @returns {Set<string>|null}
 */
export function buildActiveOwnerIds(runtimeIds, liveAgents) {
  const known = knownAgentIds(runtimeIds);
  if (!known || !Array.isArray(liveAgents)) return null;
  const ids = new Set(known);
  for (const agent of liveAgents) {
    if (agent?.status !== 'running' && agent?.status !== 'paused') continue;
    if (agent.id) ids.add(agent.id);
    const worktreeId = worktreeAgentId(agent.workspacePath || agent.metadata?.workspacePath);
    if (worktreeId) ids.add(worktreeId);
  }
  return ids;
}

/**
 * Admission for removing a detached checkout already gathered at a merged
 * commit. `ownersReadable` is false when the caller supplied a registry it could
 * not read; `scanDirtyPaths` is the gather's answer and `facts.dirty` the fresh
 * one, and either being unreadable or dirty holds.
 *
 * @returns {{ need: 'dirty' } | { hold: { reason: string, retryAt?: string } } | { admit: true }}
 */
export function decideDetachedRetirement({ ownersReadable = true, path, locked, activeAgentIds, ageMs, roots = [], scanDirtyPaths, nowMs = Date.now(), facts = {} }) {
  if (!ownersReadable) return holdOn('claim-ownership-unreadable');
  const protection = protectionHold({ path, locked, activeAgentIds, ageMs, roots }, nowMs);
  if (protection) return holdOn(protection.reason, protection.retryAt);
  if (facts.dirty === undefined) return { need: 'dirty' };
  if (scanDirtyPaths === null || facts.dirty === null) return holdOn('worktree-status-unavailable');
  if (scanDirtyPaths?.length > 0 || facts.dirty) return holdOn('worktree-dirty');
  return { admit: true };
}

/**
 * Why a branch must be left alone this cycle, as the gather records it: a live
 * runtime owner first, then a registered claim owner, then the pr-watcher merge
 * queue, then an unreadable checkout status. Null when nobody holds it.
 *
 * `pendingMergeBranches` is a Set of queued branches, null when the app record
 * could not be read (holds every branch), undefined when there is no app to ask.
 */
export function gatheredHoldReason({ liveOwnerReason, claimOwnerReason, pendingMergeBranches, branch, worktreeStatusUnavailable }) {
  return liveOwnerReason || claimOwnerReason || pendingMergeReason(pendingMergeBranches, branch)
    || (worktreeStatusUnavailable ? 'worktree-status-unavailable' : null);
}

function pendingMergeReason(pendingMergeBranches, branch) {
  if (pendingMergeBranches === undefined) return null;
  if (pendingMergeBranches === null) return 'pending-merge-unavailable';
  return pendingMergeBranches.has(branch) ? 'pending-merge-queued' : null;
}

/** The hold a retained checkout reports in the recovery inventory. */
export function recoveryWorktreeReason({ prunable, locked, managed }) {
  if (prunable) return 'worktree-prunable';
  if (locked) return 'worktree-locked';
  return managed ? 'checkout-retained' : 'worktree-unmanaged-location';
}
