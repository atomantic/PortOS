import { PROTECTED_BRANCHES } from '../../lib/gitArgs.js';
import { isHumanClaimWorktree, knownAgentIds, worktreeAgentId, worktreeOwnershipReason } from '../../lib/worktreeOwnership.js';
import { teardownGate } from '../branchRetirementDecision.js';

// Recognized work-branch prefixes, in priority order. A branch whose name marks
// it as tracked work — a human/scheduler claim (`claim/`), a CoS sub-agent branch
// (`cos/`), a `/do:next` issue branch (`next/`), or a conventional feature/fix
// branch — is reconciled AHEAD of anything unrecognized, so the coordinator agent
// spends its bounded run on real deliverables first and only reaches ad-hoc or
// experimental branches once those are drained. Both `/` and `-` separators match
// (branch `feature/x` and worktree-derived `feature-x` alike).
export const WORK_BRANCH_PREFIXES = [
  'claim', 'cos', 'next', 'feature', 'fix', 'bugfix', 'hotfix',
  'chore', 'refactor', 'docs', 'test', 'perf', 'build', 'ci', 'style'
];

/**
 * Priority rank of a branch by its work-branch prefix — lower sorts first; an
 * unrecognized branch ranks last (after every recognized prefix). Pure.
 * @param {string} branch
 * @returns {number}
 */
export function branchPriorityRank(branch) {
  const name = branch || '';
  const idx = WORK_BRANCH_PREFIXES.findIndex((p) => name.startsWith(`${p}/`) || name.startsWith(`${p}-`));
  return idx === -1 ? WORK_BRANCH_PREFIXES.length : idx;
}

/**
 * Stable priority sort of classified branches: recognized work-branch prefixes
 * first (in WORK_BRANCH_PREFIXES order), then everything else, ties broken by
 * branch name so the order is deterministic. Pure — does not mutate the input.
 * @param {object[]} branches - entries carrying a `branch` field
 * @returns {object[]}
 */
export function prioritizeBranches(branches) {
  return [...branches].sort(
    (a, b) => branchPriorityRank(a.branch) - branchPriorityRank(b.branch) || (a.branch || '').localeCompare(b.branch || '')
  );
}

/**
 * Ordered classifier rules; the FIRST whose `when` matches decides. Each rule's
 * `id` is copied onto the classified entry as `rule`, so callers read WHICH
 * gate fired instead of re-deriving it from the input fields. Order is
 * load-bearing — moving a rule changes what gets deleted, retired or delegated:
 *   draft              WIP            explicit human-review handoff, even after its agent exits
 *   completion-policy  WIP            policy hold. Sits BEFORE merged so cleanupMerged never deletes
 *                                     a held pointer; retireCompletedCheckouts (heldCheckoutRecovery)
 *                                     retires these rows directly once their work is merged.
 *                                     Except an UNSHIPPED review obligation (no PR ever recorded,
 *                                     none open, commits not on the default branch): the run died
 *                                     before delivery, so the hold falls through to the rules below
 *                                     and normally lands NEEDS_PR. Review still gates the merge.
 *   abandoned-wip      ABANDONED_WIP  dirty tree of an INACTIVE run, no live owner → agent finishes it.
 *                                     Before merged: a dead agent that never committed leaves its
 *                                     pointer on an old default-branch commit, which reads as MERGED
 *                                     and was only ever skipped by cleanupMerged (dirty), invisibly.
 *                                     The live-owner gate stays in front of this exception.
 *   merged             MERGED         fully in the default branch → deterministic cleanup. Before
 *                                     live-owner: cleanupMerged applies the same protection and
 *                                     reports it as held back.
 *   live-owner         WIP            an active CoS agent or lock owns it; handing it to the
 *                                     coordinator would race the live session's git operations
 *   dirty              WIP            uncommitted changes are never handed to the coordinator
 *                                     (rebase/resolve/merge could discard them), whatever the PR state
 *   open-pr            CONFLICTED | IN_REVIEW
 *   pr-state-unavailable WIP          the forge was unreadable (#3358): "no PR" was not learned, so
 *                                     do not dispatch an agent to open one that may exist
 *   needs-pr           NEEDS_PR       tracks a remote, or never pushed but holds commits and a
 *                                     remote exists to push to. `ahead` is what separates a
 *                                     never-pushed branch with work from a bare pointer (#3358);
 *                                     `hasOrigin` gates only the ahead arm because nothing else
 *                                     proves that work is shippable.
 *   bare-pointer       WIP            nothing to ship; unreadable `ahead` (null) also lands here,
 *                                     since a git failure must never manufacture work
 */
