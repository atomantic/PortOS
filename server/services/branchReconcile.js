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
 * PEER SAFETY: only `refs/heads/` (local) branches are ever considered. A branch
 * created on a federated peer exists here only as a remote-tracking ref
 * (`origin/*`), never as a local branch, so it is structurally invisible. We
 * never author-filter — every machine shares one GitHub login, so authorship
 * can't distinguish machines; local-branch existence can.
 */

import { stat } from 'node:fs/promises';
import { getBranches, getDefaultBranch, isBranchMergedInto, deleteBranch } from './git.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, forceRemoveWorktreeDir, classifyWorktreeDirt, isHumanClaimWorktree } from './worktreeManager.js';
import { execGh, ensureForgeReachable } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';

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

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

/**
 * Pure classifier: map one branch's git/PR facts to a reconcile state.
 * First match wins.
 *   ABANDONED_WIP — dirty worktree of a DEAD CoS agent → agent finishes the work
 *   MERGED     — work is fully in the default branch → deterministic cleanup
 *   CONFLICTED — open PR with merge conflicts        → agent resolves
 *   IN_REVIEW  — open PR, otherwise                  → agent drives to merge
 *   NEEDS_PR   — pushed, not merged, no PR, clean     → agent verifies + opens PR
 *   WIP        — local-only or dirty worktree         → skip + report (never touch)
 *
 * @param {{ hasUpstream:boolean, isMerged:boolean, worktreeDirty:boolean, abandonedAgentWorktree?:boolean, openPr:({mergeable?:string}|null), prStateUnavailable?:boolean }} input
 *   `prStateUnavailable` means the forge could not be READ this cycle — distinct
 *   from `openPr: null` ("the forge answered: no open PR").
 * @returns {'ABANDONED_WIP'|'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP'}
 */
