/**
 * Branch & PR Reconciler — deterministic core (Tier 1).
 *
 * Enumerates THIS machine's local branches (`refs/heads/`), classifies each by
 * its merge / PR state, and deterministically cleans up the fully-merged,
 * orphaned ones (remove the lingering worktree + delete the local branch).
 * Everything that needs judgment (open a PR, resolve conflicts, drive a review
 * loop, merge) is returned in `inFlight` for the scheduler to hand to a
 * coordinator CoS agent. Classification, prompt rendering and checkout
 * retirement are exposed here for callers.
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

import { isHostShuttingDown } from '../lib/hostShutdown.js';
import { getBranches, getDefaultBranch } from './git/status.js';
import { hasBranchMergeEvidence } from './git/branchEvidence.js';
import { deleteMergedRemoteBranches } from './git/cleanup.js';
import { readRepoBranchSnapshot } from './repoBranchSnapshot.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, reapMergedWorktrees } from './worktreeManager.js';
import { execGh, ensureForgeReachable } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { isForgeNoAccessError, logForgeNoAccessOnce } from '../lib/forgeAccessErrors.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { readVerdictLedger, partitionSuperseded } from './supersededLedger.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { readClaimOwnershipAgents } from './cos/cosClaimOwnership.js';
import { gatheredHoldReason, resolveLiveOwnerReason } from './branchRetirementDecision.js';
import { readBranchUnshipped } from './branchReconcile/forgeShipment.js';
import {
  classifyBranches, gitLines, isAbandonedAgentWorktree, isAbandonedClaimWorktree, parseRemoteHeads,
  partitionRemoteOrphans, prioritizeBranches, RECONCILED_REMOTE, upstreamBranchName,
} from './branchReconcile/classify.js';
import {
  cleanupMerged, gatherDetachedWorktrees, gatherRecoveryWorktrees, reapDetachedWorktrees, reapSupersededBranches,
  retainedClaimMarkers, worktreeAgeMs, worktreeDirtyPaths,
} from './branchReconcile/retireCheckouts.js';

// Never reconciled — the canonical long-lived-branch set (`main`/`master`/`dev`/
// `develop`/`release`/`gh-pages`) shared with the git branch-cleanup guards in
// `../lib/gitArgs.js`, so a branch that can't be deleted also can't be handed to
// the coordinator agent. The resolved default branch is added on top at runtime.
// Re-exported for callers that reach for it from this module.
export { PROTECTED_BRANCHES };

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
export { STALE_CLAIM_IDLE_MS, SHIPPED_CLAIM_IDLE_MS, buildActiveOwnerIds, resolveLiveOwnerReason } from './branchRetirementDecision.js';

// The same window, for a claim that has demonstrably SHIPPED (see SHIPPED_CLAIM
// on cleanupMerged): proof of completion collapses the wait to an idle floor
// over the checkout mtime, because it does not prove the local /claim process
// has exited. Both windows live with the retirement decision that applies them.

export {
  WORK_BRANCH_PREFIXES, branchPriorityRank, classifyBranch, classifyBranches, describeIdleReconcilePark,
  isAbandonedAgentWorktree, isAbandonedClaimWorktree, parseRemoteHeads, partitionRemoteOrphans,
  prioritizeBranches, upstreamBranchName, worktreeProtectionReason,
} from './branchReconcile/classify.js';
export {
  actionOn, actionableSignature, desiredEndState, driveToMerge, filterActionable, formatInFlightForPrompt,
  limitBranchesForAgent,
} from './branchReconcile/inFlightPrompt.js';
export {
  cleanupMerged, reapSupersededBranches, SUPERSEDED_UNMANAGED_IDLE_MS,
} from './branchReconcile/retireCheckouts.js';
export { checkoutIdleMs } from './branchReconcile/checkoutIdle.js';
export { readBranchUnshipped };

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

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
export async function gatherDivergence(repoPath, branch, defaultBranch, dirtyPaths = [], observed = {}) {
  const { ahead, behind } = observed.counts ?? await readDivergenceCounts(repoPath, branch, defaultBranch);
  const base = await execGit(['merge-base', branch, defaultBranch], repoPath, { ignoreExitCode: true })
    .catch(() => null);
  const mergeBase = (base?.stdout || '').trim();
  if (!mergeBase || mergeBase === defaultBranch) return { behind, ahead, collisionPaths: [] };

  let defaultSet = observed.defaultChanges?.get(mergeBase);
  if (!defaultSet) {
    const diff = await execGit(['diff', '--name-only', mergeBase, defaultBranch], repoPath, { ignoreExitCode: true }).catch(() => null);
    if (!diff || diff.exitCode !== 0) return { behind, ahead, collisionPaths: [] };
    defaultSet = new Set(gitLines(diff.stdout));
    observed.defaultChanges?.set(mergeBase, defaultSet);
  }
  if (!defaultSet.size) return { behind, ahead, collisionPaths: [] };

  const branchChanged = await execGit(['diff', '--name-only', mergeBase, branch], repoPath, { ignoreExitCode: true }).catch(() => null);
  const touched = new Set([...gitLines(branchChanged?.stdout), ...dirtyPaths]);
  return { behind, ahead, collisionPaths: [...touched].filter((p) => defaultSet.has(p)).sort(byCollisionSignal) };
}

async function readDivergenceCounts(repoPath, branch, defaultBranch) {
  const result = await execGit(
    ['rev-list', '--left-right', '--count', `${defaultBranch}...${branch}`], repoPath, { ignoreExitCode: true },
  ).catch(() => null);
  const counts = result?.exitCode === 0 && result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  return counts ? { behind: Number(counts[1]), ahead: Number(counts[2]) } : { behind: null, ahead: null };
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
  const snapshot = readRepoBranchSnapshot(repoPath, { strict: false, comparisonBranch: defaultBranch });
  const [branches, { worktrees, tips, counts }, prsByHeadOrNull, remoteHeads] = await Promise.all([
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
  const completionPolicies = candidates.length ? await readBranchCompletionPolicies({ repoPath, branches: candidates.map(candidate => candidate.name) }).catch(() => null) : [];
  const policyIndex = indexBranchCompletionPolicies(repoPath, completionPolicies);

  const defaultTip = tips.get(defaultBranch);
  const defaultChanges = new Map();
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
    const divergence = tip && defaultTip
      ? await gatherDivergence(repoPath, tip, defaultTip, dirtyPaths, { counts: counts.get(b.name), defaultChanges })
      : await gatherDivergence(repoPath, b.name, defaultBranch, dirtyPaths);
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
 * Retire already-merged local work for a caller that has no authority to drive
 * pull requests: the daily `agent-data-cleanup` job (#17377). It is `reconcile`
 * itself, so a manual branch-reconcile run and this pass share every hold (live
 * owner, lock, dirty tree, unmerged tip, unreadable forge, issue reservation, the
 * exact-merged-head and SHIPPED_CLAIM_IDLE_MS proofs for claims). Only the two
 * steps that remove work not on the default branch, superseded branches and
 * remote orphans, are forced off. The returned `inFlight` set is information:
 * nothing here opens, reviews or merges a pull request or dispatches an agent.
 *
 * @param {string} repoPath
 * @param {{ appId: string, activeAgentIds: Set<string>|null, claimOwners: { agents: object[]|null, readAgents?: () => Promise<object[]|null> }, forgeAccount?: string|null, pendingMergeBranches?: Set<string>|null }} opts
 */
export function retireMergedCheckouts(repoPath, opts) {
  return reconcile(repoPath, { ...opts, cleanup: true, reapSuperseded: false, reapRemotes: false });
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