const CLASSIFY_RULES = [
  { id: 'draft', state: 'WIP', when: ({ openPr }) => Boolean(openPr?.isDraft) },
  { id: 'completion-policy', state: 'WIP', when: ({ completionPolicyReason, completionReviewUnshipped, isMerged, openPr }) => Boolean(completionPolicyReason)
    && !(completionReviewUnshipped && !isMerged && !openPr) },
  { id: 'abandoned-wip', state: 'ABANDONED_WIP', when: ({ worktreeDirty, liveOwnerReason, abandonedAgentWorktree, abandonedClaimWorktree }) => Boolean(worktreeDirty && !liveOwnerReason && (abandonedAgentWorktree || abandonedClaimWorktree)) },
  { id: 'merged', state: 'MERGED', when: ({ isMerged }) => Boolean(isMerged) },
  { id: 'live-owner', state: 'WIP', when: ({ liveOwnerReason }) => Boolean(liveOwnerReason) },
  { id: 'dirty', state: 'WIP', when: ({ worktreeDirty }) => Boolean(worktreeDirty) },
  { id: 'open-pr', state: ({ openPr }) => (openPr.mergeable === 'CONFLICTING' ? 'CONFLICTED' : 'IN_REVIEW'), when: ({ openPr }) => Boolean(openPr) },
  { id: 'pr-state-unavailable', state: 'WIP', when: ({ prStateUnavailable }) => Boolean(prStateUnavailable) },
  { id: 'needs-pr', state: 'NEEDS_PR', when: ({ hasUpstream, hasOrigin, ahead }) => Boolean(hasUpstream || (hasOrigin && typeof ahead === 'number' && ahead > 0)) },
  { id: 'bare-pointer', state: 'WIP', when: () => true },
];

/**
 * Pure classifier: map one branch's git/PR facts to a reconcile state and the
 * named rule that matched (see CLASSIFY_RULES for the order). States:
 *   ABANDONED_WIP — dirty worktree of an INACTIVE PortOS run → agent finishes it
 *   MERGED     — work is fully in the default branch → deterministic cleanup
 *   CONFLICTED — open PR with merge conflicts        → agent resolves
 *   IN_REVIEW  — open PR, otherwise                  → agent drives to merge
 *   NEEDS_PR   — unmerged work, no PR, clean          → agent verifies + opens PR
 *                (pushed-with-no-PR, or never pushed but holding commits)
 *   WIP        — not dispatched to the coordinator: draft, completion-policy hold, live owner,
 *                dirty tree, unreadable forge, or bare pointer. It is NOT "never touch":
 *                a completion-policy row whose work merged is still retired directly.
 *
 * @param {{ hasUpstream:boolean, ahead?:number|null, hasOrigin?:boolean, isMerged:boolean, worktreeDirty:boolean, abandonedAgentWorktree?:boolean, abandonedClaimWorktree?:boolean, liveOwnerReason?:string|null, completionPolicyReason?:string|null, completionReviewUnshipped?:boolean, openPr:({mergeable?:string, isDraft?:boolean}|null), prStateUnavailable?:boolean }} input
 *   `ahead` is the branch's own commit count over the default branch (null =
 *   unreadable), and `hasOrigin` says the repo has a remote to push that work to.
 *   `hasOrigin` defaults to FALSE (fail-closed): a caller that cannot vouch for a
 *   remote must not have one invented for it.
 *   `prStateUnavailable` means the forge could not be READ this cycle — distinct
 *   from `openPr: null` ("the forge answered: no open PR").
 *   `liveOwnerReason` is `resolveLiveOwnerReason`'s verdict for the branch — non-null
 *   means an active CoS agent or deliberate lock owns it right now, whether or not
 *   its worktree still exists. A clean `claim-*` directory is only a claim marker;
 *   an inactive dirty claim is actionable only when `abandonedClaimWorktree` is true.
 *   `completionPolicyReason` is a non-null policy hold (e.g. pr-completion-review-required).
 *   An `openPr.isDraft` is an explicit human-review handoff.
 * @returns {{state:'ABANDONED_WIP'|'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP', rule:string}}
 */
