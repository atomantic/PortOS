import { MANAGED_WORKTREE_CLEANUP_CONTRACT } from '../lib/mergeGateContract.js';
import { MERGED_OWNERSHIP_HOLDS, STALE_CLAIM_IDLE_MS, SHIPPED_CLAIM_IDLE_MS, buildActiveOwnerIds, claimIssueOfBranch, decideBranchRetirement, resolveLiveOwnerReason, decideDetachedRetirement, gatheredHoldReason, recoveryWorktreeReason, supersededPolicyHold, teardownGate } from './branchRetirementDecision.js';
/**
 * Branch & PR Reconciler — deterministic core (Tier 1).
 *
 * Enumerates THIS machine's local branches (`refs/heads/`), classifies each by
 * its merge / PR state, and deterministically cleans up the fully-merged,
 * orphaned ones (remove the lingering worktree + delete the local branch).
 * Everything that needs judgment (open a PR, resolve conflicts, drive a review
 * loop, merge) is returned in `inFlight` for the scheduler to hand to a
 * coordinator CoS agent — this module never spawns an agent, so it stays pure
 * enough to unit-test.
 *
 * PEER SAFETY: only `refs/heads/` (local) branches are ever *driven*. A branch
 * created on a federated peer exists here only as a remote-tracking ref
 * (`origin/*`), never as a local branch, so it is structurally invisible to the
 * classifier. We never author-filter — every machine shares one GitHub login, so
 * authorship can't distinguish machines; local-branch existence can.
 *
 * The orphan sweep (`reapOrphanedRemotes`) checks remote branches through the
 * endpoint-bound Git cleanup action. A scan alone cannot authorize deletion:
 * another install may advance a branch after the scan.
 */

import { buildAutoMergeHandoffInstructions } from '../lib/mergeGateContract.js';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
import { getBranches, getDefaultBranch, hasBranchMergeEvidence, deleteMergedRemoteBranches, readBranchLineage, readBranchPublished } from './git.js';
import { readRepoBranchSnapshot } from './repoBranchSnapshot.js';
import { readClaimIssueReservation, readRepoClaimIssueReservation } from './claimIssueReservation.js';
import { probeProcessCwdInside } from '../lib/processCwdProbe.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, forceRemoveWorktreeDir, classifyWorktreeDirt, reapMergedWorktrees, readCheckoutPresence, readWorktreeStatus, deleteCompletedLocalBranch } from './worktreeManager.js';
import { isHumanClaimWorktree, knownAgentIds, worktreeAgentId, worktreeOwnershipReason } from '../lib/worktreeOwnership.js';
import { execGh, ensureForgeReachable, getIssueDispatchHint } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { isForgeNoAccessError, logForgeNoAccessOnce } from '../lib/forgeAccessErrors.js';
import { issueNumberFromRef } from './issueReconcile.js';
import { forgeDispatchLabels, } from '../lib/dispatchLabels.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { ledgerPath, readVerdictLedger, partitionSuperseded, recordVerdictInstruction, recordVerdict, sameDirtyPaths } from './supersededLedger.js';
import { claimCheckoutOwnerReason, RECONCILE_AGENT_ID_PLACEHOLDER } from '../lib/claimContinuation.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents } from './cos/cosClaimOwnership.js';
import { agentApiCurl } from '../lib/agent/agentApiToken.js';
import { localApiBaseUrl } from '../lib/networkExposure.js';

// Never reconciled — the canonical long-lived-branch set (`main`/`master`/`dev`/
// `develop`/`release`/`gh-pages`) shared with the git branch-cleanup guards in
// `../lib/gitArgs.js`, so a branch that can't be deleted also can't be handed to
// the coordinator agent. The resolved default branch is added on top at runtime.
// Re-exported for callers that reach for it from this module.
export { PROTECTED_BRANCHES };

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

// A `claim-*` worktree is normally protected as a human `/claim` session that
// self-cleans in the /claim Phase-7 flow. But when that flow never runs (the
// agent finished WITHOUT committing), the branch is left as a bare pointer at an
// already-merged commit and the worktree lingers forever — making branch-reconcile
// park with "cleaned 0" every run (the exact confusion behind this guard). Reap
// such a claim worktree once it is older than this AND its branch is merged AND
// its worktree is clean. That trio is only ever true for an ABANDONED claim: a
// claim with real work in progress is never merged+clean (uncommitted edits →
// dirty → WIP; committed work → not an ancestor of default → not MERGED).
//
// Because a reaped worktree is merged+clean, the reap loses NOTHING recoverable —
// no commits beyond the default branch, no uncommitted edits — and re-running
// `/claim` recreates it in seconds. So even a false positive (a human who claimed
// an issue, left the branch untouched at the default commit, and returns to a
// *paused* session) costs only a re-claim, never work. The window is set very
// conservatively at a full week anyway — mtime alone can't prove abandonment, so
// we err far toward preservation: a paused session returned-to within 7 days keeps
// its worktree, while a genuinely-leaked one (which persists indefinitely) is
// reaped on the daily recheck once it crosses the threshold.
export { STALE_CLAIM_IDLE_MS, SHIPPED_CLAIM_IDLE_MS, buildActiveOwnerIds, resolveLiveOwnerReason };

// The same window, for a claim that has demonstrably SHIPPED (see SHIPPED_CLAIM
// on cleanupMerged): proof of completion collapses the wait to an idle floor
// over the checkout mtime, because it does not prove the local /claim process
// has exited. Both windows live with the retirement decision that applies them.

// The idle floor a verified-SUPERSEDED branch's worktree must clear before the
// reap may take it from OUTSIDE the managed roots (an agent's `/tmp` checkout).
// Merged cleanup does not use this location gate: a named branch whose current
// head is integrated can retire from any directory, subject to the same live
// ownership, lock, completion-policy and content checks as managed checkouts.
export const SUPERSEDED_UNMANAGED_IDLE_MS = SHIPPED_CLAIM_IDLE_MS;

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

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
 * Resolve the open PRs for a repo, keyed by head branch name.
 *
 * Three answers, never two (#3358):
 *   - a Map (possibly empty) — the forge answered
 *   - an EMPTY Map for a non-GitHub origin — there is no GitHub PR state to have
 *   - `null` — we could NOT ask (gh transport/auth failure, unparseable output,
 *     or a backoff cooldown from recent consecutive failures — see `execGh`'s
 *     `backoffKey`, passed here as the repo spec)
 *
 * `null` must never be read as "this branch has no PR": that is what made an
 * unreachable forge classify every pushed branch as NEEDS_PR and hand the
 * coordinator agent a list of PRs to re-open on top of the ones that exist.
 *
 * @param {string} repoPath
 * @param {object|null} [providedOrigin] - `getOriginInfo`'s answer when the caller
 *   already resolved it (gatherBranchState needs the same record for `hasOrigin`);
 *   omitted, this reads it itself so a standalone call still works.
 * @param {object} [opts]
 * @param {{cwd?:string, env?:object}|null} [opts.forgeExec] - The per-repo gh
 *   credential overlay `reconcile` already resolved; omitted, this resolves it
 *   itself so a standalone call still authenticates correctly.
 * @param {string|null} [opts.forgeAccount] - The app record's explicit gh pin,
 *   used only when `forgeExec` was not supplied.
 * @returns {Promise<Map<string, {number:number, mergeable:string, isDraft:boolean, url:string}>|null>}
 */
async function getOpenPrsByHead(repoPath, providedOrigin, { forgeExec = null, forgeAccount = null } = {}) {
  const origin = providedOrigin === undefined
    ? await getOriginInfo(repoPath).catch(() => null)
    : providedOrigin;
  // Accept any GitHub-family host (github.com AND enterprise github.*), mirroring
  // prWatcher.checkPullRequests. `origin.isGithub` is github.com-only, so gating
  // on it silently skipped enterprise repos. githubRepoSpec pairs that gate with
  // the host-qualified `HOST/OWNER/REPO` selector (null for a non-GitHub origin).
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return new Map();
  // Run gh with the credential THIS repo needs, not gh's ambient active login
  // (#7540) — an app whose repo belongs to another GitHub account otherwise 404s
  // on every tick forever. Mirrors appPullRequests.fetchGithubPullRequests.
  const { cwd, env } = forgeExec || await resolveForgeExecOptions(repoPath, { forgeAccount });
  // `backoffKey: repoSpec` opts this polling read into execGh's consecutive-
  // failure backoff — this call is retried on every scheduler tick with no
  // parking cooldown (resolveBranchReconcileBlock treats `prStateUnavailable`
  // as transient), so a `gh` blip must not turn into every managed repo
  // re-firing this same expensive call on its very next tick. A no-access 404 is
  // deliberately exempted inside execGh: it is permanent, so backing off on it
  // would park the shared key for every other caller of this repo.
  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,headRefOid,mergeable,isDraft,url'
  ], undefined, { cwd, env, backoffKey: repoSpec }).catch((err) => {
    if (isForgeNoAccessError(err)) {
      // Permanent until credentials change — one actionable line naming the
      // remedy, not one per scheduler tick.
      logForgeNoAccessOnce('branch-reconcile', repoSpec, err.message);
    } else if (!isHostShuttingDown() && err.name !== 'AbortError') {
      console.error(`❌ branch-reconcile: gh pr list failed for ${repoSpec}: ${err.message}`);
    }
    return null;
  });
  if (raw === null) return null;
  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) {
    console.error(`❌ branch-reconcile: gh pr list returned unparseable output for ${repoSpec} — PR state unknown this cycle`);
    return null;
  }
  const byHead = new Map();
  for (const pr of parsed) {
    if (pr?.headRefName) {
      byHead.set(pr.headRefName, {
        number: pr.number,
        mergeable: pr.mergeable || 'UNKNOWN',
        isDraft: pr.isDraft === true,
        url: pr.url || '',
        headRefOid: typeof pr.headRefOid === 'string' ? pr.headRefOid : null
      });
    }
  }
  return byHead;
}