export function classifyBranch({ hasUpstream, isMerged, worktreeDirty, abandonedAgentWorktree, openPr, prStateUnavailable = false }) {
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
  if (hasUpstream) return 'NEEDS_PR';
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
 * @returns {Promise<Map<string, {number:number, mergeable:string, isDraft:boolean, url:string}>|null>}
 */
async function getOpenPrsByHead(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
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
 * (mirrors the guards the existing worktree reaper honors):
 *   - locked            → the user explicitly `git worktree lock`ed it
 *   - human `/claim`    → a `claim-<slug>` worktree self-cleaned by the /claim flow,
 *                         UNLESS it is an abandoned one older than `staleClaimIdleMs`
 *                         (`ageMs` supplied) — those are reaped (see STALE_CLAIM_IDLE_MS)
 *   - active CoS agent  → an agent (`agent-<id>`) is currently running in it
 * Sibling worktrees (`next-issue-*`, etc.) whose basename is none of these fall
 * through to null and are cleaned normally.
 *
 * @param {{ path:string, locked?:boolean, activeAgentIds?:Set<string>, ageMs?:number, staleClaimIdleMs?:number }} input
 * @returns {string|null}
 */
export function worktreeProtectionReason({ path, locked, activeAgentIds, ageMs, staleClaimIdleMs = STALE_CLAIM_IDLE_MS }) {
  if (locked) return 'worktree-locked';
  const basename = (path || '').split('/').pop() || '';
  if (isHumanClaimWorktree(basename)) {
    // Reap an abandoned claim (age known AND past the idle window); keep protecting
    // a recent one so a live human /claim session — or its Phase-7 self-clean — wins.
    // Unknown age (ageMs omitted) stays protected: fail safe toward not-deleting.
    if (typeof ageMs === 'number' && ageMs >= staleClaimIdleMs) return null;
    return 'worktree-human-claim';
  }
  if (activeAgentIds?.has(basename)) return 'worktree-active-agent';
  return null;
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
  if (!path || locked || !(activeAgentIds instanceof Set)) return false;
  const basename = path.split('/').pop() || '';
  if (!basename.startsWith('agent-') || isHumanClaimWorktree(basename)) return false;
  return !activeAgentIds.has(basename);
}

/**
 * A worktree's real (non-lockfile) uncommitted paths, or [] when clean/unreadable.
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
 * @param {{ defaultBranch:string, activeAgentIds?:Set<string> }} ctx - `activeAgentIds`
 *   distinguishes a live agent's worktree from an abandoned one (see
 *   `isAbandonedAgentWorktree`); omitting it leaves every agent worktree protected.
 * @returns {Promise<object[]>} one entry per candidate branch:
 *   { branch, hasUpstream, isMerged, hasWorktree, worktreePath, worktreeDirty, dirtyPaths,
 *     behind, ahead, collisionPaths, abandonedAgentWorktree, openPr }
 */
export async function gatherBranchState(repoPath, { defaultBranch, activeAgentIds = null }) {
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);

  const [branches, worktrees, prsByHeadOrNull] = await Promise.all([
    getBranches(repoPath),
    listWorktrees(repoPath).catch(() => []),
    getOpenPrsByHead(repoPath)
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
    inputs.push({
      branch: b.name,
      hasUpstream: Boolean(b.tracking),
      isMerged,
      hasWorktree: Boolean(worktreePath),
      worktreePath,
      worktreeLocked,
      worktreeAgeMs: worktreeAge,
      worktreeDirty,
      dirtyPaths,
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
 * Deterministically clean up fully-merged branches: remove the lingering
 * worktree, then delete the local branch. Safety gates (ALL must hold):
 *   1. `isBranchMergedInto(default)` re-verified true (fail closed).
 *   2. the branch's worktree (if any) has no real uncommitted changes.
 * A failed gate skips the branch (with a reason) — never a force-delete of
 * unmerged or dirty work.
 *
 * @param {string} repoPath
 * @param {string} defaultBranch
 * @param {object[]} merged - gathered inputs whose state === 'MERGED'
 * @param {{ activeAgentIds?: Set<string> }} [opts] - CoS agents currently running;
 *   their worktrees are never torn down even when the branch is merged + clean.
 * @returns {Promise<{cleaned:string[], skipped:{branch:string,reason:string}[]}>}
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
    if (b.worktreePath) {
      // Never tear down a worktree that's locked, a RECENT human /claim session, or
      // an active CoS agent workspace — even if its branch is merged and clean. An
      // abandoned claim worktree (merged + clean + older than STALE_CLAIM_IDLE_MS)
      // falls through and IS reaped; that's the "cleaned 0 forever" leak this fixes.
      const protectedReason = worktreeProtectionReason({
        path: b.worktreePath, locked: b.worktreeLocked, activeAgentIds, ageMs: b.worktreeAgeMs
      });
      if (protectedReason) {
        skipped.push({ branch: b.branch, reason: protectedReason });
        continue;
      }
      const dirty = await isWorktreeDirty(b.worktreePath);
      if (dirty) {
        skipped.push({ branch: b.branch, reason: 'worktree-dirty' });
        continue;
      }
      await forceRemoveWorktreeDir(repoPath, b.worktreePath, {
        label: `🔀 branch-reconcile: remove worktree for ${b.branch}`, log: 'all'
      });
    }
    const result = await deleteBranch(repoPath, b.branch, { local: true }).catch((err) => ({ error: err.message }));
    if (result?.error || result?.results?.local?.startsWith?.('failed')) {
      skipped.push({ branch: b.branch, reason: `delete-failed: ${result.error || result.results.local}` });
      continue;
    }
    cleaned.push(b.branch);
  }
  return { cleaned, skipped };
}

/**
 * Full Tier-1 reconcile: gather → classify → clean up merged. Returns the
 * in-flight set (branches needing an agent) for the scheduler to dispatch.
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ cleanup?: boolean, activeAgentIds?: Set<string> }} [opts] - when cleanup
 *   is false, merged branches are reported (in `skipped`, reason `cleanup-disabled`)
 *   but not deleted. `activeAgentIds` protects in-use CoS agent worktrees.
 * @returns {Promise<{ defaultBranch:string, cleaned:string[], inFlight:object[], wip:object[], skipped:{branch:string,reason:string}[], forgeUnavailable?:boolean, prStateUnavailable?:boolean }>}
 *   `forgeUnavailable: true` means the cycle was SKIPPED before it started because
 *   the `gh` probe failed; `prStateUnavailable: true` means it ran but a gh read
 *   failed mid-cycle. Either way an empty `inFlight` says nothing about the repo
 *   and the caller must retry rather than park on it (#3358).
 */
export async function reconcile(repoPath = PATHS.root, { cleanup = true, activeAgentIds = new Set() } = {}) {
  // Every classification below depends on PR state, so an unreadable forge makes
  // the whole pass a guess. Skip with one line rather than report a quiet repo.
  // Probed against THIS repo's API host (enterprise-correct) — a bare probe
  // would gate an enterprise checkout on github.com's health. A non-GitHub
  // origin has no host to probe and falls through to gh's default, which is the
  // pre-existing behavior for the `new Map()` no-PR-state path below.
  const origin = await getOriginInfo(repoPath).catch(() => null);
  const forge = await ensureForgeReachable('branch-reconcile', { hostname: githubApiHost(origin?.host) });
  if (!forge.ok) {
    return { defaultBranch: null, cleaned: [], inFlight: [], wip: [], skipped: [], forgeUnavailable: true, forgeStatus: forge.status };
  }

  const defaultBranch = await getDefaultBranch(repoPath).catch(() => 'main') || 'main';
  const inputs = await gatherBranchState(repoPath, { defaultBranch, activeAgentIds });
  // A gh failure AFTER a passing probe (a blip mid-cycle, or an unparseable
  // page) is still "we could not ask" — surface it so the caller retries next
  // tick instead of parking on an in-flight set built from unknown PR state.
  const prStateUnavailable = inputs.some((i) => i.prStateUnavailable);
  const classified = classifyBranches(inputs);

  const merged = classified.filter((c) => c.state === 'MERGED');
  // Priority-ordered so the coordinator agent works recognized work branches
  // (claim/cos/next/feature/fix/…) before anything unrecognized. The order flows
  // straight through filterActionable (a stable filter) into the prompt block.
  const inFlight = prioritizeBranches(
    classified.filter((c) => ['ABANDONED_WIP', 'CONFLICTED', 'IN_REVIEW', 'NEEDS_PR'].includes(c.state))
  );
  const wip = classified.filter((c) => c.state === 'WIP');

  const { cleaned, skipped } = cleanup
    ? await cleanupMerged(repoPath, defaultBranch, merged, { activeAgentIds })
    : { cleaned: [], skipped: merged.map((m) => ({ branch: m.branch, reason: 'cleanup-disabled' })) };

  return { defaultBranch, cleaned, inFlight, wip, skipped, prStateUnavailable };
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
const driveToMerge = (pr) => [
  'Opening (or approving) the PR is NOT the end state — a green PR left open is still an unfinished branch that this task will simply re-drive on its next run.',
  `Wait for CI in-session by re-polling \`gh pr checks ${pr} --required\` every 30s — each poll prints output, which keeps this run clear of the idle reaper the way a silent \`--watch\` does not. Budget 15 minutes for the run; past that, leave the PR open and report that CI was still pending.`,
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
    const assess = `This branch has no commits of its own — its work is sitting UNCOMMITTED in ${where}, the worktree of a CoS agent that is no longer running (it exited, crashed, or was reaped before committing). Nothing is lost, but nothing lands either until someone finishes it. Working INSIDE that worktree, run \`git status\` and \`git diff\` (plus \`git diff\` against untracked files) and read the WHOLE change set before touching anything. Then judge whether it is coherent, finished work: the test suites for the touched workspaces pass, no stub/TODO/placeholder left mid-edit, no half-renamed symbol, and a \`.changelog/NEXT.md\` entry present.`;
    const bail = 'If it is NOT finished, do not commit it and do not delete it — leave every file exactly as it is and report what the work appears to be, how far it got, and what is missing, so a human can decide whether to finish or discard it.';
    const commit = 'If it IS finished, commit it on this branch (a message that states what changed and why — never a bare "wip"), then ship it with `/do:pr --no-merge` (by hand, if slash commands are unavailable: self-review the diff, `git push -u origin <branch>`, then `gh pr create` with a Summary + Test plan).';
    if (!actionOn(actions, 'autoMerge')) {
      return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} Do NOT merge (auto-merge is disabled) — stop once the PR is open and report its URL.`;
    }
    return `${stillNeeded} ${assess} ${bail} ${commit} ${verifyGate} ${driveToMerge(pr)}`;
  }
  if (state === 'NEEDS_PR') {
    const verify = `${stillNeeded} Verify the branch's work is complete and ready (tests pass, no stubs/TODO markers, changelog present). If NOT ready, report it as incomplete and leave the branch untouched — do not open a half-baked PR.`;
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
  // The Copilot gate is time-boxed for the same reason the merge waits on CI
  // in-session: a repo without Copilot review enabled never produces one, and an
  // unbounded "await the review" leaves a green PR open forever. 10 minutes
  // mirrors the claim-issue flow's Copilot poll.
  return `Drive the open PR toward green: request/await the Copilot review and address feedback.${canMerge
    ? ` Merge ONLY when the LATEST Copilot review reports "0 comments" (pre-resolved threads do NOT count; a PR over 20k lines is exempt from the Copilot check and needs only CI-green + mergeable). If no Copilot review lands within 10 minutes of requesting it, the Copilot gate is satisfied — this repo may not have Copilot review enabled — and CI-green + MERGEABLE is the whole gate. ${driveToMerge(pr)}`
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
 * @param {object[]} actionable - post-filterActionable branches
 * @returns {string}
 */
export function actionableSignature(actionable) {
  return actionable
    .map((b) => `${b.branch}:${b.state}:${b.openPr?.number ?? 'none'}:${b.openPr?.mergeable ?? 'none'}`)
    .sort()
    .join('|');
}

/**
 * Render the actionable in-flight branch set into the coordinator prompt body
 * (injected as `{inFlightBranches}`).
 * @param {object[]} inFlight - actionable branches (post-filterActionable)
 * @param {{ defaultBranch:string, actions:object }} ctx
 * @returns {string}
 */
export function formatInFlightForPrompt(inFlight, { defaultBranch, actions }) {
  const lines = [`Default branch: \`${defaultBranch}\`. Branches to reconcile (${inFlight.length}):`, ''];
  for (const b of inFlight) {
    const pr = b.openPr ? ` — PR #${b.openPr.number} (${b.openPr.mergeable})${b.openPr.url ? ` ${b.openPr.url}` : ''}` : ' — no PR';
    lines.push(`### \`${b.branch}\` [${b.state}]${pr}`);
    if (b.worktreePath) lines.push(`- Worktree: \`${b.worktreePath}\`${b.state === 'ABANDONED_WIP' ? ' (holds UNCOMMITTED work — read it before doing anything)' : ''}`);
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