function classifyBranchRule(input) {
  const rule = CLASSIFY_RULES.find((candidate) => candidate.when({ hasOrigin: false, ahead: null, ...input }));
  return { state: typeof rule.state === 'function' ? rule.state(input) : rule.state, rule: rule.id };
}

/**
 * Same as classifyBranchRule, state only. Input is the same facts object (see
 * classifyBranchRule); a draft is deliberately `draft`, never `completion-policy`.
 * @param {Parameters<typeof classifyBranchRule>[0]} input
 * @returns {'ABANDONED_WIP'|'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP'}
 */
export function classifyBranch(input) {
  return classifyBranchRule(input).state;
}

/**
 * The idle-park cause for a WIP row. Priority is draft, live owner, completion
 * policy, then unfinished-work. A live owner outranks a completion policy HERE
 * even though the completion-policy rule outranks the live-owner rule in the
 * classified state; that difference is intentional and persisted as skipCauses.
 */
function wipParkCause(entry) {
  return entry.openPr?.isDraft ? 'draft-review-required' : entry.liveOwnerReason || entry.completionPolicyReason || 'unfinished-work';
}

/**
 * Classify a list of gathered branch inputs. Pure.
 * @param {object[]} inputs - each from `gatherBranchState`
 * @returns {object[]} inputs with `state` and the matched `rule` id added
 */
export function classifyBranches(inputs) {
  return inputs.map((input) => ({ ...input, ...classifyBranchRule(input) }));
}

/**
 * Reason a worktree must NOT be torn down, or null if it's safe to remove.
 * Pure — the dangerous-to-remove cases the deterministic cleanup must respect
 * (mirrors the guards the existing worktree reaper honors), in gate order — a
 * tree held by more than one of these reports the FIRST:
 *   - locked            → the user explicitly `git worktree lock`ed it
 *   - active CoS agent  → an agent (`agent-<id>`) is currently running in it
 *   - human `/claim`    → a `claim-<slug>` worktree self-cleaned by the /claim flow,
 *                         UNLESS it is an abandoned one older than `staleClaimIdleMs`
 *                         (`ageMs` supplied) — those are reaped (see STALE_CLAIM_IDLE_MS,
 *                         and SHIPPED_CLAIM_IDLE_MS for a claim proven shipped)
 * With `roots` (detached and superseded retirement — see `reconcileWorktreeRoots`), a
 * worktree outside them is `worktree-unmanaged-location` before any of the above:
 * a directory PortOS never created carries no ownership signal at all.
 *
 * `activeAgentIds` is read through `knownAgentIds`: a Set (even an empty one) is
 * authoritative, anything else is UNKNOWN liveness and holds every `agent-*` tree
 * (`worktree-agent-liveness-unknown`). A missing `path` is
 * `worktree-missing-path`, never null — null means only "this caller may remove it".
 *
 * @param {{ path:string, locked?:boolean, activeAgentIds?:Set<string>|null, ageMs?:number, staleClaimIdleMs?:number, roots?:Array<{path:string, requireAgentId?:boolean}> }} input
 * @returns {string|null}
 */
export function worktreeProtectionReason(input) {
  return worktreeOwnershipReason(teardownGate(input));
}