/**
 * Whether the forge shows `branch` never shipped: no open PR, and none closed
 * unmerged (a deliberate decision, e.g. superseded, that a second PR must not
 * override). A merged PR does not count — later commits are new work. Null when
 * the forge cannot answer (non-GitHub origin, gh failure, unparseable output):
 * an exact `--head` query rather than `getOpenPrsByHead`'s capped list, whose
 * empty Map for a non-GitHub origin must never read as "no PR" to a caller
 * releasing a hold.
 * @returns {Promise<boolean|null>}
 */
export async function readBranchUnshipped(repoPath, branch, { origin, forgeExec = null, forgeAccount = null } = {}) {
  const repoSpec = githubRepoSpec(origin === undefined ? await getOriginInfo(repoPath).catch(() => null) : origin);
  if (!repoSpec || !branch) return null;
  const { cwd, env } = forgeExec || await resolveForgeExecOptions(repoPath, { forgeAccount });
  const raw = await execGh(['pr', 'list', '--repo', repoSpec, '--state', 'all', '--head', branch, '--json', 'state'],
    undefined, { cwd, env }).catch(() => null);
  const parsed = raw === null ? null : safeJSONParse(raw, null);
  return Array.isArray(parsed) ? parsed.every(pr => pr?.state === 'MERGED') : null;
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
 * A claim run that cut a `claim-*` checkout itself still lists the source
 * repository as its workspace, so neither `activeAgentIds` nor the branch name
 * proves it gone. The registry's branch/repository bindings do: a pinned or
 * bound branch is `claim-owner-active`, and a picker (or a pinned run still
 * choosing, as a tracking epic does before it picks its child) makes every
 * claim checkout in its repository `claim-owner-ambiguous`.
 *
 * `claimOwners` is `{ agents }` from the caller. Omitted (undefined) means the
 * caller does not dispatch or mutate on this answer (a read-only detector) and
 * nothing is added; supplied but unreadable holds every branch.
 *
 * @param {{ branch: string, path: string|null, claimOwners?: { agents: object[]|null, readAgents?: () => Promise<object[]> }, sourceWorkspace: string }} input
 * @returns {string|null}
 */
function resolveClaimOwnerReason({ branch, path, claimOwners, sourceWorkspace }) {
  if (claimOwners === undefined) return null;
  return claimCheckoutOwnerReason({
    branchName: branch,
    holderPath: path,
    sourceWorkspace,
    agents: claimOwners?.agents ?? null,
  });
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
async function worktreeDirtyPaths(worktreePath) {
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

/** Newline-separated git stdout → trimmed non-empty lines. */
const gitLines = (stdout) => (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

// Files nearly every branch touches. They collide constantly and are real merge
// conflicts, so they stay in the collision list — but they never carry evidence
// that a feature was reimplemented, so they sort last and don't crowd out the
// source files that do. Without this the changelog leads the list alphabetically
// on virtually every branch.
const CHURN_COLLISION_RE = /(^|\/)(\.changelog\/|CHANGELOG|README|package-lock\.json$|package\.json$|PLAN\.md$)/i;

/** Sort collisions so supersession-bearing source files come before churn files. */
const byCollisionSignal = (a, b) => {
  const rank = (p) => (CHURN_COLLISION_RE.test(p) ? 1 : 0);
  return rank(a) - rank(b) || a.localeCompare(b);
};

/**
 * How far a branch has drifted from the default branch, and — the part that
 * matters — WHICH of the files it touches the default branch has ALSO changed
 * since the two diverged.
 *
 * That intersection is the deterministic evidence for "is this work still
 * needed?". A branch that sat for a hundred commits may hold a feature someone
 * solved a different (usually better) way on the default branch in the meantime;
 * merging it then REGRESSES the default branch rather than adding to it. Neither
 * `git status` nor the branch's own changelog entry shows this — both look like
 * healthy work-in-progress. The collision set does, and it points the agent at
 * exactly the files to read before it commits to anything.
 *
 * Covers uncommitted work too: for an abandoned worktree the branch has no
 * commits of its own, so the dirty paths ARE the change set, and a `merge-tree`
 * probe against the branch tip would report a clean merge while the real
 * collision sits in the working tree.
 *
 * Every field degrades to a safe unknown (`null` counts, `[]` collisions) rather
 * than a wrong answer — a git failure here must not read as "no drift".
 *
 * @param {string} repoPath
 * @param {string} branch
 * @param {string} defaultBranch
 * @param {string[]} [dirtyPaths] - uncommitted paths from the branch's worktree
 * @returns {Promise<{ behind:number|null, ahead:number|null, collisionPaths:string[] }>}
 */
export async function gatherDivergence(repoPath, branch, defaultBranch, dirtyPaths = []) {
  const counts = await execGit(
    ['rev-list', '--left-right', '--count', `${defaultBranch}...${branch}`], repoPath, { ignoreExitCode: true }
  ).catch(() => null);
  const [behindRaw, aheadRaw] = (counts?.stdout || '').trim().split(/\s+/);
  const behind = Number.isFinite(Number(behindRaw)) && behindRaw !== '' ? Number(behindRaw) : null;
  const ahead = Number.isFinite(Number(aheadRaw)) && aheadRaw !== '' ? Number(aheadRaw) : null;

  const base = await execGit(['merge-base', branch, defaultBranch], repoPath, { ignoreExitCode: true })
    .catch(() => null);
  const mergeBase = (base?.stdout || '').trim();
  if (!mergeBase) return { behind, ahead, collisionPaths: [] };

  const [defaultChanged, branchChanged] = await Promise.all([
    execGit(['diff', '--name-only', mergeBase, defaultBranch], repoPath, { ignoreExitCode: true }).catch(() => null),
    execGit(['diff', '--name-only', mergeBase, branch], repoPath, { ignoreExitCode: true }).catch(() => null)
  ]);
  const defaultSet = new Set(gitLines(defaultChanged?.stdout));
  if (defaultSet.size === 0) return { behind, ahead, collisionPaths: [] };

  const touched = new Set([...gitLines(branchChanged?.stdout), ...dirtyPaths]);
  return { behind, ahead, collisionPaths: [...touched].filter((p) => defaultSet.has(p)).sort(byCollisionSignal) };
}

// The only remote branch-reconcile acts on. `deleteBranch(…, { remote: true })`
// hardcodes `git push origin --delete`, so a branch tracking anything else is
// reported rather than reaped — there is no code path that could delete it
// correctly, and guessing one is how you delete the wrong ref.
const RECONCILED_REMOTE = 'origin';

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
 * Ground truth for what branches exist on `origin` right now, or `null` when the
 * remote could not be read.
 *
 * `refs/remotes/origin/*` is deliberately NOT the source here: nothing in the
 * reconcile path fetches, so those refs reflect whenever someone last pulled.
 * Acting on a stale view means either deleting a ref that has since moved, or
 * missing one entirely — and one `ls-remote` per cycle buys the real answer.
 *
 * `null` (not an empty Map) on failure, for the same reason `getOpenPrsByHead`
 * distinguishes them: "we could not ask" must never read as "the remote has no
 * branches", which would make every branch look like its remote was already gone.
 *
 * @param {string} repoPath
 * @returns {Promise<Map<string,string>|null>}
 */
export async function listRemoteHeads(repoPath) {
  const res = await execGit(['ls-remote', '--heads', RECONCILED_REMOTE], repoPath, { ignoreExitCode: true })
    .catch((err) => ({ error: err.message, signal: err.signal }));
  if (!res || res.exitCode !== 0) {
    if (isHostShuttingDown() || res?.signal === 'SIGTERM') return null;
    // One log line serves every caller across every managed app, so it has to
    // name the repo that went unread and git's own reason — without both, a
    // network blip, an unauthenticated remote and a repo with no `origin` at
    // all are one indistinguishable line and the operator has nothing to act on.
    const why = (res?.error || res?.stderr || '').trim().split('\n')[0] || (res?.signal ? `signal ${res.signal}` : `exit ${res?.exitCode}`);
    console.error(`❌ branch-reconcile: git ls-remote ${RECONCILED_REMOTE} failed in ${repoPath} (${why}) — remote branch state unknown this cycle`);
    return null;
  }
  return parseRemoteHeads(res.stdout);
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

/**
 * Report or retire `origin` branches nothing local points at. Retirement shares
 * the endpoint-bound Git cleanup action and its fresh ownership gates.
 *
 * PEER SAFETY. This is the only part of reconcile that looks at the remote, and
 * a federated peer's in-progress branch looks exactly like an orphan from here —
 * it has no local counterpart on THIS machine because it never did. What makes
 * the sweep safe is not knowing whose branch it is but what state it is in:
 * deletion requires the branch to be already merged into the default branch, and
 * no machine can lose work that the default branch already carries. Anything
 * unmerged is reported and left alone, whoever pushed it.
 *
 * Merge-checked against the SHA `ls-remote` just reported, NOT `origin/<branch>`:
 * a stale remote-tracking ref can say "merged" about commits that origin has
 * since moved past, and reaping on that is how you delete unmerged work. An
 * unresolvable SHA (a branch this clone has never fetched) is `unknown`, which
 * fails closed to report-only.
 *
 * `reap` opts in to endpoint-bound retirement of this scan's candidates only.
 * The shared helper refreshes the default and rechecks the remote head, local
 * holders, live owners and completion policy before an exact leased push.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {{ reap?: boolean }} [opts] - deletes verified merged orphans when enabled
 * @returns {Promise<{reaped:string[], reported:{branch:string,reason:string}[], remoteUnavailable?:boolean}>}
 */
export async function reapOrphanedRemotes(repoPath, defaultBranch, { reap = false } = {}) {
  const [remoteHeads, localBranches] = await Promise.all([
    listRemoteHeads(repoPath),
    getBranches(repoPath).catch(() => null)
  ]);
  // Either read failing makes "nothing local claims this" unknowable, and an
  // unknowable claim set would make every remote branch look orphaned.
  if (!remoteHeads || !localBranches) {
    return { reaped: [], reported: [], remoteUnavailable: true };
  }

  const orphans = partitionRemoteOrphans(remoteHeads, localBranches, { defaultBranch });
  const reaped = [];
  const reported = [];
  const candidates = [];
  for (const { branch, sha } of orphans) {
    const hasMergeEvidence = await hasBranchMergeEvidence(repoPath, sha, defaultBranch).catch(() => false);
    if (!hasMergeEvidence) {
      reported.push({ branch, reason: 'unmerged-remote-only' });
      continue;
    }
    if (!reap) {
      reported.push({ branch, reason: 'reap-disabled' });
      continue;
    }
    candidates.push(branch);
  }
  if (candidates.length) {
    const retired = await deleteMergedRemoteBranches(repoPath, candidates, { defaultBranch });
    reaped.push(...retired.deleted);
    reported.push(...retired.skipped);
  }
  // Report-only is silent work unless it says so — without this line a merged
  // orphan is detected every cycle and never surfaces anywhere a human looks.
  const reapable = reported.filter((r) => r.reason === 'reap-disabled').length;
  if (reapable) {
    console.log(`🔀 branch-reconcile: ${reapable} merged branch(es) on ${RECONCILED_REMOTE} nothing local points at — reap is opt-in, not deleted`);
  }
  return { reaped, reported };
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
async function worktreeAgeMs(worktreePath) {
  const st = await stat(worktreePath).catch(() => null);
  return st ? Math.max(0, Date.now() - st.mtimeMs) : null;
}

/**
 * Gather the raw git/PR facts for every local feature branch in `repoPath`.
 * Excludes the default branch, the currently-checked-out branch, and the
 * always-protected set. Effectful (git + gh).
 *
 * @param {string} repoPath
 * @param {{ defaultBranch:string, activeAgentIds?:Set<string>, remoteHeads?:Map<string,string>|null, hasOrigin?:boolean, origin?:object|null }} ctx
 *   `activeAgentIds` distinguishes a live agent's worktree from an abandoned one (see
 *   `isAbandonedAgentWorktree`); the scheduler also includes live worktree basenames
 *   so claim paths owned by an active run remain protected. Omitting it leaves every
 *   agent worktree protected.
 *   `remoteHeads` is `listRemoteHeads`' answer when the caller already has it;
 *   omitted, this reads it itself when the repo has an origin, and `null`
 *   (unreadable remote, or no origin to read) is carried through as "we could
 *   not ask" rather than "the remote is empty".
 *   `hasOrigin` is `getOriginInfo`'s verdict when the caller already has it (same
 *   rationale); omitted, this reads it itself, so a standalone caller still gets a
 *   truthful answer rather than the fail-closed default.
 *   `forgeExec` is the per-repo gh credential overlay (`{cwd, env}`) when the
 *   caller already resolved it; `forgeAccount` is the app record's explicit gh
 *   pin for the standalone case. Both feed `getOpenPrsByHead` — see #7540.
 * @returns {Promise<object[]>} one entry per candidate branch:
 *   { branch, tip, hasUpstream, hasOrigin, tracking, upstreamGone, isMerged, hasWorktree, worktreePath,
 *     worktreeDirty, dirtyPaths, behind, ahead, collisionPaths, abandonedAgentWorktree,
 *     abandonedClaimWorktree, openPr }
 */
export async function gatherBranchState(repoPath, { defaultBranch, activeAgentIds = null, claimOwners = undefined, remoteHeads: providedRemoteHeads, hasOrigin: providedHasOrigin, origin: providedOrigin, forgeExec = null, forgeAccount = null, pendingMergeBranches = undefined } = {}) {
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);
  // Read origin ONCE and use it for both facts below — `hasOrigin` (the gate on
  // classifyBranch's ahead-based NEEDS_PR arm, so an origin-less repo's local work
  // is never dispatched to a coordinator whose only move is a push that cannot
  // land) and the PR query's host-qualified repo selector. Skipped entirely when
  // the caller already vouched for `hasOrigin`, in which case getOpenPrsByHead
  // resolves origin itself as it always has.
  const origin = providedOrigin !== undefined
    ? providedOrigin
    : providedHasOrigin === undefined
    ? await getOriginInfo(repoPath).catch(() => null)
    : undefined;
  const hasOrigin = providedHasOrigin === undefined
    ? Boolean(origin?.hasOrigin)
    : Boolean(providedHasOrigin);

  // The remote read is gated on `hasOrigin` for the same reason reconcile's own
  // two are: a repo with no `origin` has no remote to ask, and probing one
  // anyway logs a failure every cycle. This gather runs once per managed app in
  // the read-only leftover-branch detector, and an app's repoPath can be a
  // directory that was never a clone — `null` there means "could not ask",
  // which is exactly what an origin-less repo can answer.
  const snapshot = readRepoBranchSnapshot(repoPath, { strict: false });
  const [branches, { worktrees, tips }, prsByHeadOrNull, remoteHeads] = await Promise.all([
    getBranches(repoPath, { snapshot }),
    snapshot,
    getOpenPrsByHead(repoPath, origin, { forgeExec, forgeAccount }),
    providedRemoteHeads !== undefined ? providedRemoteHeads
      : hasOrigin ? listRemoteHeads(repoPath)
      : null
  ]);
  // null = the forge could not be read (see getOpenPrsByHead). Carried onto every
  // input so the classifier can refuse to conclude "no PR" from an unread forge.
  const prStateUnavailable = prsByHeadOrNull === null;
  const prsByHead = prsByHeadOrNull || new Map();

  // Map local branch name -> worktree record (strip the refs/heads/ prefix).
  const worktreeByBranch = new Map();
  for (const wt of worktrees) {
    const name = wt.branch?.replace(/^refs\/heads\//, '');
    if (name) worktreeByBranch.set(name, { path: wt.path, locked: Boolean(wt.locked) });
  }

  const candidates = branches.filter(
    (b) => !b.isDefault && !b.current && !protectedSet.has(b.name)
  );

  const { readBranchCompletionPolicies, readBranchCompletionHoldDetail, indexBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
  const completionPolicies = candidates.length ? await readBranchCompletionPolicies({ repoPath }).catch(() => null) : [];
  const policyIndex = indexBranchCompletionPolicies(repoPath, completionPolicies);

  const inputs = [];
  for (const b of candidates) {
    // Enumeration captured the commit paired with this name. Retirement reads
    // the local ref and holder again under its mutation guards.
    const tip = b.tip ?? null;
    const upstreamName = upstreamBranchName(b.tracking);
    const wt = worktreeByBranch.get(b.name) || null;
    const worktreePath = wt?.path || null;
    const worktreeLocked = Boolean(wt?.locked);
    const worktreeAge = worktreePath ? await worktreeAgeMs(worktreePath) : null;
    const observedPaths = worktreePath ? await worktreeDirtyPaths(worktreePath) : [];
    const worktreeStatusUnavailable = observedPaths === null;
    const dirtyPaths = observedPaths || [];
    const worktreeDirty = dirtyPaths.length > 0;
    const divergence = await gatherDivergence(repoPath, b.name, defaultBranch, dirtyPaths);
    // getBranches' `merged` is ancestor-based (misses squash/rebase); confirm
    // the harder cases via hasBranchMergeEvidence (covers squash + rebase). Short
    // -circuit when the cheap check already proved it merged.
    const hasMergeEvidence = b.merged || await hasBranchMergeEvidence(repoPath, b.name, defaultBranch, tips);
    const claimOwnerReason = resolveClaimOwnerReason({ branch: b.name, path: worktreePath, claimOwners, sourceWorkspace: repoPath });
    const completionHold = await readBranchCompletionHoldDetail({ repoPath, branch: b.name, prUrl: prsByHead.get(b.name)?.url, tip, policyIndex, retirement: hasMergeEvidence });
    const completionPolicyReason = completionHold.reason;
    // The scan and the coordinator's recheck (cosClaimOwnership) must agree on
    // which review branches are unshipped, so both ask the same forge question.
    const completionReviewUnshipped = completionHold.unshipped === true
      && await readBranchUnshipped(repoPath, b.name, { origin, forgeExec, forgeAccount }) === true;
    inputs.push({
      branch: b.name,
      tip,
      completionPolicyReason,
      completionReviewUnshipped,
      ...(completionPolicyReason ? { completionPolicyWorkflow: completionPolicyReason === 'pr-completion-review-required'
        ? 'Resume the configured review workflow; delivery success does not prove review passed.'
        : completionPolicyReason === 'pr-completion-human-handoff'
          ? 'Await the human handoff or an explicit later authorization for this exact PR.'
          : 'Restore readable completion-policy records before reconciling this branch.' } : {}),
      hasUpstream: Boolean(b.tracking),
      hasOrigin,
      // Kept alongside the boolean because cleanup needs the NAME, not just the
      // fact: a branch may track a remote branch called something else, and the
      // remote-side delete has to name the right ref.
      tracking: b.tracking || null,
      // This branch was pushed, and the ref it tracks is no longer on origin —
      // the tell that its PR merged with `--delete-branch`. Read from
      // `listRemoteHeads`, not `%(upstream:track)`'s `[gone]`: that marker is
      // computed against `refs/remotes/origin/*`, which this module already
      // documents as too stale to act on (see listRemoteHeads). An unreadable
      // remote (`null`) yields false — "we could not ask" must not read as
      // "the remote branch is gone". See the SHIPPED_CLAIM note on cleanupMerged.
      upstreamGone: Boolean(remoteHeads) && upstreamName !== null && !remoteHeads.has(upstreamName),
      // Origin lists this branch (or the one it tracks): merged retirement holds
      // a published branch with no PR merged at its head as a claim (#16625).
      // False here only means this read did not see it; retirement still reads
      // the local remote-tracking refs.
      published: Boolean(remoteHeads) && (remoteHeads.has(b.name) || (upstreamName !== null && remoteHeads.has(upstreamName))),
      isMerged: hasMergeEvidence,
      hasWorktree: Boolean(worktreePath),
      worktreePath,
      worktreeLocked,
      worktreeAgeMs: worktreeAge,
      worktreeDirty,
      worktreeStatusUnavailable,
      dirtyPaths,
      // Non-null ⇒ somebody owns this branch right now (active CoS agent / live
      // human claim / locked worktree). Built on the same predicate `cleanupMerged`
      // uses to refuse a teardown, reused by the classifier to refuse a DISPATCH —
      // the two must agree, or the reconciler protects a worktree from deletion and
      // then hands its branch to an agent that rebases underneath the live session.
      // A registered claim owner counts too: a run that cut its own claim tree
      // keeps the source repository as its workspace, so neither the basename
      // set nor the branch name can see it (#10089).
      //
      // A branch queued for the pr-watcher's merge coordinator (an agent handoff
      // receipt or a merge-on-green PR) has an open PR and no live agent, yet the
      // coordinator owns its merge: a reconcile agent waiting on CI or rebasing
      // would race it and invalidate the handoff's head binding.
      liveOwnerReason: gatheredHoldReason({
        liveOwnerReason: resolveLiveOwnerReason({ branch: b.name, path: worktreePath, locked: worktreeLocked, activeAgentIds }),
        claimOwnerReason, pendingMergeBranches, branch: b.name, worktreeStatusUnavailable,
      }),
      claimOwnerReason,
      behind: divergence.behind,
      ahead: divergence.ahead,
      collisionPaths: divergence.collisionPaths,
      abandonedAgentWorktree: isAbandonedAgentWorktree({ path: worktreePath, locked: worktreeLocked, activeAgentIds }),
      abandonedClaimWorktree: isAbandonedClaimWorktree({ path: worktreePath, locked: worktreeLocked, worktreeDirty, activeAgentIds }),
      openPr: prsByHead.get(b.name) || null,
      prStateUnavailable
    });
  }
  return inputs;
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

// A local checkout can be retired without owning the global issue reservation.
// Peer installs share a forge login, and a peer may reserve before its first
// commit/push. Neither that login nor an absent remote branch proves release
// authority, so markers are never written here. A read that shows no
// reservation to own (a closed issue, or an open one with no claim label and
// no assignee) settles the report; anything else stays a visible hold.
async function retainedClaimMarkers(repoPath, branch, { origin, forgeExec = null } = {}) {
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
    const { isMergedPrHead } = await import('./prProbe.js');
    if ((dirty || ownershipHold) && await isMergedPrHead(repoPath, b.branch, head)) {
      opts = { ...opts, shippedHead: head, ...(dirty && { disposableHead: head }) };
    }
    const issue = claimIssueOfBranch(b.branch);
    if (issue && lineage === 'ancestry') {
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
  const completionPolicy = await import('./branchCompletionPolicy.js');
  const completionEvidence = () => import('./completedCheckoutEvidence.js');
  const readPolicyHold = async (tip) => {
    const input = { repoPath, branch: b.branch, tip, retirement: mergedRetirement };
    if (!superseded || b.openPr) return completionPolicy.readBranchCompletionHold(input);
    const agents = await completionPolicy.readBranchCompletionPolicies({ repoPath }).catch(() => null);
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

/** Time since the checkout last changed: its directory, index or HEAD log. Null when unreadable. */
export async function checkoutIdleMs(worktreePath) {
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], worktreePath).catch(() => null))?.stdout?.trim();
  if (!gitDir) return null;
  const stamps = await Promise.all([worktreePath, join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD')]
    .map(path => stat(path).then(st => st.mtimeMs, error => (error.code === 'ENOENT' ? 0 : null))));
  if (stamps.some(stamp => stamp === null)) return null;
  return Math.max(0, Date.now() - Math.max(...stamps));
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
        const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
        const { hasCompletedCheckoutEvidence } = await import('./completedCheckoutEvidence.js');
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
    const { getAppById } = await import('./apps.js');
    const app = await getAppById(appId);
    if (!app?.repoPath || resolve(app.repoPath) !== resolve(repoPath)) return { ok: false, reason: 'retirement-receipt-scope-unavailable' };
  }
  const deleted = await deleteCompletedLocalBranch(repoPath, b.branch, expectedHead, {
    // Display history only: a failed write never fails a completed removal.
    onRetired: async () => {
      if (!appId) return;
      const absent = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${b.branch}`], repoPath, { ignoreExitCode: true });
      if (absent.exitCode !== 1) return;
      const { recordHeldCheckoutRetirement } = await import('./branchReconcileOutcome.js');
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
async function gatherDetachedWorktrees(repoPath, defaultBranch, preloadedTrees = null) {
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
async function gatherRecoveryWorktrees(repoPath, preloadedTrees = null) {
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
  const outcomes = await import('./branchReconcileOutcome.js');
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
async function reapDetachedWorktrees(repoPath, defaultBranch, detached, { activeAgentIds, claimOwners, appId = null } = {}) {
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

/**
 * Full Tier-1 reconcile: gather → classify → clean up merged work.
 * Superseded work is retained unless its separate backup-and-retire path is opted into.
 * Returns the in-flight set (branches needing an agent) for the scheduler to dispatch.
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ cleanup?: boolean, reapSuperseded?: boolean, reapRemotes?: boolean, activeAgentIds?: Set<string> }} [opts] - when
 *   cleanup is false, merged branches are reported (in `skipped`, reason
 *   `cleanup-disabled`) but not deleted. `reapSuperseded` (default false)
 *   explicitly opts into the separate destructive step for verified-superseded
 *   branches, whose work is NOT on the default branch and survives only as a backup. `reapRemotes` (default false) reports merged remote orphans
 *   using endpoint-bound retirement — see `reapOrphanedRemotes`. `activeAgentIds` protects in-use CoS
 *   agent worktrees and any live worktree basename tokens supplied by the caller.
 *   `claimOwners` (`{ agents, readAgents? }`, the agent registry) adds the
 *   registered claim owners — see `resolveClaimOwnerReason`; a dispatching
 *   caller must pass it. `readAgents` re-reads the registry right before each
 *   retirement, because a claim run can bind a branch after the scan.
 *   `pendingMergeBranches` (Set, or null for an unreadable app record) holds the
 *   branches queued for the pr-watcher merge coordinator — see `gatheredHoldReason`.
 *   `forgeAccount` is the managed app record's explicit gh
 *   account pin, so an app whose repo belongs to another GitHub account is
 *   polled with a credential that can actually see it (#7540); unset, the
 *   owner-match in `forgeAuth.resolveForgeForRepo` still applies.
 * @returns {Promise<{ defaultBranch:string, cleaned:string[], inFlight:object[], wip:object[], merged:object[], skipped:{branch:string,reason:string}[], orphanRemotes:{reaped:string[],reported:object[]}, forgeUnavailable?:boolean, prStateUnavailable?:boolean }>}
 *   A `wip` entry with a `liveOwnerReason` is held because a live agent/claim/lock
 *   owns it — the "leave it alone, this reconcile IS done" case. `superseded` holds
 *   only the verified-superseded branches the reap could NOT take this cycle; the
 *   ones it took are named in `reapedSuperseded`, kept OUT of `cleaned` because
 *   that key means "merged" to its readers.
 *   `forgeUnavailable: true` means the cycle was SKIPPED before it started because
 *   the `gh` probe failed; `prStateUnavailable: true` means it ran but a gh read
 *   failed mid-cycle. Either way an empty `inFlight` says nothing about the repo
 *   and the caller must retry rather than park on it (#3358).
 */
export async function reconcile(repoPath = PATHS.root, { cleanup = true, reapSuperseded = false, reapRemotes = false, activeAgentIds = new Set(), claimOwners = undefined, forgeAccount = null, pendingMergeBranches = undefined, appId = null } = {}) {
  if (claimOwners === undefined) claimOwners = { agents: await readClaimOwnershipAgents(), readAgents: readClaimOwnershipAgents };
  // Worktree cleanup is the first reconcile step, before any forge probe. It
  // only removes a tree after proving both that it is completely clean and
  // that every branch commit is already in the default branch (including
  // squash/rebase-equivalent merges). Keeping this pass ahead of gh means a
  // temporary forge outage cannot strand locally-provable completed work.
  const worktreeCleanup = cleanup
    ? await reapMergedWorktrees(repoPath, { activeAgentIds, claimOwners, includeClaudeTrees: true, ...(appId && { appId }) }).catch(() => ({ reaped: [] }))
    : { reaped: [] };
  const cleanedWorktrees = (worktreeCleanup.reaped || []).filter(entry => typeof entry === 'string' || entry?.branchDeleted)
    .map((entry) => typeof entry === 'string' ? entry : entry?.branch)
    .filter(Boolean);

  // On a GitHub repo every classification below depends on PR state, so an
  // unreadable forge makes the whole pass a guess — skip with one line rather
  // than report a quiet repo. Probed against THIS repo's API host
  // (enterprise-correct): a bare probe would gate an enterprise checkout on
  // github.com's health.
  //
  // A NON-GitHub repo (GitLab, no origin) is deliberately not gated: it has no
  // `gh` PR state to lose — `getOpenPrsByHead` returns an empty Map by design —
  // and gating it on a `gh` probe that will never pass would permanently block
  // the git-only merged-branch cleanup those repos still benefit from.
  const origin = await getOriginInfo(repoPath).catch(() => null);
  // Resolve the per-repo gh credential ONCE per cycle and reuse it for the
  // reachability probe and the PR read — a second resolve would re-run the same
  // bounded git+gh probes for an answer that cannot have changed mid-cycle.
  const forgeExec = githubRepoSpec(origin)
    ? await resolveForgeExecOptions(repoPath, { forgeAccount })
    : null;
  // The early reaper may have deleted the branch before gather can see it.
  // Report their global reservation separately, including during forge outages
  // (no issue read then, so each stays held).
  const readEarlyMarkerHolds = async (markerForge) => {
    const holds = [];
    for (const entry of worktreeCleanup.reaped || []) {
      if (!entry?.branchDeleted) continue;
      const markerHold = await retainedClaimMarkers(repoPath, entry.branch, { origin, forgeExec: markerForge });
      if (markerHold) holds.push(markerHold);
    }
    return holds;
  };
  if (forgeExec) {
    const forge = await ensureForgeReachable('branch-reconcile', {
      hostname: githubApiHost(origin.host),
      ...(forgeExec?.customEnv ? { env: forgeExec.customEnv } : {}),
    });
    if (!forge.ok) {
      return { defaultBranch: null, cleaned: cleanedWorktrees, inFlight: [], wip: [], skipped: [], claimMarkersHeld: await readEarlyMarkerHolds(null), forgeUnavailable: true, forgeStatus: forge.status };
    }
  }
  const claimMarkersHeld = await readEarlyMarkerHolds(forgeExec);

  const defaultBranch = await getDefaultBranch(repoPath).catch(() => 'main') || 'main';
  // The gather needs origin's branch list to tell a shipped claim from a live
  // one. A repo with no origin has no remote to ask (null → nothing reads as
  // gone, which is the safe direction) — gated on `hasOrigin`, not on `origin`
  // itself, which is a populated object even for an origin-less repo.
  //
  // Deliberately NOT shared with reapOrphanedRemotes below: that step DELETES
  // remote branches, and this read happens before cleanupMerged runs, so handing
  // it this list would have it act on a view of origin taken a step earlier —
  // exactly the staleness listRemoteHeads exists to avoid. One extra ls-remote
  // per cycle is the cost of each destructive step reading the remote itself.
  const remoteHeads = origin?.hasOrigin ? await listRemoteHeads(repoPath) : null;
  const inputs = await gatherBranchState(repoPath, {
    defaultBranch, activeAgentIds, claimOwners, remoteHeads, hasOrigin: Boolean(origin?.hasOrigin), origin,
    forgeExec, forgeAccount, pendingMergeBranches
  });
  // A gh failure AFTER a passing probe (a blip mid-cycle, or an unparseable
  // page) is still "we could not ask" — surface it so the caller retries next
  // tick instead of parking on an in-flight set built from unknown PR state.
  const prStateUnavailable = inputs.some((i) => i.prStateUnavailable);
  const classified = classifyBranches(inputs);

  const merged = classified.filter((c) => c.state === 'MERGED');
  // Priority-ordered so the coordinator agent works recognized work branches
  // (claim/cos/next/feature/fix/…) before anything unrecognized. The order flows
  // straight through filterActionable (a stable filter) into the prompt block.
  const allInFlight = prioritizeBranches(
    classified.filter((c) => ['ABANDONED_WIP', 'CONFLICTED', 'IN_REVIEW', 'NEEDS_PR'].includes(c.state))
  );
  // A branch already judged SUPERSEDED is left untouched by design and is never
  // `isMerged` (its work landed under other names), so nothing reaps it and it
  // stays in-flight forever — re-analyzed at full cost on every recheck. Drop it
  // out of the actionable set on a cached verdict that still verifies (#3842).
  const { actionable: inFlight, superseded } = await applySupersededLedger(repoPath, allInFlight, defaultBranch);
  // A cached superseded verdict avoids repeated analysis but does not prove
  // the branch merged. Retain it by default; an explicit caller opt-in uses the
  // backup-first retirement path and the same owner/holder gates as merged work.
  const supersededReap = reapSuperseded
    ? await reapSupersededBranches(repoPath, defaultBranch, superseded, { activeAgentIds, claimOwners, appId })
    : { reaped: [], held: superseded, skipped: superseded.map((b) => ({ branch: b.branch, reason: 'reap-superseded-disabled' })) };
  // Every WIP entry carries its `liveOwnerReason`, so a caller that needs the
  // "held by a live owner" subset (to report "the only branches left belong to
  // running sessions" rather than a bare "nothing actionable") filters `wip` on it.
  const wip = classified.filter((c) => c.state === 'WIP');

  const { cleaned: cleanedBranches, skipped, claimMarkersHeld: mergedMarkerHolds = [] } = cleanup
    ? await cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds, claimOwners, origin, forgeExec, forgeAccount, appId })
    : { cleaned: [], skipped: merged.map((m) => ({ branch: m.branch, reason: 'cleanup-disabled' })) };
  // Detached worktrees have no branch, so nothing above can see them (#10825).
  const postCleanupWorktrees = await listWorktrees(repoPath).catch(() => []);
  const detachedWorktrees = await gatherDetachedWorktrees(repoPath, defaultBranch, postCleanupWorktrees);
  const detachedReap = cleanup
    ? await reapDetachedWorktrees(repoPath, defaultBranch, detachedWorktrees, { activeAgentIds, claimOwners, appId })
    : { cleaned: [], skipped: [], held: [] };
  const cleaned = [...new Set([...cleanedWorktrees, ...cleanedBranches, ...detachedReap.cleaned])];

  // Runs AFTER cleanupMerged on purpose: that step deletes merged local branches
  // and leaves their `origin/*` counterpart behind, which is precisely the orphan
  // this sweep exists to notice. Skipped entirely on a repo with no origin —
  // there is no remote to read, and probing one every cycle would log a failure
  // forever. Gated on `hasOrigin`, NOT on `origin` itself: getOriginInfo returns a
  // fully-populated object with `hasOrigin: false` for an origin-less repo, so a
  // truthiness check would pass and re-introduce exactly that per-cycle failure.
  // Report-only unless the caller opts into `reapRemotes`.
  const orphanRemotes = origin?.hasOrigin
    ? await reapOrphanedRemotes(repoPath, defaultBranch, { reap: reapRemotes })
    : { reaped: [], reported: [] };

  return {
    defaultBranch,
    cleaned,
    claimMarkersHeld: [...claimMarkersHeld, ...mergedMarkerHolds],
    // Kept OUT of `cleaned`: readers of that key render it as "deleted merged
    // branch" (repoSync.js) and a superseded branch is precisely not merged.
    reapedSuperseded: supersededReap.reaped,
    inFlight,
    // Only the branches still standing — listing a deleted one would put it in
    // the coordinator prompt.
    superseded: supersededReap.held,
    wip,
    // Retained MERGED claims may need their completed owner's cleanup policy
    // reviewed. They are not WIP, so do not hide them from that second stage.
    merged: merged.filter(branch => skipped.some(row => row.branch === branch.branch)),
    skipped: [...skipped, ...supersededReap.skipped, ...detachedReap.skipped],
    // Detached trees at merged commits that were NOT removed, managed or not.
    detachedWorktrees: detachedReap.held,
    worktreeInventory: await gatherRecoveryWorktrees(repoPath, detachedReap.cleaned.length === 0 ? postCleanupWorktrees : null),
    orphanRemotes,
    prStateUnavailable
  };
}

/**
 * Resolve each cached SUPERSEDED verdict against the repo as it stands now and
 * split the in-flight set accordingly. A verdict survives only while its
 * `replacedBy` commits are still reachable from the default branch — a revert of
 * what superseded the branch makes the branch wanted again, and that is the one
 * change the pure freshness check can't see on its own.
 *
 * Fails OPEN in every direction: an unreadable ledger, an unresolvable SHA, or a
 * git error all yield "not cached", which restores full analysis rather than
 * silently hiding a branch that needs work.
 *
 * @param {string} repoPath
 * @param {object[]} inFlight
 * @param {string} defaultBranch
 * @returns {Promise<{ actionable: object[], superseded: object[] }>}
 */
async function applySupersededLedger(repoPath, inFlight, defaultBranch) {
  const entries = await readVerdictLedger().catch(() => []);
  if (!entries.length || !inFlight.length) return { actionable: inFlight, superseded: [] };

  // Only the SHAs belonging to entries that could still match are probed, so a
  // large stale ledger costs nothing.
  const relevant = new Set(inFlight.map((b) => b.branch));
  const shas = [...new Set(
    entries.filter((e) => e.repoPath === repoPath && relevant.has(e.branch)).flatMap((e) => e.replacedBy || [])
  )];
  const reachable = new Set();
  for (const sha of shas) {
    const ok = await execGit(['merge-base', '--is-ancestor', sha, defaultBranch], repoPath, { ignoreExitCode: true })
      .then((r) => r?.exitCode === 0)
      .catch(() => false);
    if (ok) reachable.add(sha);
  }
  return partitionSuperseded(
    inFlight, entries, (e) => (e.replacedBy || []).every((s) => reachable.has(s)), { repoPath }
  );
}

// ============================================================
// Coordinator prompt helpers (Tier-2 dispatch)
//
// These turn the classified `inFlight` set into the actionable subset + the
// Markdown block injected into the `branch-reconcile` CoS task prompt. They live
// here (next to the classifier that produces their input) rather than in the
// scheduler/generator so both the perpetual-drain gate and any prompt builder
// share one source of truth. The `actions` object mirrors the per-app task
// metadata toggles (cleanupMerged / openPr / resolveConflicts / autoMerge /
// finishAbandoned).
// ============================================================

/** An action is ON unless the config explicitly set it to false (opt-out). */
export const actionOn = (actions, key) => actions?.[key] !== false;

/**
 * Which in-flight branches have an enabled action? Pure — drives both the
 * drain gate (dispatch nothing when empty → park) and the prompt payload.
 * @param {object[]} inFlight - reconcile()'s inFlight entries (with `state`)
 * @param {object} actions - the per-app action toggles
 */
export function filterActionable(inFlight, actions) {
  return inFlight.filter((b) => {
    if (b.openPr?.isDraft) return false;
    if (b.state === 'ABANDONED_WIP') return actionOn(actions, 'finishAbandoned');
    if (b.state === 'NEEDS_PR') return actionOn(actions, 'openPr');
    if (b.state === 'CONFLICTED') return actionOn(actions, 'resolveConflicts');
    if (b.state === 'IN_REVIEW') return actionOn(actions, 'resolveConflicts') || actionOn(actions, 'autoMerge');
    return false;
  });
}

// A branch is only worth finishing if its work is still NEEDED. Anything that
// sat while the default branch moved may hold a feature that was since solved a
// different way there — merging it then REGRESSES the default branch instead of
// adding to it, and it is the one failure a "verify the work is complete" gate
// cannot catch, because the work IS complete; it is just no longer wanted.
//
// The tell is never `git status` or the branch's own changelog entry — both read
// as healthy WIP. It is the collision set: the files this branch touches that the
// default branch has also changed since they diverged. So the deterministic pass
// hands the agent that list, and this gate makes reading it step one, BEFORE any
// commit, rebase, or conflict resolution. Resolving a conflict is the trap —
// mechanically reconcilable and semantically wrong, it launders a regression into
// a merge that looks intentional.
//
// Precedent: a branch 101 commits behind held "merge a task's PR on green CI when
// no reviewer is configured", whose collision files (agentWorktreeCleanup.js,
// the CoS constants) had meanwhile grown a strictly richer three-way completion
// policy on the default branch. Its tests passed and its changelog entry read
// fine; only the collision files showed it had been superseded.
const supersessionGate = ({ collisionPaths = [], behind } = {}) => {
  const drift = typeof behind === 'number' && behind > 0
    ? `This branch is ${behind} commit(s) behind the default branch.`
    : 'This branch may have drifted from the default branch.';
  if (!collisionPaths.length) {
    return `${drift} Nothing it touches has changed on the default branch since it diverged, so supersession is unlikely — but if a rebase does surface a conflict, treat it as the signal below rather than something to mechanically resolve.`;
  }
  // The full set already has its own line in the prompt block; the prose needs
  // only enough to make the instruction concrete. Collisions are ranked
  // signal-first, so the head of the list is the part worth naming inline.
  const shown = collisionPaths.slice(0, 6);
  const more = collisionPaths.length > shown.length ? ` (+${collisionPaths.length - shown.length} more, listed above)` : '';
  return [
    `${drift} **Before anything else, check the work is still needed.**`,
    `The default branch has ALSO changed these files since this branch diverged: ${shown.map((p) => `\`${p}\``).join(', ')}${more}.`,
    'For each, read the default branch\'s current version and compare it to what this branch does there. You are looking for one thing: has the default branch already solved this branch\'s problem, by any means? A differently-named function, a policy object where this branch has a boolean, a scheduled tick where this branch has a watcher — all count. It does not need to look like this branch\'s approach to have replaced it.',
    'If it HAS been solved there, this branch is SUPERSEDED: stop, do not commit, rebase, resolve, or merge anything, and report it as superseded naming the file(s) and what on the default branch replaced it. Merging it would undo work already shipped. Say so plainly rather than resolving the conflict — a conflict you can resolve is exactly how a regression gets in looking deliberate.',
    recordVerdictInstruction(ledgerPath()),
    'Recording the verdict is the handoff to this scheduled task\'s deterministic cleanup pass. It backs up the branch commits, tracked diff, and untracked files, then removes the worktree and branch in the completion cleanup pass (without waiting for another scheduled run). Do not describe the surviving branch as work a human must clean up, and do not write the verdict anywhere except the absolute ledger path above — a ledger inside the abandoned worktree is invisible to the running PortOS instance and leaves the branch stranded.',
    'Only once you have confirmed the work is still needed, continue.'
  ].join(' ');
};

// Verify before publication without rewriting a branch just because the base
// advanced. Conflicts, enforced policy and concrete integration risk still need
// recovery followed by fresh validation on the resulting head.
const verifyGate = 'Fetch the default branch for comparison before opening or updating a PR; inspect semantic overlap and supersession. Rebase only for actual conflicts, an enforced up-to-date branch policy, or evidenced integration risk. Base movement alone does not require a rebase or another CI run; this overrides mandatory base-sync instructions in delegated slashdo workflows. Run the test suites for the workspaces the diff touches (`cd server && npm test`, `cd client && npm test`) plus lint, and read the result. After changing the head, rerun affected validation and required reviews/checks. If anything fails, fix it on the branch and re-run; if you cannot get it green, stop and report which suite fails and why. Never push a branch whose tests you have not seen pass.';

// A measured backlog and durable server receipt can transfer pending CI.
// Immediate merges still require the current-head CI and ownership gates.
// `pr` is the PR's number when the branch already has one, else the `<num>`
// placeholder the agent fills in after opening it.
// Exported so the per-agent repo-state audit (services/agent/agentRepoStateVerification.js)
// hands a recovery agent the SAME merge procedure, rather than re-authoring a
// `gh pr merge` line that loses these caveats.
export const driveToMerge = (pr, { mergeHandoff = false } = {}) => [
  buildAutoMergeHandoffInstructions(pr, { mergeHandoff }),
  'Opening (or approving) the PR is NOT the end state — a green PR left open is still an unfinished branch that this task will simply re-drive on its next run.',
  'A conflict-free branch with passing current-head required checks and satisfied configured reviews may merge behind the default branch. Base movement alone does not require rebasing or restarting CI.',
  `Wait for CI in-session by re-polling \`gh pr checks ${pr} --required\` every 30s so the run stays observable while CI is pending. \`no required checks reported\` right after the PR opens is late registration of an aggregator check, not an empty requirement set: read the branch rulesets (\`gh api --paginate repos/<owner>/<repo>/rules/branches/<base>\`) and classic protection before concluding nothing is required, and keep re-polling while either requires a check. Retain ownership while CI is pending unless the server accepts an exact-head backlog handoff; elapsed waiting time alone is not completion.`,
  'If a required check FAILS, fix it on the branch, push, and re-poll (max 3 rounds); if it is still red after that, leave the PR open and report exactly which check failed.',
  'Record the exact local branch head whose checks and configured reviews passed as <verified-head>; immediately before merging, repeat the ownership/policy Recheck and require the forge PR head to equal that same head. If either changed, stop and revalidate. Every merge attempt, including a method retry, must retain --match-head-commit <verified-head>.',
  `Once every required check is green AND the PR is MERGEABLE, merge without implicit local teardown: \`gh pr merge ${pr} --merge --match-head-commit <verified-head>\`. On a disallowed method retry with \`gh pr merge ${pr} --squash --match-head-commit <verified-head>\`, then \`gh pr merge ${pr} --rebase --match-head-commit <verified-head>\`. Never \`--auto\`: a queued merge outlives this run.`,
  MANAGED_WORKTREE_CLEANUP_CONTRACT,
].join(' ');

/**
 * Per-state instruction to the coordinator/sub-agent.
 * @param {string} state
 * @param {object} actions - per-app action toggles
 * @param {{ prNumber?: number, worktreePath?: string, collisionPaths?: string[], behind?: number }} [ctx]
 *   the branch's open PR number (when it has one), its worktree path
 *   (ABANDONED_WIP needs it — the uncommitted work only exists there, never in
 *   the primary checkout), and the drift facts feeding the supersession gate
 */
export function desiredEndState(state, actions, { prNumber, worktreePath, collisionPaths, behind, mergeHandoff = false } = {}) {
  const pr = prNumber ? String(prNumber) : '<num>';
  const stillNeeded = supersessionGate({ collisionPaths, behind });
  if (state === 'ABANDONED_WIP') {
    // The branch has NO commits of its own — the entire deliverable is the
    // uncommitted tree. So the first move is to READ it, and the loudest rule is
    // "don't commit a half-finished tree": an agent that died mid-edit can leave
    // a syntactically-broken file, and committing that is strictly worse than
    // leaving it for a human, since it converts recoverable scratch state into
    // branch history.
    const where = worktreePath ? `\`${worktreePath}\`` : 'the branch\'s worktree';
    const assess = `This branch has no commits of its own — its work is sitting UNCOMMITTED in ${where}, the worktree of a CoS agent that is no longer running (it exited, crashed, or was reaped before committing). Nothing is lost, but nothing lands either until you finish it. Working INSIDE that worktree, run \`git status\` and \`git diff\` (plus inspect every untracked file) and read the WHOLE change set before touching anything. Recover the intended deliverable from the task/issue context, the diff, and its tests; then finish incomplete code, remove stubs/TODOs/placeholders, repair half-renamed symbols, and run the touched workspaces' test suites. Do not merely inventory unfinished work and leave it for another run.`;
    const bail = 'If the work is still needed but you genuinely cannot finish it because required intent, credentials, or an external dependency is unavailable, preserve it and report the concrete blocker. That is the exceptional blocked outcome, not the default for an incomplete diff.';
    const commit = 'If it IS finished, commit it on this branch (a message that states what changed and why — never a bare "wip"), then ship it with `/do:pr --no-merge` (by hand, if slash commands are unavailable: self-review the diff, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan).';
    if (!actionOn(actions, 'autoMerge')) {
      return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  if (state === 'NEEDS_PR') {
    const verify = `${stillNeeded} Verify the branch's work is complete and ready (tests pass, no stubs/TODO markers). If it is incomplete, finish it on this branch and verify the completed behavior; do not merely report it for another run, and do not open a half-baked PR. Preserve it without shipping only when required intent, credentials, or an external dependency makes completion genuinely impossible, and report that concrete blocker.`;
    // `--no-merge` is passed explicitly on BOTH paths — not to disable merging,
    // but to keep the merge decision here rather than inside slashdo. Under
    // `--merge`, /do:pr first tries GitHub-native auto-merge and reports the PR
    // as "queued", ending the run with CI still pending — the same unattended
    // exit this whole change exists to close. So /do:pr runs its reviewer loop
    // and opens the PR; the merge gate below is what finishes the branch. The
    // flag is also stated explicitly so this machine's saved slashdo defaults
    // (which may set `merge: true`) can't decide it either way.
    const openPr = '`/do:pr --no-merge` — its reviewer loop runs, and the PR is left for the gate below rather than queued for auto-merge (by hand, if slash commands aren\'t available in your context: self-review the diff and fix what you find, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan)';
    if (!actionOn(actions, 'autoMerge')) {
      return `${verify} If ready, ship it with ${openPr}. ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${verify} If ready, ship it with ${openPr}. ${verifyGate} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  if (state === 'CONFLICTED') {
    // The conflict IS the supersession signal here — this PR has already been
    // told by GitHub that it collides with the default branch, so "resolve the
    // conflicts" without first asking whether the work is still wanted is
    // precisely how a superseded branch gets merged looking deliberate.
    const resolve = `${stillNeeded} If it is still needed: rebase the branch onto the default branch, resolve all conflicts, run the tests, and push. ${verifyGate}`;
    if (!actionOn(actions, 'autoMerge')) {
      return `${resolve} Do NOT merge (auto-merge is disabled) — stop once the conflicts are resolved and pushed, and report the PR's URL.`;
    }
    return `${resolve} ${driveToMerge(pr, { mergeHandoff })}`;
  }
  // IN_REVIEW
  const canMerge = actionOn(actions, 'autoMerge');
  // Existing PRs have already passed through whatever review workflow the repo
  // uses. Reconciliation must not request or assume a particular reviewer; its
  // merge gate is the forge's live CI and mergeability state.
  return `Drive the open PR toward green: inspect any existing review feedback and address it.${canMerge
    ? ` Merge ONLY when CI is green and the PR is MERGEABLE. ${driveToMerge(pr, { mergeHandoff })}`
    : ' Do NOT merge (auto-merge is disabled) — stop once the PR is green and ready for the user to merge.'}`;
}

/**
 * Stable signature of an actionable set — used by the perpetual drain to detect
 * PROGRESS between dispatches. A productive coordinator run advances branches
 * through states (NEEDS_PR → IN_REVIEW → merged/cleaned) or removes them, all of
 * which change this signature; a run that leaves the SAME branches in the SAME
 * states (a `NEEDS_PR` branch the agent judged "not ready", an `IN_REVIEW` PR
 * blocked on human review / red CI) produces an identical signature, which the
 * generator treats as "no progress → park" instead of re-dispatching an
 * identical coordinator back-to-back. Order-independent (sorted).
 *
 * Deliberately does NOT include `openPr.mergeable`. GitHub computes mergeability
 * asynchronously and answers `UNKNOWN` until it lands, so that field flaps
 * UNKNOWN → MERGEABLE → UNKNOWN across consecutive reads of a completely static
 * PR — which this guard would read as PROGRESS and re-dispatch on forever. It also
 * carries no information the signature loses: `CONFLICTING` is what makes
 * `classifyBranch` return CONFLICTED, so every real mergeability transition
 * already shows up in `state`.
 *
 * @param {object[]} actionable - post-filterActionable branches
 * @returns {string}
 */
export function actionableSignature(actionable) {
  return actionable
    .map((b) => `${b.branch}:${b.state}:${b.openPr?.number ?? 'none'}${b.tip ? `:${b.tip}` : ''}`)
    .sort()
    .join('|');
}

/**
 * Select the deterministic prefix a single coordinator should receive. The
 * reconciler has already prioritized the full set, so slicing here preserves
 * that ordering and lets the next drain dispatch pick up the remainder after
 * this batch makes progress. Absent/invalid limits retain the legacy all-at-once
 * behavior for hand-authored task records that predate the setting.
 * @param {object[]} inFlight
 * @param {number} branchesPerAgent
 * @returns {object[]}
 */
export function limitBranchesForAgent(inFlight, branchesPerAgent) {
  if (!Array.isArray(inFlight)) return [];
  if (!Number.isInteger(branchesPerAgent) || branchesPerAgent < 1) return inFlight;
  return inFlight.slice(0, branchesPerAgent);
}

/**
 * The recommended `model:`/`effort:` line for one issue-derived branch, or ''
 * when the branch is not issue-derived, the issue carries neither label, or
 * the forge read fails. A failed read must never block or reshape
 * reconciliation: `getIssueDispatchHint` already collapses every failure mode
 * to `status: 'unavailable'` and never rejects, but the `.catch` here holds
 * that guarantee even if a future forge implementation (or a test double)
 * throws instead — this call site is the one place the "never block" rule
 * actually has to hold, so it doesn't trust the callee alone to keep it.
 * @param {string} branchName
 * @param {string} [repoPath] - repo dir gh resolves the remote from
 * @returns {Promise<string>}
 */
async function dispatchHintLineForBranch(branchName, repoPath) {
  const issueNumber = issueNumberFromRef(branchName);
  if (!issueNumber) return '';
  const hint = await getIssueDispatchHint(issueNumber, { cwd: repoPath }).catch(() => ({ status: 'unavailable', model: null, effort: null }));
  if (hint.status !== 'known' || (!hint.model && !hint.effort)) return '';
  // Rendered from the shared vocabulary rather than hand-spelled, so this line
  // cannot drift from the tiers/levels a filer writes. Canonical GitHub spelling:
  // getIssueDispatchHint is gh-only, and this is prose for a coordinator prompt,
  // not a label being applied to a forge.
  const parts = forgeDispatchLabels({ model: hint.model, effort: hint.effort });
  return `- Recommended dispatch (issue #${issueNumber}'s labels): ${parts.join(', ')} — run this branch's work at that capability/effort.`;
}

/**
 * Render the actionable in-flight branch set into the coordinator prompt body
 * (injected as `{inFlightBranches}`). Async because each issue-derived branch
 * gets one forge read for its issue's `model:`/`effort:` labels — see
 * `dispatchHintLineForBranch`.
 * @param {object[]} inFlight - actionable branches (post-filterActionable)
 * @param {{ defaultBranch:string, actions:object, branchesPerAgent?:number, repoPath?:string, appId?:string }} ctx
 *   `appId` adds each branch's pre-mutation ownership recheck command.
 * @returns {Promise<string>}
 */
export async function formatInFlightForPrompt(inFlight, { defaultBranch, actions, branchesPerAgent, repoPath, appId, detachedWorktrees = [], mergeHandoff = false } = {}) {
  // One gh round-trip per issue-derived branch — resolved in parallel (not
  // inline in the loop below) so N branches cost one round-trip's latency,
  // not N of them in series.
  const dispatchLines = await Promise.all(inFlight.map((b) => dispatchHintLineForBranch(b.branch, repoPath)));
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  if (Number.isInteger(branchesPerAgent) && branchesPerAgent > 0) {
    lines.splice(1, 0, `This coordinator run is limited to up to ${branchesPerAgent} branch(es); finish every branch listed below before reporting done.`);
  }
  // This list is a scan from before dispatch; a claim run can take a branch
  // after it. Each branch's own recheck runs right before its first mutation (#10089).
  if (appId && inFlight.length) {
    lines.splice(lines.length - 1, 0, '', 'Ownership recheck: immediately before the FIRST edit, commit, rebase, push, merge, PR change, move or removal on a branch below (and again before its merge), run that branch\'s "Recheck" command and require a parsed JSON response with admitted:true. On admitted:false, an HTTP/auth/transport error or unreadable JSON, leave that branch and its checkout untouched and report it as held by a live owner with the returned reason — a live claim run owns it now. A successful Recheck also reserves that branch for this run until it ends, so no claim run can take it mid-mutation.');
  }
  inFlight.forEach((b, i) => {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\`${b.state === 'ABANDONED_WIP' ? ' (holds UNCOMMITTED work — read it before doing anything)' : ''}`);
    if (appId) {
      // `{agentId}` is filled at spawn (`injectReconcileAgentId`): the run has no id yet.
      const payload = JSON.stringify({
        action: 'check', appId, branch: b.branch, ...(b.worktreePath ? { worktreePath: b.worktreePath } : {}),
        agentId: RECONCILE_AGENT_ID_PLACEHOLDER,
      });
      lines.push(`- Recheck: \`${agentApiCurl({ apiBase: localApiBaseUrl(), path: '/api/cos/claim-ownership', payload })}\``);
    }
    // A never-pushed NEEDS_PR branch reads identically to a pushed one in this
    // block, and the difference decides whether the push needs `-u`. State it
    // rather than making the agent infer it from a missing PR link.
    if (b.hasUpstream === false && b.state === 'NEEDS_PR') {
      lines.push('- Never pushed: no upstream on `origin` — the push that opens the PR must create one (`git push -u origin <branch>`).');
    }
    if (typeof b.behind === 'number') {
      lines.push(`- Drift: ${b.behind} commit(s) behind \`${defaultBranch}\`${typeof b.ahead === 'number' ? `, ${b.ahead} ahead` : ''}`);
    }
    // Listed as their own line, not just inside the prose instruction, so the
    // agent can act on the set directly (open these files) without re-deriving it.
    if (b.collisionPaths?.length) {
      lines.push(`- Also changed on \`${defaultBranch}\` since this branch diverged (**read these first — they are where supersession shows up**): ${b.collisionPaths.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (dispatchLines[i]) lines.push(dispatchLines[i]);
    lines.push(`- Do: ${desiredEndState(b.state, actions, {
      prNumber: b.openPr?.number,
      worktreePath: b.worktreePath,
      collisionPaths: b.collisionPaths,
      behind: b.behind,
      mergeHandoff
    })}`);
    lines.push('');
  });
  // Detached trees outside the managed roots are never removed by the deterministic
  // pass. An inventory observation never grants the coordinator removal authority.
  const unmanaged = detachedWorktrees.filter((d) => !d.managed);
  if (unmanaged.length) {
    lines.push(`Detached worktrees at commits already on \`${defaultBranch}\`, outside PortOS's managed roots (${unmanaged.length}):`, '');
    for (const d of unmanaged) {
      lines.push(`### Detached worktree \`${d.path}\``);
      lines.push('- Do: retain this unmanaged checkout and report worktree-unmanaged-location. Do not unlock, alter or remove it; this review batch grants no cleanup authority for unrelated checkouts.', '');
    }
  }
  return lines.join('\n');
}
