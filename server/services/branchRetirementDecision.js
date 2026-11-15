/**
 * Pure hold/retire decisions for checkout retirement (#16115, #16153): branch
 * reconciliation, held-checkout recovery and the early merged-worktree reaper.
 *
 * Each decision is "decide or ask": given the facts inspected so far it returns
 * a hold, an admission, or `{ need }` naming the ONE fact it needs next. The
 * production drivers (branchReconcile.js, heldCheckoutRecovery.js,
 * worktreeManager.js's reapMergedWorktrees) read that
 * fact and ask again, so the I/O order and short-circuits stay exactly as the
 * gates are listed here (a lock or live owner costs no status read), while every
 * permutation of holder, head, merge, dirt, lock and owner can be tested without
 * building a repository.
 *
 * A fact that is `undefined` has not been read yet. `null` is a failed read and
 * always holds: an unreadable answer never reads as clean, merged or unowned.
 */
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { resolve } from 'node:path';
import { isPathInsideDir } from '../lib/fileUtils.js';
import { isAgentWorktreeId, isHumanClaimWorktree, knownAgentIds, worktreeAgentId, worktreeHoldExpiresAt, worktreeOwnershipReason } from '../lib/worktreeOwnership.js';

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
const shortBranch = ref => (ref ? String(ref).replace(/^refs\/heads\//, '') : null);
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

/**
 * Why this branch must be left ALONE this cycle — the dispatch-side counterpart to
 * `worktreeProtectionReason`'s teardown gate. Three cases that gate doesn't cover:
 *
 * 1. **Liveness we could not determine.** An `agent-*` worktree whose owner's
 *    liveness is UNKNOWN (`knownAgentIds` returned null) is presumed live —
 *    the same posture `worktreeProtectionReason` and `isAbandonedAgentWorktree`
 *    take. Fail safe toward not-touching.
 * 2. **A live agent whose worktree is already GONE.** Ownership is in the branch
 *    NAME, not the worktree: CoS branches are `cos/<taskId>/<agentId>` and the
 *    worktree basename is that same `<agentId>`. An agent that removed its worktree
 *    while still running — `/do:pr`'s Phase-7 cleanup does exactly this, before the
 *    session ends — leaves a pushed branch with an open PR and no worktree row, which
 *    otherwise classifies IN_REVIEW and gets handed to the coordinator while its own
 *    agent is still working. That is the bug this whole guard exists to prevent,
 *    surviving in a narrower window. So the branch name is checked too.
 * 3. **A claim directory, which is a claim MARKER and not a live process.** The
 *    claim flow has no durable local agent id for its branch, so treating the
 *    directory's existence as liveness hides clean, open-PR claims after the
 *    claim agent has exited — exactly the branches branch-reconcile exists to
 *    finish. So this side passes `allowLiveClaim`; a dirty claim is then
 *    surfaced as `ABANDONED_WIP` by `isAbandonedClaimWorktree`, while cleanup
 *    keeps its destructive hold through `worktreeProtectionReason` until the
 *    claim is stale or provably shipped. A lock still outranks it: the gate
 *    tests the lock BEFORE the claim, so a locked claim tree reports
 *    `worktree-locked` on its own — and so does a live agent, on the same
 *    ordering. The scheduler augments `activeAgentIds` with the basenames of
 *    live agents' recorded worktree paths, so a claim basename held by a live
 *    agent still wins over the dispatch-side carve-out.
 *
 * A branch with no worktree at all and no live owner is simply free (null).
 *
 * @param {{ branch?:string|null, path:string|null, locked?:boolean, activeAgentIds?:Set<string> }} input
 * @returns {string|null} a stable reason slug, or null when nobody owns it
 */
export function resolveLiveOwnerReason({ branch, path, locked, activeAgentIds }) {
  // The branch's own trailing segment is an agent id for CoS branches — checked
  // FIRST because it holds even after the worktree is gone.
  const owner = (branch || '').split('/').pop() || '';
  if (isAgentWorktreeId(owner) && knownAgentIds(activeAgentIds)?.has(owner)) {
    return 'branch-active-agent';
  }
  if (!path) return null;
  return worktreeOwnershipReason({
    path,
    locked,
    activeAgentIds,
    allowLiveClaim: true,
    requireKnownLiveness: true,
  });
}

/**
 * Who still owns a checkout or branch whose head already proved merged
 * (held-checkout recovery): a registered claim owner, then a live runtime owner,
 * then completion policy. A review-then-merge obligation is moot once the work
 * merged; a human handoff and unreadable records still hold. `path` null asks
 * about the branch alone, `branch` null about a detached checkout.
 *
 * The released lock is not a hold here on purpose: recovery matched it against
 * the release, and a NEW lock fails that registration match instead.
 *
 * @param {{ repoPath: string, path: string|null, branch: string|null, facts: object }} input
 *   facts: `agents` (registry, null unreadable), `runtimeAgentIds` (Set),
 *   `completionHold` (the branch's retirement hold, a reason or null)
 * @returns {{ need: string } | { hold: { reason: string } } | { admit: true }}
 */
export function decideMergedCheckoutOwner({ repoPath, path, branch, facts }) {
  if (facts.agents === undefined) return { need: 'agents' };
  if (!Array.isArray(facts.agents)) return holdOn('claim-ownership-unreadable');
  const claim = claimCheckoutOwnerReason({ branchName: branch || 'HEAD', holderPath: path, sourceWorkspace: repoPath, agents: facts.agents });
  if (claim) return holdOn(claim);
  if (facts.runtimeAgentIds === undefined) return { need: 'runtimeAgentIds' };
  const live = resolveLiveOwnerReason({ branch, path, locked: false, activeAgentIds: buildActiveOwnerIds(facts.runtimeAgentIds, facts.agents) });
  if (live) return holdOn(live);
  if (!branch) return { admit: true };
  if (facts.completionHold === undefined) return { need: 'completionHold' };
  return facts.completionHold && facts.completionHold !== 'pr-completion-review-required' ? holdOn(facts.completionHold) : { admit: true };
}

/**
 * Admission for removing one inventoried checkout under a scoped release,
 * evaluated inside the claim-ownership section after the inventory still names
 * the release. Gates, in order:
 *
 * 1. the fresh registration matches the release: listed, the same physical
 *    checkout when the spelling differs, not the primary/bare/prunable entry,
 *    and the same head, branch and lock (a change is an ownership change);
 * 2. the checkout's observation identity, and the inventoried one when the
 *    release carries it;
 * 3. merge evidence at that head: the forge delivered it (`deliveredHead`), else
 *    every commit is on the default branch;
 * 4. content: unreadable holds; dirt holds unless the PR merged at exactly this
 *    head (`disposableHead`);
 * 5. owners (`decideMergedCheckoutOwner`).
 *
 * @param {object} input
 * @param {string} input.repoPath
 * @param {{ path: string, head: string, branch: string|null, locked: boolean, lockReason: string|null, checkoutIdentity?: string }} input.release
 * @param {string|null} [input.deliveredHead] - lowercased head the forge delivered
 * @param {string|null} [input.disposableHead] - lowercased head a PR merged at exactly
 * @param {object} input.facts - `trees` (listWorktrees, null unreadable), `samePhysical`
 *   (asked with the listed `path`), `identity`, `mergeEvidence`, `clean` (null
 *   unreadable), then the owner facts
 * @returns {{ need: string, path?: string } | { hold: { reason: string } } | { admit: { tree: object, checkoutIdentity: string } }}
 */
export function decideHeldCheckoutRetirement({ repoPath, release, deliveredHead = null, disposableHead = null, facts }) {
  if (facts.trees === undefined) return { need: 'trees' };
  if (!facts.trees?.length) return holdOn('worktree-ownership-unreadable');
  const index = facts.trees.findIndex(tree => resolve(tree.path) === resolve(release.path));
  if (index === -1) return holdOn('checkout-not-found');
  const listed = facts.trees[index];
  // Lexical equality alone can collapse '..' across a symlink. Different
  // spellings must also resolve to the same existing filesystem checkout.
  if (listed.path !== release.path) {
    if (facts.samePhysical === undefined) return { need: 'samePhysical', path: listed.path };
    if (!facts.samePhysical) return holdOn('checkout-identity-changed');
  }
  if (index === 0 || listed.bare) return holdOn('checkout-primary');
  if (listed.prunable) return holdOn('worktree-prunable');
  if (listed.head !== release.head) return holdOn('checkout-head-changed');
  if (shortBranch(listed.branch) !== (release.branch ?? null)) return holdOn('checkout-branch-changed');
  if (Boolean(listed.locked) !== release.locked || (listed.lockReason ?? null) !== (release.lockReason ?? null)) return holdOn('checkout-lock-changed');
  // Carry the persisted release spelling through removal and its record.
  const tree = { ...listed, path: release.path };

  if (facts.identity === undefined) return { need: 'identity' };
  if (!facts.identity || (release.checkoutIdentity && release.checkoutIdentity !== facts.identity)) return holdOn('checkout-identity-changed');
  const head = String(tree.head).toLowerCase();
  if (!(deliveredHead && head === deliveredHead)) {
    if (facts.mergeEvidence === undefined) return { need: 'mergeEvidence' };
    if (!facts.mergeEvidence) return holdOn('not-merged-on-recheck');
  }
  if (facts.clean === undefined) return { need: 'clean' };
  if (facts.clean === null) return holdOn('worktree-status-unavailable');
  // Only a PR merged at the exact head makes uncommitted and untracked files
  // disposable; work contained in a later merged head must be clean.
  if (!facts.clean && !(disposableHead && head === disposableHead)) return holdOn('worktree-dirty');
  const owner = decideMergedCheckoutOwner({ repoPath, path: tree.path, branch: release.branch ?? null, facts });
  if (!owner.admit) return owner;
  return { admit: { tree, checkoutIdentity: facts.identity } };
}

/**
 * Admission for finishing the checkout a trusted pending-merge receipt names.
 * Unlike an operator release it never unlocks, and fresh forge evidence
 * (`facts.forge`: the merged-PR read, or `{ error }`) must prove the receipt's
 * own PR merged at the handed-off head or at a descendant of it.
 *
 * @returns {{ need: 'forge' } | { hold: { reason: string } } | { admit: { delivery: 'exact'|'contained' } }}
 */
export function decidePendingMergeReceipt({ release, expectedHeadSha, facts }) {
  if (!release || release.locked !== false || release.lockReason !== null) return holdOn('receipt-checkout-locked');
  if (!release.path || !release.branch || typeof expectedHeadSha !== 'string'
    || !COMMIT_SHA.test(expectedHeadSha) || release.head !== expectedHeadSha) return holdOn('receipt-checkout-head-unverified');
  if (facts.forge === undefined) return { need: 'forge' };
  const { forge } = facts;
  if (!forge || forge.error) {
    const message = forge?.error?.message;
    return holdOn(/^merged-pr-[a-z-]+$/.test(message || '') ? message : 'receipt-pr-merge-unverified');
  }
  // A PR merged at a later head still delivers this checkout when that head
  // descends from the handed-off one; retirement then needs a clean tree.
  const exact = forge.prHead === expectedHeadSha;
  if (!exact && forge.scopeProof !== 'ancestor-of-delivered-head') return holdOn('receipt-pr-head-changed');
  return { admit: { delivery: exact ? 'exact' : 'contained' } };
}

/**
 * Whether a checkout is a merged delivery recovery retires (read-only): every
 * commit on the default branch with a clean tree, or a PR merged at exactly
 * this head, or merged work with nothing uncommitted. `clean` and `ancestry`
 * are read up front; the forge (`facts.delivery`: exact, contained, none, or
 * null unreadable) only when local evidence is not enough.
 *
 * @returns {{ need: 'delivery' } | { merged: boolean|null }}
 */
export function decideMergedDelivery({ clean, ancestry, facts }) {
  if (ancestry && clean) return { merged: true };
  const { delivery } = facts;
  if (delivery === undefined) return { need: 'delivery' };
  if (delivery === 'exact') return { merged: true };
  if (delivery === null) return { merged: null };
  if (!ancestry && delivery === 'none') return { merged: false };
  // Merged work, but uncommitted files are only disposable at the exact head.
  return { merged: clean };
}

/**
 * Admission for deleting an inventoried merged branch whose checkout is already
 * gone, re-evaluated at each mutation boundary. `delivered` is the forge's
 * merged delivery of `head`, read before the section. Gates, in order: the
 * inventory still names the row, the default branch, no new holder, the ref's
 * presence (only the bounded files-backend inspection proves absence), a direct
 * ref still at `head`, merge evidence, then owners. An already-absent ref
 * records retirement only on the forge's delivery, so an unexplained
 * disappearance stays visible.
 *
 * @param {{ repoPath: string, branch: string, head: string, delivered: boolean, facts: object }} input
 *   facts: `inventoryRow`, `defaultBranch`, `holders`, `presence` (null unverified),
 *   `symbolicExit` (symbolic-ref's exit code, null unreadable), `tip`, `mergeEvidence`, owner facts
 * @returns {{ need: string } | { hold: { reason: string } } | { admit: { missing: boolean } }}
 */
export function decideInventoriedBranchRetirement({ repoPath, branch, head, delivered, facts }) {
  if (facts.inventoryRow === undefined) return { need: 'inventoryRow' };
  if (!facts.inventoryRow) return holdOn('release-not-in-inventory');
  if (facts.defaultBranch === undefined) return { need: 'defaultBranch' };
  if (!facts.defaultBranch) return holdOn('default-branch-unavailable');
  if (branch === facts.defaultBranch) return holdOn('protected-branch');
  if (facts.holders === undefined) return { need: 'holders' };
  if (!facts.holders || facts.holders.some(row => shortBranch(row.branch) === branch)) return holdOn('branch-has-new-holder');
  if (facts.presence === undefined) return { need: 'presence' };
  if (facts.presence === null) return holdOn('branch-ref-presence-unverified');
  if (facts.presence) {
    // Never treat a symbolic ref as the inventoried direct branch, even if its
    // target currently resolves to the same commit.
    if (facts.symbolicExit === undefined) return { need: 'symbolicExit' };
    if (facts.symbolicExit !== 1) return holdOn('branch-ref-presence-unverified');
    if (facts.tip === undefined) return { need: 'tip' };
    if (facts.tip !== head) return holdOn('branch-ref-changed-or-recreated');
  }
  if (!delivered) {
    if (!facts.presence) return holdOn('not-merged-on-recheck');
    if (facts.mergeEvidence === undefined) return { need: 'mergeEvidence' };
    if (!facts.mergeEvidence) return holdOn('not-merged-on-recheck');
  }
  const owner = decideMergedCheckoutOwner({ repoPath, path: null, branch, facts });
  return owner.admit ? { admit: { missing: !facts.presence } } : owner;
}

/**
 * Drive a decide-or-ask decision: read each fact only when it is asked for.
 * A reader gets the facts so far and the asking step; an undefined answer is a
 * failed read (null), so the decision never asks for it again.
 */
export async function decideWith(decide, readers) {
  const facts = {};
  for (;;) {
    const step = decide(facts);
    if (!step.need) return step;
    facts[step.need] = (await readers[step.need](facts, step)) ?? null;
  }
}

/** The early reaper's managed roots: CoS trees need an agent id, `.claude/worktrees` trees do not. */
const reapRoots = (worktreesDir, claudeTreesRoot) => [
  { path: worktreesDir, requireAgentId: true },
  { path: claudeTreesRoot, requireAgentId: false },
];

/**
 * Whether the early reaper (`reapMergedWorktrees`) may take one listed
 * non-primary checkout into its ownership section. Gates, in order:
 *
 * 1. a bare, detached or branchless entry has nothing to merge (`no-branch`);
 * 2. protected, default and currently checked-out branches;
 * 3. the checkout's protection gate under the reaper's managed roots. It passes
 *    no claim age on purpose, so a `claim-*` tree always holds: only
 *    branch-reconcile knows whether a claim shipped or went idle;
 * 4. the `.claude/worktrees` opt-out;
 * 5. content: unreadable holds, and dirt (lockfiles included) holds unless a PR
 *    merged at exactly this head (`disposableHead`);
 * 6. merge evidence for the branch.
 *
 * @param {object} input
 * @param {{ path: string, branch?: string, head?: string, locked?: boolean, bare?: boolean, detached?: boolean }} input.tree
 * @param {string} input.defaultBranch
 * @param {string} input.currentBranch - the source workspace's checked-out branch
 * @param {string} input.worktreesDir
 * @param {string} input.claudeTreesRoot
 * @param {boolean} [input.includeClaudeTrees=true]
 * @param {Set<string>|null|undefined} input.activeAgentIds - anything but a Set is unknown and holds
 * @param {object} input.facts - `dirty` (null unreadable; lockfile churn counts), `disposableHead`, `mergeEvidence`
 * @returns {{ need: string } | { hold: { reason: string }, branch: string|null } | { admit: { branch: string, disposable: boolean } }}
 */
export function decideMergedWorktreeReap({ tree, defaultBranch, currentBranch, worktreesDir, claudeTreesRoot, includeClaudeTrees = true, activeAgentIds, facts }) {
  const branch = tree.bare || tree.detached ? null : shortBranch(tree.branch) || null;
  const hold = reason => ({ hold: { reason }, branch });
  if (!branch) return hold('no-branch');
  if (PROTECTED_BRANCHES.includes(branch) || branch === defaultBranch || branch === currentBranch) return hold('protected');
  const ownership = worktreeOwnershipReason({
    path: tree.path, locked: tree.locked, activeAgentIds, roots: reapRoots(worktreesDir, claudeTreesRoot), requireKnownLiveness: true,
  });
  if (ownership) return hold(ownership);
  if (!includeClaudeTrees && isPathInsideDir(claudeTreesRoot, tree.path)) return hold('claude-tree-excluded');
  // Only a proven-absent directory reads as empty: a prunable registration may
  // be a live checkout with a broken .git pointer and unique work.
  if (facts.dirty === undefined) return { need: 'dirty' };
  if (facts.dirty === null) return hold('status-failed');
  // Unlike removeWorktree(), the background reaper keeps even lockfile-only
  // edits: a fresh-from-main checkout may be an agent before its first commit.
  if (facts.dirty) {
    if (facts.disposableHead === undefined) return { need: 'disposableHead' };
    if (!facts.disposableHead) return hold('uncommitted');
  }
  if (facts.mergeEvidence === undefined) return { need: 'mergeEvidence' };
  if (!facts.mergeEvidence) return hold('unmerged');
  return { admit: { branch, disposable: facts.dirty } };
}

/**
 * The early reaper's recheck inside its ownership section, asked once on
 * entry and again by the removal (`verifyRemoval`) with the fresh holder.
 * Gates, in order: the holder still holds the branch, registered claim owners,
 * completion policy, the protection gate with the holder's lock and fresh
 * liveness, fresh content (dirt is disposable only while the holder is still at
 * the head whose PR merged), then merge evidence.
 *
 * @param {object} input
 * @param {{ path: string, branch: string, head: string }} input.tree - the scanned registration
 * @param {{ branch?: string, head?: string, locked?: boolean }|null} input.holder - the fresh one
 * @param {string} input.sourceWorkspace
 * @param {boolean} input.disposable - the scan admitted dirt at an exact merged-PR head
 * @param {string} input.worktreesDir
 * @param {string} input.claudeTreesRoot
 * @param {object} input.facts - `agents`, `policyHold`, `activeAgentIds`, `dirty` (null unreadable), `mergeEvidence`
 * @returns {{ need: string } | { hold: { reason: string } } | { admit: true }}
 */
export function decideMergedWorktreeRemoval({ tree, holder, sourceWorkspace, disposable, worktreesDir, claudeTreesRoot, facts }) {
  if (!holder || holder.branch !== tree.branch) return holdOn('worktree-holder-changed');
  const branchName = shortBranch(tree.branch);
  if (facts.agents === undefined) return { need: 'agents' };
  const owner = claimCheckoutOwnerReason({ branchName, holderPath: tree.path, sourceWorkspace, agents: facts.agents });
  if (owner) return holdOn(owner);
  if (facts.policyHold === undefined) return { need: 'policyHold' };
  if (facts.policyHold) return holdOn(facts.policyHold);
  if (facts.activeAgentIds === undefined) return { need: 'activeAgentIds' };
  const ownership = worktreeOwnershipReason({
    path: tree.path, locked: holder.locked, activeAgentIds: facts.activeAgentIds, roots: reapRoots(worktreesDir, claudeTreesRoot), requireKnownLiveness: true,
  });
  if (ownership) return holdOn(ownership);
  if (facts.dirty === undefined) return { need: 'dirty' };
  if (facts.dirty === null) return holdOn('worktree-status-unavailable');
  const atMergedHead = disposable && holder.head?.toLowerCase() === tree.head?.toLowerCase();
  if (facts.dirty && !atMergedHead) return holdOn('worktree-dirty');
  if (facts.mergeEvidence === undefined) return { need: 'mergeEvidence' };
  return facts.mergeEvidence ? { admit: true } : holdOn('unmerged');
}