/**
 * Is this worktree a CoS agent workspace whose agent is no longer running?
 *
 * Pure. True only for a `agent-<id>` worktree (the CoS naming convention) that
 * is unlocked and absent from the live-agent set. Paired with a dirty working
 * tree in `classifyBranch`, that is the signature of an agent run that ended —
 * completed, crashed, or reaped — before committing its work.
 *
 * Deliberately narrow: a human `claim-*` worktree, a locked worktree, and the
 * primary checkout all return false, so this can never hand a person's live
 * editing session to an agent that might `git reset` over it. The `agent-*`
 * namespace is machine-owned — nothing but CoS writes there.
 *
 * `activeAgentIds` is a sentinel, not a plain collection: a Set (INCLUDING an
 * empty one — "no agents running", the common case) is an authoritative liveness
 * answer, while a missing/non-Set value means liveness is UNKNOWN and every agent
 * worktree stays protected (`knownAgentIds`). `worktreeProtectionReason` holds
 * the same way — never infer abandonment from an answer we didn't get.
 *
 * @param {{ path:string, locked?:boolean, activeAgentIds?:Set<string> }} input
 * @returns {boolean}
 */
export function isAbandonedAgentWorktree({ path, locked, activeAgentIds }) {
  return worktreeOwnershipReason({
    path,
    locked,
    activeAgentIds,
    requireAgentId: true,
    requireKnownLiveness: true,
  }) === null;
}

/**
 * Is this a dirty human-claim worktree that branch-reconcile may hand to a
 * coordinator sub-agent?
 *
 * Claim worktrees deliberately use a `claim-*` directory rather than the
 * `agent-*` id that lets the ordinary abandonment check prove ownership. The
 * branch-reconcile dispatch path already treats a claim directory as a marker,
 * not as a durable live-process handle; with an authoritative active-agent Set,
 * a dirty claim with no lock/active owner is therefore actionable work rather
 * than a merged branch to park behind the human-claim cleanup grace period.
 *
 * Missing or non-Set liveness is unknown and fails closed. This helper never
 * authorizes cleanup — it only lets classifyBranch expose the dirty tree as
 * ABANDONED_WIP so a sub-agent can inspect and finish it in place.
 *
 * @param {{ path:string, locked?:boolean, worktreeDirty?:boolean, activeAgentIds?:Set<string> }} input
 * @returns {boolean}
 */
export function isAbandonedClaimWorktree({ path, locked, worktreeDirty = false, activeAgentIds }) {
  if (!worktreeDirty || !knownAgentIds(activeAgentIds) || !isHumanClaimWorktree(worktreeAgentId(path))) return false;
  return worktreeOwnershipReason({
    path,
    locked,
    activeAgentIds,
    allowLiveClaim: true,
  }) === null;
}

