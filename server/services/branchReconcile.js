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
 * The one thing that DOES look at the remote is the orphan sweep
 * (`reapOrphanedRemotes`), and it stays peer-safe by only ever deleting a remote
 * branch whose work is already merged into the default branch — a state in which
 * no machine, ours or a peer's, can lose anything. An unmerged remote-only branch
 * is reported, never touched.
 */

import { stat } from 'node:fs/promises';
import { getBranches, getDefaultBranch, isBranchMergedInto, deleteBranch } from './git.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, forceRemoveWorktreeDir, classifyWorktreeDirt, reapMergedWorktrees } from './worktreeManager.js';
import { isAgentWorktreeId, worktreeOwnershipReason, worktreeHoldExpiresAt } from '../lib/worktreeOwnership.js';
import { execGh, ensureForgeReachable } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { readVerdictLedger, partitionSuperseded, recordVerdictInstruction, recordVerdict, sameDirtyPaths } from './supersededLedger.js';
import { backupSupersededBranch } from './supersededBackup.js';

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
export const STALE_CLAIM_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The same window, for a claim that has demonstrably SHIPPED (see SHIPPED_CLAIM
// on cleanupMerged). Proof of completion collapses the wait but does not remove
// it: the one thing "merged + clean + remote branch gone" does NOT prove is that
// the local /claim PROCESS has exited. A session that just merged its own PR —
// or whose PR was merged from a peer machine, which PortOS users routinely run —
// sits in exactly that state for the seconds-to-minutes it spends on teardown,
// and reaping there deletes a directory a live process is still standing in.
// mtime is the only liveness proxy available (a claim has no durable local agent
// id), so keep a short idle floor over it. An hour is far longer than any
// teardown and still turns a week-long park into a single recheck.
export const SHIPPED_CLAIM_IDLE_MS = 60 * 60 * 1000; // 1 hour

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

/**
 * Pure classifier: map one branch's git/PR facts to a reconcile state.
 * First match wins.
 *   ABANDONED_WIP — dirty worktree of a DEAD CoS agent → agent finishes the work
 *   MERGED     — work is fully in the default branch → deterministic cleanup
 *   CONFLICTED — open PR with merge conflicts        → agent resolves
 *   IN_REVIEW  — open PR, otherwise                  → agent drives to merge
 *   NEEDS_PR   — unmerged work, no PR, clean          → agent verifies + opens PR
 *                (pushed-with-no-PR, or never pushed but holding commits)
 *   WIP        — bare pointer, dirty, or LIVE-owned   → skip + report (never touch)
 *
 * @param {{ hasUpstream:boolean, ahead?:number|null, hasOrigin?:boolean, isMerged:boolean, worktreeDirty:boolean, abandonedAgentWorktree?:boolean, liveOwnerReason?:string|null, openPr:({mergeable?:string}|null), prStateUnavailable?:boolean }} input
 *   `ahead` is the branch's own commit count over the default branch (null =
 *   unreadable), and `hasOrigin` says the repo has a remote to push that work to.
 *   Together they are what make a never-pushed branch actionable — see the
 *   NEEDS_PR gate below. `hasOrigin` defaults to FALSE (fail-closed): a caller
 *   that cannot vouch for a remote must not have one invented for it.
 *   `prStateUnavailable` means the forge could not be READ this cycle — distinct
 *   from `openPr: null` ("the forge answered: no open PR").
 *   `liveOwnerReason` is `resolveLiveOwnerReason`'s verdict for the branch — non-null
 *   means an active CoS agent or deliberate lock owns it right now, whether or not
 *   its worktree still exists. A clean `claim-*` directory is only a claim marker;
 *   dirty claim trees still remain WIP through the ordinary dirty-tree guard.
 * @returns {'ABANDONED_WIP'|'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP'}
 */
export function classifyBranch({ hasUpstream, ahead = null, hasOrigin = false, isMerged, worktreeDirty, abandonedAgentWorktree, liveOwnerReason = null, openPr, prStateUnavailable = false }) {
  // A dead agent's worktree that still holds uncommitted work is the ONE dirty
  // case that must be driven rather than skipped — and it must be caught BEFORE
  // the `isMerged` test, because an agent that exited without committing leaves
  // its branch pointer parked on an old default-branch commit, which reads as
  // MERGED. That combination (merged pointer + dirty tree) is exactly what made
  // these branches invisible: MERGED sent them to `cleanupMerged`, which
  // correctly refused to delete a dirty worktree, so they were only ever
  // reported as `skipped` and never appeared in-flight. The work sat there
  // indefinitely while every run logged "nothing in-flight".
  if (worktreeDirty && abandonedAgentWorktree) return 'ABANDONED_WIP';
  if (isMerged) return 'MERGED';
  // A branch with a LIVE owner belongs to an active CoS agent or an explicitly
  // locked worktree. It may keep moving (commits, a PR opened, a rebase) for as
  // long as that session runs, so handing it to the coordinator races the live
  // session's git operations and can re-advance the drain's progress signature.
  // Checked AFTER `isMerged` on purpose — a merged branch with a live owner still
  // belongs in the MERGED bucket, where `cleanupMerged` applies the same protection
  // and reports it as held back. A clean `claim-*` tree is not a live-owner signal;
  // a dirty one is caught by the ordinary WIP guard below.
  if (liveOwnerReason) return 'WIP';
  // A worktree with real uncommitted changes is NEVER handed to the coordinator
  // agent — even for a branch with an open PR. The agent's per-state actions
  // (rebase/resolve/merge) run git operations that could stash/reset/checkout
  // and silently discard the user's in-progress work. Skip it as WIP regardless
  // of PR state; the `cleanupMerged` path applies the same guard for MERGED.
  if (worktreeDirty) return 'WIP';
  if (openPr) return openPr.mergeable === 'CONFLICTING' ? 'CONFLICTED' : 'IN_REVIEW';
  // The forge was unreadable this cycle, so "no open PR" is not something we
  // learned — it is something we failed to ask (#3358). Report the branch as WIP
  // (skip + never touch) rather than dispatching an agent to open a PR that may
  // already exist. MERGED above is unaffected: that verdict is pure git truth.
  if (prStateUnavailable) return 'WIP';
  // Unmerged commits that nothing else owns are in-flight work whether or not
  // they were ever PUSHED. Gating this on `hasUpstream` alone is what made a
  // whole shelf of `claim/*` branches invisible: a /claim session that dies
  // before its `git push -u` leaves commits ahead of the default branch with no
  // upstream, so every run classified them WIP and parked on "no branches in
  // flight" while the work sat there. NEEDS_PR already tells the agent to push
  // (`/do:pr`, or `git push -u origin <branch>` by hand), so the un-pushed case
  // needs no separate state — only to stop being skipped.
  //
  // `ahead` is the discriminator the upstream check was standing in for: a branch
  // with NO commits of its own is a bare pointer with nothing to ship, and stays
  // WIP. Unknown (`null`, an unreadable rev-list) also stays WIP — a git failure
  // must never manufacture work.
  //
  // `hasOrigin` gates only the ahead-based arm, because that arm is the one with
  // nothing else proving the work is shippable. On a managed repo with NO remote,
  // every branch has `hasUpstream: false` and `getOpenPrsByHead` answers with an
  // empty Map, so without this gate a clean local branch would be dispatched to a
  // coordinator that can only fail at `git push -u origin <branch>` — spending an
  // agent run to discover there is nowhere to push. `hasUpstream` needs no such
  // gate: a branch that tracks a remote branch is itself proof the remote exists.
  if (hasUpstream || (hasOrigin && typeof ahead === 'number' && ahead > 0)) return 'NEEDS_PR';
  return 'WIP';
}

/**
 * Classify a list of gathered branch inputs. Pure.
 * @param {object[]} inputs - each from `gatherBranchState`
 * @returns {object[]} inputs with a `state` field added
 */
export function classifyBranches(inputs) {
  return inputs.map((input) => ({ ...input, state: classifyBranch(input) }));
}

/**
 * Resolve the open PRs for a repo, keyed by head branch name.
 *
 * Three answers, never two (#3358):
 *   - a Map (possibly empty) — the forge answered
 *   - an EMPTY Map for a non-GitHub origin — there is no GitHub PR state to have
 *   - `null` — we could NOT ask (gh transport/auth failure, unparseable output)
 *
 * `null` must never be read as "this branch has no PR": that is what made an
 * unreachable forge classify every pushed branch as NEEDS_PR and hand the
 * coordinator agent a list of PRs to re-open on top of the ones that exist.
 *
 * @param {string} repoPath
 * @param {object|null} [providedOrigin] - `getOriginInfo`'s answer when the caller
 *   already resolved it (gatherBranchState needs the same record for `hasOrigin`);
 *   omitted, this reads it itself so a standalone call still works.
 * @returns {Promise<Map<string, {number:number, mergeable:string, isDraft:boolean, url:string}>|null>}
 */
async function getOpenPrsByHead(repoPath, providedOrigin) {
  const origin = providedOrigin === undefined
    ? await getOriginInfo(repoPath).catch(() => null)
    : providedOrigin;
  // Accept any GitHub-family host (github.com AND enterprise github.*), mirroring
  // prWatcher.checkPullRequests. `origin.isGithub` is github.com-only, so gating
  // on it silently skipped enterprise repos. githubRepoSpec pairs that gate with
  // the host-qualified `HOST/OWNER/REPO` selector (null for a non-GitHub origin).
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return new Map();
  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,mergeable,isDraft,url'
  ]).catch((err) => {
    console.error(`❌ branch-reconcile: gh pr list failed for ${repoSpec}: ${err.message}`);
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
        url: pr.url || ''
      });
    }
  }
  return byHead;
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
 * Sibling worktrees (`next-issue-*`, etc.) whose basename is none of these fall
 * through to null and are cleaned normally.
 *
 * @param {{ path:string, locked?:boolean, activeAgentIds?:Set<string>, ageMs?:number, staleClaimIdleMs?:number }} input
 * @returns {string|null}
 */
export function worktreeProtectionReason({ path, locked, activeAgentIds, ageMs, staleClaimIdleMs = STALE_CLAIM_IDLE_MS }) {
  if (!path) return null;
  return worktreeOwnershipReason({
    path,
    locked,
    activeAgentIds,
    allowStaleClaim: true,
    ageMs,
    staleClaimIdleMs,
  });
}

/**
 * When `worktreeProtectionReason`'s hold on this worktree lapses by itself, as an
 * ISO instant — or null when it takes an outside change (a lock released, an
 * agent exiting) that we cannot schedule.
 *
 * The exact mirror of the gate above, so cleanup can report not just THAT a
 * merged branch was held back but WHEN it stops being held. Policy lives in
 * worktreeOwnership.js; this only supplies this caller's defaults.
 *
 * @param {{ path:string|null, locked?:boolean, activeAgentIds?:Set<string>, ageMs?:number|null, staleClaimIdleMs?:number }} input
 * @returns {string|null} ISO timestamp
 */
export function worktreeProtectionExpiresAt({ path, locked, activeAgentIds, ageMs, staleClaimIdleMs = STALE_CLAIM_IDLE_MS }) {
  if (!path) return null;
  return worktreeHoldExpiresAt({
    path,
    locked,
    activeAgentIds,
    allowStaleClaim: true,
    ageMs,
    staleClaimIdleMs,
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
 * worktree stays protected. Same fail-safe posture as `worktreeProtectionReason`'s
 * unknown-age branch — never infer abandonment from an answer we didn't get.
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
 * Why this branch must be left ALONE this cycle — the dispatch-side counterpart to
 * `worktreeProtectionReason`'s teardown gate. Three cases that gate doesn't cover:
 *
 * 1. **Liveness we could not determine.** `worktreeProtectionReason` is only ever
 *    called with an authoritative `activeAgentIds` Set (cleanupMerged defaults it to
 *    an empty one), so a missing Set reads there as "no agents running" and returns
 *    null. For a DISPATCH decision that default is backwards: an `agent-*` worktree
 *    whose owner's liveness is UNKNOWN must be presumed live, exactly as
 *    `isAbandonedAgentWorktree` presumes it. Fail safe toward not-touching.
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
 *    finish. So this side passes `allowLiveClaim`, while cleanup keeps the hold
 *    through `worktreeProtectionReason` until the claim is stale or provably
 *    shipped. A lock still outranks it: the gate tests the lock BEFORE the
 *    claim, so a locked claim tree reports `worktree-locked` on its own — and
 *    so does a live agent, on the same ordering. `activeAgentIds` holds
 *    `agent-<id>` keys (case 2 above reads them as such), so a claim basename
 *    can only appear there out of contract; if one ever did, holding the branch
 *    is the fail-safe answer and the intended precedence.
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
  if (isAgentWorktreeId(owner) && activeAgentIds instanceof Set && activeAgentIds.has(owner)) {
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
 * A worktree's real uncommitted paths, or [] when clean/unreadable.
 *
 * `classifyWorktreeDirt` subtracts what is not work product — auto-generated
 * lockfiles and PortOS's own runtime scratch — so this list is only authored
 * changes. That matters here because it is what makes a branch ABANDONED_WIP,
 * the state that dispatches a coordinator agent.
 *
 * @param {string} worktreePath
 * @returns {Promise<string[]>}
 */
async function worktreeDirtyPaths(worktreePath) {
  const { stdout } = await execGit(['status', '--porcelain'], worktreePath, { ignoreExitCode: true })
    .catch(() => ({ stdout: '' }));
  const dirt = classifyWorktreeDirt(stdout);
  return dirt.hasRealChanges ? (dirt.realChangePaths || []) : [];
}

/**
 * Is a worktree's working tree carrying real (non-lockfile) uncommitted changes?
 * @param {string} worktreePath
 * @returns {Promise<boolean>}
 */
async function isWorktreeDirty(worktreePath) {
  return (await worktreeDirtyPaths(worktreePath)).length > 0;
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
    .catch((err) => ({ error: err.message }));
  if (!res || res.exitCode !== 0) {
    // One log line serves every caller across every managed app, so it has to
    // name the repo that went unread and git's own reason — without both, a
    // network blip, an unauthenticated remote and a repo with no `origin` at
    // all are one indistinguishable line and the operator has nothing to act on.
    const why = (res?.error || res?.stderr || '').trim().split('\n')[0] || `exit ${res?.exitCode}`;
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
 * Sweep `origin` for branches nothing local points at, and reap the ones whose
 * work is already merged into the default branch.
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
 * DEFAULTS TO REPORT-ONLY. `git push origin --delete` reaches off this machine to
 * a shared forge and cannot be undone from here, so it stays opt-in per the same
 * reasoning the superseded ledger uses for worktrees: automate the analysis, keep
 * the destructive step a decision someone made on purpose. Callers that have not
 * asked for `reap: true` get an unchanged, side-effect-free cycle.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {{ reap?: boolean }} [opts] - `reap: true` actually deletes the merged
 *   orphans; the default reports them under reason `reap-disabled`.
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
  for (const { branch, sha } of orphans) {
    const merged = await isBranchMergedInto(repoPath, sha, defaultBranch).catch(() => false);
    if (!merged) {
      reported.push({ branch, reason: 'unmerged-remote-only' });
      continue;
    }
    if (!reap) {
      reported.push({ branch, reason: 'reap-disabled' });
      continue;
    }
    const result = await deleteBranch(repoPath, branch, { remote: true }).catch((err) => ({ error: err.message }));
    const outcome = result?.results?.remote;
    if (result?.error || (outcome && outcome.startsWith('failed'))) {
      reported.push({ branch, reason: `remote-delete-failed: ${result.error || outcome}` });
      continue;
    }
    reaped.push(branch);
    console.log(`🔀 branch-reconcile: reaped merged orphan ${RECONCILED_REMOTE}/${branch}`);
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
 *   `isAbandonedAgentWorktree`); omitting it leaves every agent worktree protected.
 *   `remoteHeads` is `listRemoteHeads`' answer when the caller already has it;
 *   omitted, this reads it itself when the repo has an origin, and `null`
 *   (unreadable remote, or no origin to read) is carried through as "we could
 *   not ask" rather than "the remote is empty".
 *   `hasOrigin` is `getOriginInfo`'s verdict when the caller already has it (same
 *   rationale); omitted, this reads it itself, so a standalone caller still gets a
 *   truthful answer rather than the fail-closed default.
 * @returns {Promise<object[]>} one entry per candidate branch:
 *   { branch, tip, hasUpstream, hasOrigin, tracking, upstreamGone, isMerged, hasWorktree, worktreePath,
 *     worktreeDirty, dirtyPaths, behind, ahead, collisionPaths, abandonedAgentWorktree, openPr }
 */
export async function gatherBranchState(repoPath, { defaultBranch, activeAgentIds = null, remoteHeads: providedRemoteHeads, hasOrigin: providedHasOrigin, origin: providedOrigin } = {}) {
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
  const [branches, worktrees, prsByHeadOrNull, remoteHeads] = await Promise.all([
    getBranches(repoPath),
    listWorktrees(repoPath).catch(() => []),
    getOpenPrsByHead(repoPath, origin),
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

  const inputs = [];
  for (const b of candidates) {
    const upstreamName = upstreamBranchName(b.tracking);
    const wt = worktreeByBranch.get(b.name) || null;
    const worktreePath = wt?.path || null;
    const worktreeLocked = Boolean(wt?.locked);
    const worktreeAge = worktreePath ? await worktreeAgeMs(worktreePath) : null;
    const dirtyPaths = worktreePath ? await worktreeDirtyPaths(worktreePath) : [];
    const worktreeDirty = dirtyPaths.length > 0;
    const divergence = await gatherDivergence(repoPath, b.name, defaultBranch, dirtyPaths);
    // getBranches' `merged` is ancestor-based (misses squash/rebase); confirm
    // the harder cases via isBranchMergedInto (covers squash + rebase). Short
    // -circuit when the cheap check already proved it merged.
    const isMerged = b.merged || await isBranchMergedInto(repoPath, b.name, defaultBranch);
    // Tip SHA is the primary cache key for a recorded SUPERSEDED verdict (see
    // supersededLedger.js) — a branch that moved must be re-analyzed. `null` on
    // failure so an unreadable tip can never match a recorded one.
    const tipOut = await execGit(['rev-parse', b.name], repoPath, { ignoreExitCode: true }).catch(() => null);
    const tip = (tipOut?.stdout || '').trim() || null;
    inputs.push({
      branch: b.name,
      tip,
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
      isMerged,
      hasWorktree: Boolean(worktreePath),
      worktreePath,
      worktreeLocked,
      worktreeAgeMs: worktreeAge,
      worktreeDirty,
      dirtyPaths,
      // Non-null ⇒ somebody owns this branch right now (active CoS agent / live
      // human claim / locked worktree). Built on the same predicate `cleanupMerged`
      // uses to refuse a teardown, reused by the classifier to refuse a DISPATCH —
      // the two must agree, or the reconciler protects a worktree from deletion and
      // then hands its branch to an agent that rebases underneath the live session.
      liveOwnerReason: resolveLiveOwnerReason({
        branch: b.name, path: worktreePath, locked: worktreeLocked, activeAgentIds
      }),
      behind: divergence.behind,
      ahead: divergence.ahead,
      collisionPaths: divergence.collisionPaths,
      abandonedAgentWorktree: isAbandonedAgentWorktree({ path: worktreePath, locked: worktreeLocked, activeAgentIds }),
      openPr: prsByHead.get(b.name) || null,
      prStateUnavailable
    });
  }
  return inputs;
}

/**
 * How an idle reconcile should PARK — the reason, the breakdown, and the instant
 * the park may end early.
 *
 * "Nothing actionable" has three very different meanings and they used to
 * collapse into one: branches belong to sessions still running, merged branches
 * are queued behind a protected worktree, or the repo really is quiet. Only the
 * last is "nothing to do". Reporting it for the middle case is what made a task
 * with four stale claim branches waiting on it read as though it had stopped
 * running — the persisted state said zero of everything.
 *
 * Pure.
 * @param {{reason?:string, retryAt?:string|null}[]} [skipped] - cleanupMerged's skips
 * @param {object[]} [heldLive] - WIP branches with a liveOwnerReason
 * @returns {{reason:string, heldBackMerged:object[], counts:{heldBackMerged:number}|null, notLaterThan:string|null}}
 */
export function describeIdleReconcilePark(skipped = [], heldLive = []) {
  // Only worktree-* skips are a HOLD; 'not-merged-on-recheck' and 'cleanup-disabled'
  // mean the branch was never eligible, so they must not read as pending work.
  const heldBackMerged = skipped.filter((s) => s.reason?.startsWith('worktree-'));
  const lifts = heldBackMerged.map((entry) => Date.parse(entry.retryAt)).filter(Number.isFinite);
  const reason = heldLive.length
    ? 'branches-held-by-live-owners'
    : heldBackMerged.length ? 'merged-branches-held-back' : 'no-in-flight-branches';
  return {
    reason,
    heldBackMerged,
    counts: heldBackMerged.length ? { heldBackMerged: heldBackMerged.length } : null,
    // The soonest hold to lapse is when this park may end early; entries with no
    // (or an unreadable) deadline simply don't vote, leaving the normal cadence.
    notLaterThan: lifts.length ? new Date(Math.min(...lifts)).toISOString() : null
  };
}

/**
 * Deterministically clean up fully-merged branches: remove the lingering
 * worktree, then delete the local branch. Safety gates (ALL must hold):
 *   1. `isBranchMergedInto(default)` re-verified true (fail closed).
 *   2. the branch's worktree (if any) has no real uncommitted changes.
 * A failed gate skips the branch (with a reason) — never a force-delete of
 * unmerged or dirty work.
 *
 * SHIPPED_CLAIM: a `claim-*` worktree holds for STALE_CLAIM_IDLE_MS on the chance
 * a claim session is still using it. Waiting out a full week is pointless once
 * the claim has demonstrably SHIPPED, and doing it anyway is what left four
 * finished claims parked while every run reported "cleaned 0" and parked on
 * "merged branches held back" — the exact stall this reconcile exists to clear.
 *
 * A shipped claim is one where all three hold, established here in order:
 *   1. `stillMerged` — re-verified against the default branch just above.
 *   2. `upstreamGone` — the branch was pushed and its remote ref is no longer on
 *      origin, i.e. its PR merged with `--delete-branch`.
 *   3. clean worktree — the dirty gate below, which this never overrides.
 * Together they say the /claim flow finished everything except its own teardown.
 * `upstreamGone` is the discriminator the long window was standing in for: a
 * claim still being WORKED either has no upstream yet or has one that still
 * exists.
 *
 * What it does NOT prove is that the claim PROCESS has exited — so this
 * SHORTENS the idle window to SHIPPED_CLAIM_IDLE_MS rather than removing it,
 * leaving one mechanism (the age window) with two durations instead of a second
 * way past the gate. Everything the window already guarantees still holds: an
 * unreadable mtime fails safe to protected, and an explicit lock still wins.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} merged - gathered inputs whose state === 'MERGED'
 * @param {{ activeAgentIds?: Set<string> }} [opts] - CoS agents currently running;
 *   their worktrees are never torn down even when the branch is merged + clean.
 * @returns {Promise<{cleaned:string[], skipped:{branch:string,reason:string,retryAt?:string}[]}>}
 *   A skip carries `retryAt` when its hold is known to lift at a specific time.
 */
export async function cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds = new Set() } = {}) {
  const cleaned = [];
  const skipped = [];
  for (const b of merged) {
    // Re-verify at action time — state may have shifted since the gather.
    const stillMerged = await isBranchMergedInto(repoPath, b.branch, defaultBranch);
    if (!stillMerged) {
      skipped.push({ branch: b.branch, reason: 'not-merged-on-recheck' });
      continue;
    }
    // A SHIPPED claim (see SHIPPED_CLAIM above) waits out the short window instead
    // of the week-long one — `stillMerged` is proven above, and retireBranch's
    // dirty gate is still ahead of the removal.
    const retired = await retireBranch(repoPath, b, {
      activeAgentIds,
      staleClaimIdleMs: b.upstreamGone ? SHIPPED_CLAIM_IDLE_MS : STALE_CLAIM_IDLE_MS,
      label: `🔀 branch-reconcile: remove worktree for ${b.branch}`,
    });
    if (!retired.ok) {
      const { ok, ...failure } = retired;
      skipped.push({ branch: b.branch, ...failure });
      continue;
    }
    cleaned.push(b.branch);
  }
  return { cleaned, skipped };
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
 * What makes deleting safe here is the BACKUP, not the verdict: nothing is
 * removed until `backupSupersededBranch` has written the branch's commits, its
 * worktree diff and its untracked files under
 * `data/cos/abandoned-worktree-backups/`. A backup that throws skips the reap.
 *
 * Ordering is deliberate and costs nothing to get right: the verdict/branch
 * pairing is a pure contract check for a direct caller (through `reconcile` it is
 * already proven by `isVerdictFresh`, but this function is exported and deletes
 * things, so it does not take the pairing on faith), then `retireBranch`'s own
 * pure protection gate, and only then — as its `prepare` hook, past every way
 * this can still refuse — is a backup written. A branch permanently held by a
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
export async function reapSupersededBranches(repoPath, defaultBranch, superseded, { activeAgentIds = new Set(), cosDir } = {}) {
  const reaped = [];
  const held = [];
  const skipped = [];
  const hold = (b, failure) => { held.push(b); skipped.push({ branch: b.branch, ...failure }); };

  for (const b of superseded || []) {
    const verdict = b.verdict || {};
    // Same comparison isVerdictFresh makes, via the same helper — a raw compare
    // here would hold a pre-upgrade entry that the partition just accepted.
    if (!b.tip || b.tip !== verdict.tip || !sameDirtyPaths(verdict.dirtyPaths, b.dirtyPaths)) {
      hold(b, { reason: 'verdict-does-not-match-branch' });
      continue;
    }
    const retired = await retireBranch(repoPath, b, {
      activeAgentIds,
      label: `🔀 branch-reconcile: remove superseded worktree for ${b.branch}`,
      // The dirty tree IS this branch's deliverable — an abandoned agent worktree
      // has no commits of its own — so refusing on it would make the reap a no-op
      // for the exact shape it exists to retire. What replaces the gate: the
      // verdict was recorded against these same paths (checked above) and
      // `prepare` copies them into the backup before anything is removed.
      requireCleanWorktree: false,
      prepare: async () => {
        const backup = await backupSupersededBranch(repoPath, b, { defaultBranch, ...(cosDir ? { cosDir } : {}) })
          .catch((err) => ({ error: err.message }));
        if (!backup?.error) return backup;
        console.error(`❌ branch-reconcile: backup failed for ${b.branch}, not reaping: ${backup.error}`);
        return { error: `backup-failed: ${backup.error}` };
      },
    });
    if (!retired.ok) {
      const { ok, ...failure } = retired;
      hold(b, failure);
      continue;
    }
    const backup = retired.prepared;
    // Keep the verdict, stamped with what happened to it. The entry is now a
    // record rather than a cache — it names the backup a human needs to undo this.
    await recordVerdict(
      { ...verdict, branch: b.branch, repoPath, reapedAt: new Date().toISOString(), backupPatch: backup.dir },
      cosDir
    ).catch((err) => console.error(`⚠️ branch-reconcile: reaped ${b.branch} but could not update the verdict ledger: ${err.message}`));
    console.log(`🔀 branch-reconcile: reaped superseded branch ${b.branch} (backup: ${backup.dir})`);
    reaped.push(b.branch);
  }
  return { reaped, held, skipped };
}

/**
 * Remove a branch's worktree (when it has one) and delete the local branch.
 *
 * The destructive tail shared by `cleanupMerged` and `reapSupersededBranches`.
 * Both prove their own safety FIRST — one that the work is merged, the other
 * that it is superseded and backed up — and then run exactly this: the same
 * protection gate, the same dirty-tree refusal, the same removal order (the
 * branch delete fails while a worktree still has it checked out). Extracted so
 * the two cannot drift, since a guard added to one and missed on the other is a
 * data-loss bug rather than an inconsistency.
 *
 * @param {string} repoPath
 * @param {object} b - a gathered branch entry
 * @param {{ activeAgentIds?: Set<string>, staleClaimIdleMs?: number, label: string, requireCleanWorktree?: boolean, prepare?: () => Promise<any> }} opts
 *   `prepare` runs after every gate has passed and before the first irreversible
 *   step, and aborts the retirement by resolving to `{ error }`. That is the only
 *   place work like "write a recoverable backup" belongs: earlier it is paid for
 *   branches that are then refused, later it is too late to matter.
 *
 *   `requireCleanWorktree` (default true) is the caller's answer to "could this
 *   tree hold work that is not accounted for?". For `cleanupMerged` it can, so a
 *   dirty tree refuses: merged proves the COMMITS landed and says nothing about
 *   the working tree. `reapSupersededBranches` sets it false because the dirty
 *   tree is the branch's whole deliverable and it accounts for that tree twice
 *   over — the verdict was recorded against exactly these paths, and `prepare`
 *   copies them out before anything is removed. Never set it false without both.
 * @returns {Promise<{ ok: true, prepared?: any } | { ok: false, reason: string, retryAt?: string }>}
 */
async function retireBranch(repoPath, b, { activeAgentIds = new Set(), staleClaimIdleMs = STALE_CLAIM_IDLE_MS, label, requireCleanWorktree = true, prepare }) {
  if (b.worktreePath) {
    // Never tear down a worktree that's locked, a RECENT human /claim session, or
    // an active CoS agent workspace. An abandoned claim worktree (clean and older
    // than the window) falls through and IS retired; that's the "cleaned 0
    // forever" leak this exists to close.
    const gate = {
      path: b.worktreePath,
      locked: b.worktreeLocked,
      activeAgentIds,
      ageMs: b.worktreeAgeMs,
      staleClaimIdleMs,
    };
    const protectedReason = worktreeProtectionReason(gate);
    if (protectedReason) {
      // Carry WHEN the hold lifts when it lifts on a clock (a claim worktree
      // still inside its grace window). Without it the caller can only park on
      // the recheck cadence and the two waits stack — see boundParkedUntil.
      const retryAt = worktreeProtectionExpiresAt(gate);
      return { ok: false, reason: protectedReason, ...(retryAt ? { retryAt } : {}) };
    }
    if (requireCleanWorktree && await isWorktreeDirty(b.worktreePath)) return { ok: false, reason: 'worktree-dirty' };
  }
  const prepared = prepare ? await prepare() : null;
  if (prepared?.error) return { ok: false, reason: prepared.error };
  if (b.worktreePath) await forceRemoveWorktreeDir(repoPath, b.worktreePath, { label, log: 'all' });
  const result = await deleteBranch(repoPath, b.branch, { local: true }).catch((err) => ({ error: err.message }));
  if (result?.error || result?.results?.local?.startsWith?.('failed')) {
    return { ok: false, reason: `delete-failed: ${result.error || result.results.local}` };
  }
  return { ok: true, prepared };
}

/**
 * Full Tier-1 reconcile: gather → classify → clean up merged + verified-superseded.
 * Returns the in-flight set (branches needing an agent) for the scheduler to dispatch.
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ cleanup?: boolean, reapSuperseded?: boolean, reapRemotes?: boolean, activeAgentIds?: Set<string> }} [opts] - when
 *   cleanup is false, merged branches are reported (in `skipped`, reason
 *   `cleanup-disabled`) but not deleted. `reapSuperseded` (defaults to `cleanup`)
 *   governs the separate destructive step for verified-superseded branches, whose
 *   work is NOT on the default branch and survives only as a backup — a caller
 *   whose "clean up merged branches" toggle never meant that turns it off
 *   explicitly. `reapRemotes` (default false) additionally deletes merged
 *   branches left on `origin` that nothing local points at; off, they are only
 *   reported — see `reapOrphanedRemotes`. `activeAgentIds` protects in-use CoS
 *   agent worktrees.
 * @returns {Promise<{ defaultBranch:string, cleaned:string[], inFlight:object[], wip:object[], skipped:{branch:string,reason:string}[], orphanRemotes:{reaped:string[],reported:object[]}, forgeUnavailable?:boolean, prStateUnavailable?:boolean }>}
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
export async function reconcile(repoPath = PATHS.root, { cleanup = true, reapSuperseded = cleanup, reapRemotes = false, activeAgentIds = new Set() } = {}) {
  // Worktree cleanup is the first reconcile step, before any forge probe. It
  // only removes a tree after proving both that it is completely clean and
  // that every branch commit is already in the default branch (including
  // squash/rebase-equivalent merges). Keeping this pass ahead of gh means a
  // temporary forge outage cannot strand locally-provable completed work.
  const worktreeCleanup = cleanup
    ? await reapMergedWorktrees(repoPath, { activeAgentIds, includeClaudeTrees: true }).catch(() => ({ reaped: [] }))
    : { reaped: [] };
  const cleanedWorktrees = (worktreeCleanup.reaped || [])
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
  if (githubRepoSpec(origin)) {
    const forge = await ensureForgeReachable('branch-reconcile', { hostname: githubApiHost(origin.host) });
    if (!forge.ok) {
      return { defaultBranch: null, cleaned: cleanedWorktrees, inFlight: [], wip: [], skipped: [], forgeUnavailable: true, forgeStatus: forge.status };
    }
  }

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
    defaultBranch, activeAgentIds, remoteHeads, hasOrigin: Boolean(origin?.hasOrigin), origin
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
  // A verified-superseded branch is TERMINAL, so it is reaped here rather than
  // reported: nothing else can ever retire it, and a report that survives every
  // pass is how nine of them accumulated in this install. Backed up first, and
  // held by the same protection gate as cleanupMerged — see reapSupersededBranches.
  const supersededReap = reapSuperseded
    ? await reapSupersededBranches(repoPath, defaultBranch, superseded, { activeAgentIds })
    : { reaped: [], held: superseded, skipped: superseded.map((b) => ({ branch: b.branch, reason: 'reap-superseded-disabled' })) };
  // Every WIP entry carries its `liveOwnerReason`, so a caller that needs the
  // "held by a live owner" subset (to report "the only branches left belong to
  // running sessions" rather than a bare "nothing actionable") filters `wip` on it.
  const wip = classified.filter((c) => c.state === 'WIP');

  const { cleaned: cleanedBranches, skipped } = cleanup
    ? await cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds })
    : { cleaned: [], skipped: merged.map((m) => ({ branch: m.branch, reason: 'cleanup-disabled' })) };
  const cleaned = [...new Set([...cleanedWorktrees, ...cleanedBranches])];

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
    // Kept OUT of `cleaned`: readers of that key render it as "deleted merged
    // branch" (repoSync.js) and a superseded branch is precisely not merged.
    reapedSuperseded: supersededReap.reaped,
    inFlight,
    // Only the branches still standing — listing a deleted one would put it in
    // the coordinator prompt.
    superseded: supersededReap.held,
    wip,
    skipped: [...skipped, ...supersededReap.skipped],
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
    recordVerdictInstruction(),
    'Only once you have confirmed the work is still needed, continue.'
  ].join(' ');
};

// Nothing reaches a PR unverified. `/do:pr` runs its own reviewer loop, but the
// branch has to be sound BEFORE that — a rebase onto a default branch that moved
// can break code that passed on the old base, and CI failing on an already-open
// PR costs a whole round trip. Rebase first (so the PR is conflict-free by
// construction), then run the touched workspaces' suites locally.
const verifyGate = 'Rebase onto the default branch before opening or updating a PR, so the PR is conflict-free by construction rather than needing a merge fixed up later. Then run the test suites for the workspaces the diff touches (`cd server && npm test`, `cd client && npm test`) plus lint, and read the result — the rebase can break code that passed on the old base. If anything fails, fix it on the branch and re-run; if you cannot get it green, stop and report which suite fails and why. Never push a branch whose tests you have not seen pass.';

// The terminal state of an auto-mergeable branch is MERGED — not "PR opened",
// not "PR green and waiting". Every drive-to-merge instruction ends with this
// tail so the agent waits CI out IN-SESSION instead of handing back an open PR
// (the miss that left a green, MERGEABLE PR sitting open after a NEEDS_PR run:
// the agent opened it and signaled done 51s later). GitHub-native `--auto` is
// deliberately not the answer on its own — the agent exits the moment it
// finishes, so a queued auto-merge that later goes red has nobody left to fix
// it, and the branch silently stays in-flight until the next recheck.
//
// `pr` is the PR's number when the branch already has one, else the `<num>`
// placeholder the agent fills in after opening it.
// Exported so the per-agent repo-state audit (services/agentRepoStateVerification.js)
// hands a recovery agent the SAME merge procedure, rather than re-authoring a
// `gh pr merge` line that loses these caveats.
export const driveToMerge = (pr) => [
  'Opening (or approving) the PR is NOT the end state — a green PR left open is still an unfinished branch that this task will simply re-drive on its next run.',
  `Wait for CI in-session by re-polling \`gh pr checks ${pr} --required\` every 30s so the run stays observable while CI is pending. Budget 15 minutes for the run; past that, leave the PR open and report that CI was still pending.`,
  'If a required check FAILS, fix it on the branch, push, and re-poll (max 3 rounds); if it is still red after that, leave the PR open and report exactly which check failed.',
  `Once every required check is green AND the PR is MERGEABLE, merge it — from the repo root, NOT from inside the branch's worktree (\`gh\` can't delete a branch that is checked out elsewhere): \`gh pr merge ${pr} --merge --delete-branch\`. Repos differ in which methods they allow, so on a "not allowed" error retry with \`--squash\`, then \`--rebase\`. Never \`--auto\`: a queued auto-merge outlives this run, so a check that goes red afterward has nobody left to fix it.`,
  'After the merge, remove the branch\'s worktree first, then delete the local branch — the delete fails while a worktree still has it checked out.'
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
export function desiredEndState(state, actions, { prNumber, worktreePath, collisionPaths, behind } = {}) {
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
    const assess = `This branch has no commits of its own — its work is sitting UNCOMMITTED in ${where}, the worktree of a CoS agent that is no longer running (it exited, crashed, or was reaped before committing). Nothing is lost, but nothing lands either until someone finishes it. Working INSIDE that worktree, run \`git status\` and \`git diff\` (plus \`git diff\` against untracked files) and read the WHOLE change set before touching anything. Then judge whether it is coherent, finished work: the test suites for the touched workspaces pass, no stub/TODO/placeholder left mid-edit, no half-renamed symbol.`;
    const bail = 'If it is NOT finished, do not commit it and do not delete it — leave every file exactly as it is and report what the work appears to be, how far it got, and what is missing, so a human can decide whether to finish or discard it.';
    const commit = 'If it IS finished, commit it on this branch (a message that states what changed and why — never a bare "wip"), then ship it with `/do:pr --no-merge` (by hand, if slash commands are unavailable: self-review the diff, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan).';
    if (!actionOn(actions, 'autoMerge')) {
      return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} ${driveToMerge(pr)}`;
  }
  if (state === 'NEEDS_PR') {
    const verify = `${stillNeeded} Verify the branch's work is complete and ready (tests pass, no stubs/TODO markers). If NOT ready, report it as incomplete and leave the branch untouched — do not open a half-baked PR.`;
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
    return `${verify} If ready, ship it with ${openPr}. ${verifyGate} ${driveToMerge(pr)}`;
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
    return `${resolve} ${driveToMerge(pr)}`;
  }
  // IN_REVIEW
  const canMerge = actionOn(actions, 'autoMerge');
  // Existing PRs have already passed through whatever review workflow the repo
  // uses. Reconciliation must not request or assume a particular reviewer; its
  // merge gate is the forge's live CI and mergeability state.
  return `Drive the open PR toward green: inspect any existing review feedback and address it.${canMerge
    ? ` Merge ONLY when CI is green and the PR is MERGEABLE. ${driveToMerge(pr)}`
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
    .map((b) => `${b.branch}:${b.state}:${b.openPr?.number ?? 'none'}`)
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
 * Render the actionable in-flight branch set into the coordinator prompt body
 * (injected as `{inFlightBranches}`).
 * @param {object[]} inFlight - actionable branches (post-filterActionable)
 * @param {{ defaultBranch:string, actions:object, branchesPerAgent?:number }} ctx
 * @returns {string}
 */
export function formatInFlightForPrompt(inFlight, { defaultBranch, actions, branchesPerAgent } = {}) {
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  if (Number.isInteger(branchesPerAgent) && branchesPerAgent > 0) {
    lines.splice(1, 0, `This coordinator run is limited to up to ${branchesPerAgent} branch(es); finish every branch listed below before reporting done.`);
  }
  for (const b of inFlight) {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\`${b.state === 'ABANDONED_WIP' ? ' (holds UNCOMMITTED work — read it before doing anything)' : ''}`);
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
    lines.push(`- Do: ${desiredEndState(b.state, actions, {
      prNumber: b.openPr?.number,
      worktreePath: b.worktreePath,
      collisionPaths: b.collisionPaths,
      behind: b.behind
    })}`);
    lines.push('');
  }
  return lines.join('\n');
}