/** Newline-separated git stdout → trimmed non-empty lines. */
export const gitLines = (stdout) => (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

// The only remote branch-reconcile acts on. `deleteBranch(…, { remote: true })`
// hardcodes `git push origin --delete`, so a branch tracking anything else is
// reported rather than reaped — there is no code path that could delete it
// correctly, and guessing one is how you delete the wrong ref.
export const RECONCILED_REMOTE = 'origin';

/**
 * The remote branch name behind an upstream ref, or null when the branch tracks
 * no remote or tracks one we don't reconcile. Pure.
 *
 * `%(upstream:short)` renders as `origin/<branch>` — and `<branch>` may itself
 * contain slashes (`origin/cos/task-x/agent-y`), so this strips exactly the
 * `origin/` prefix rather than splitting on `/`.
 * @param {string|null|undefined} tracking
 * @returns {string|null}
 */
export function upstreamBranchName(tracking) {
  const prefix = `${RECONCILED_REMOTE}/`;
  if (typeof tracking !== 'string' || !tracking.startsWith(prefix)) return null;
  return tracking.slice(prefix.length) || null;
}

/**
 * Parse `git ls-remote --heads` output into branch → SHA. Pure.
 * @param {string} stdout
 * @returns {Map<string,string>}
 */
export function parseRemoteHeads(stdout) {
  const heads = new Map();
  for (const line of gitLines(stdout)) {
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
  }
  return heads;
}

/**
 * Which of `origin`'s branches nothing local points at any more. Pure.
 *
 * A remote branch is CLAIMED — and therefore never a sweep candidate — when
 * either a local branch shares its name, or a local branch tracks it. Both halves
 * are load-bearing: a local `foo` with no upstream still claims `origin/foo`
 * (that is where a plain `git push` would send it), and a local branch may track
 * a remote branch under a different name, which the name check alone would miss.
 * That second case is why `gatherBranchState` carries `tracking` and not just the
 * `hasUpstream` boolean.
 *
 * Protected branches and the default branch are dropped outright — a remote whose
 * local counterpart is `main` must never appear as an orphan even in a report.
 *
 * @param {Map<string,string>} remoteHeads - branch → SHA on origin
 * @param {object[]} localBranches - getBranches() records ({ name, tracking })
 * @param {{ defaultBranch: string }} ctx
 * @returns {{branch:string, sha:string}[]} orphans, name-sorted for stable output
 */
export function partitionRemoteOrphans(remoteHeads, localBranches, { defaultBranch }) {
  const claimed = new Set();
  for (const b of localBranches || []) {
    if (b?.name) claimed.add(b.name);
    const tracked = upstreamBranchName(b?.tracking);
    if (tracked) claimed.add(tracked);
  }
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);
  return [...(remoteHeads || new Map())]
    .filter(([branch]) => !claimed.has(branch) && !protectedSet.has(branch))
    .map(([branch, sha]) => ({ branch, sha }))
    .sort((a, b) => a.branch.localeCompare(b.branch));
}

const HOLD_NEXT_ACTIONS = {
  'review-owner-ambiguous': 'Resolve competing or unverified execution owners before resuming the original review workflow.',
  'review-task-missing': 'The original owner task is missing. Restore its trusted task record before resuming review; do not recreate its budgets or infer its policy from PR text.',
  'review-task-unavailable': 'The original owner task could not be read. Restore task-store availability and rerun reconciliation; an unavailable read does not establish that history is missing.',
};

/**
 * Summarize every surviving hold when reconciliation has nothing dispatchable.
 * Persist counts and typed causes, with the earliest known hold expiry as the
 * next possible wake-up; raw cleanup diagnostics stay out of scheduler state.
 */
export function describeIdleReconcilePark(skipped = [], heldLive = [], { wip = [], detachedWorktrees = [], superseded = [], gated = [], claimMarkersHeld = [], worktreeInventory = [] } = {}) {
  // One entry per surviving branch/checkout, even when it appears in both the
  // skipped and detached/superseded projections. Never persist raw error text.
  const holds = new Map();
  const lifts = [];
  const add = (entry, rawCause, key = entry.branch || entry.path) => {
    const cause = String(rawCause).split(':', 1)[0];
    holds.set(key, { ...entry, cause: /^[a-z]+(?:-[a-z]+)*$/.test(cause) ? cause : 'cleanup-failed' });
    for (const deadline of [entry.retryAt, entry.holdRetryAt]) {
      const timestamp = Date.parse(deadline);
      if (Number.isFinite(timestamp)) lifts.push(timestamp);
    }
  };
  for (const entry of skipped) {
    const cause = entry.reason?.startsWith('delete-failed') ? 'branch-delete-failed' : entry.reason || 'cleanup-failed';
    add(entry, cause);
  }
  for (const entry of detachedWorktrees) add(entry, entry.reason || 'detached-worktree-held');
  for (const entry of superseded) add(entry, entry.holdReason || 'superseded-branch-held');
  for (const entry of wip) add(entry, wipParkCause(entry));
  for (const entry of heldLive) if (!holds.has(entry.branch || entry.path)) add(entry, entry.liveOwnerReason || 'live-owner');
  for (const entry of gated) add(entry, entry.openPr?.isDraft ? 'draft-review-required' : 'action-disabled');
  // Marker cleanup is distinct from successful local branch retirement.
  for (const entry of claimMarkersHeld) add({ ...entry, claimMarker: true }, entry.reason || 'claim-marker-held', `claim-marker:${entry.issue ?? entry.branch}`);
  // Include checkouts the branch classifier cannot see (protected branches,
  // detached unmerged HEADs, stale registrations), and enrich existing holds.
  // Inventory is evidence only: a lock's prose never grants release authority.
  const holdKeysByPath = new Map([...holds].map(([key, entry]) => [entry.path || entry.worktreePath, key]));
  for (const tree of worktreeInventory || []) {
    const key = holdKeysByPath.get(tree.path) ?? tree.branch ?? tree.path;
    const existing = holds.get(key);
    add({ ...tree, ...existing }, existing?.cause || tree.reason, key);
  }
  if (worktreeInventory === null) add({}, 'worktree-inventory-unavailable', 'worktree-inventory-unavailable');
  const entries = [...holds.values()];
  const heldBackMerged = skipped.filter(s => !s.detached && s.reason?.startsWith('worktree-'));
  const skipCauses = {};
  for (const entry of entries) skipCauses[entry.cause] = (Object.hasOwn(skipCauses, entry.cause) ? skipCauses[entry.cause] : 0) + 1;
  const counts = entries.length ? {
    heldBranches: entries.filter(entry => !entry.claimMarker && !entry.detached && entry.branch).length,
    heldDetached: entries.filter(entry => !entry.claimMarker && (entry.detached || !entry.branch)).length,
    ...(claimMarkersHeld.length ? { heldClaims: entries.filter(entry => entry.claimMarker).length } : {}),
    ...(heldBackMerged.length ? { heldBackMerged: heldBackMerged.length } : {})
  } : null;
  const reason = !entries.length ? 'no-in-flight-branches'
    : entries.every(entry => entry.claimMarker) ? 'claim-markers-held'
    : heldLive.length && entries.every(entry => heldLive.some(owner => owner.branch === entry.branch && owner.liveOwnerReason === entry.cause)) ? 'branches-held-by-live-owners'
      : heldBackMerged.length === entries.length ? 'merged-branches-held-back' : 'branches-blocked';
  return {
    reason, heldBackMerged, counts, skipCauses: entries.length ? skipCauses : null,
    remaining: entries.map(entry => ({
      ...(entry.branch && { branch: entry.branch }),
      ...((entry.path || entry.worktreePath) && { path: entry.path || entry.worktreePath }),
      ...(entry.issue && { issue: entry.issue }),
      ...((entry.head || entry.tip) && { head: entry.head || entry.tip }),
      ...(entry.observedAt && { observedAt: entry.observedAt }),
      ...(entry.createdAt && { createdAt: entry.createdAt }),
      ...(entry.preservationReceipt && { preservationReceipt: entry.preservationReceipt }),
      ...(entry.preservationEvidence && { preservationEvidence: entry.preservationEvidence }),
      ...(entry.checkoutMissing && { checkoutMissing: true }),
      ...(entry.branchMissing && { branchMissing: true }),
      ...(entry.locked !== undefined && { locked: entry.locked, lockReason: entry.lockReason ?? null }),
      ...(entry.detached && { detached: true }),
      ...(entry.managed !== undefined && { managed: entry.managed }),
      ...(entry.archiveLimit && { archiveLimit: entry.archiveLimit }),
      ...(entry.prUrl && { prUrl: entry.prUrl }),
      ...(entry.taskId && { taskId: entry.taskId }),
      ...((entry.nextAction || HOLD_NEXT_ACTIONS[entry.cause]) && { nextAction: entry.nextAction || HOLD_NEXT_ACTIONS[entry.cause] }),
      reason: entry.cause,
    })),
    notLaterThan: lifts.length ? new Date(Math.min(...lifts)).toISOString() : null
  };
}
