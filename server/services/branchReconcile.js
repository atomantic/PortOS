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

import { getBranches, getDefaultBranch, isBranchMergedInto, deleteBranch } from './git.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees, forceRemoveWorktreeDir, classifyWorktreeDirt } from './worktreeManager.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

// Never reconciled — these are long-lived shared branches, not disposable work.
// The resolved default branch is added on top at runtime.
export const PROTECTED_BRANCHES = ['main', 'master', 'release'];

// Bound the gh query (single-user repos never realistically truncate at 200).
const PR_LIST_LIMIT = 200;

/**
 * Pure classifier: map one branch's git/PR facts to a reconcile state.
 * First match wins.
 *   MERGED     — work is fully in the default branch → deterministic cleanup
 *   CONFLICTED — open PR with merge conflicts        → agent resolves
 *   IN_REVIEW  — open PR, otherwise                  → agent drives to merge
 *   NEEDS_PR   — pushed, not merged, no PR, clean     → agent verifies + opens PR
 *   WIP        — local-only or dirty worktree         → skip + report (never touch)
 *
 * @param {{ hasUpstream:boolean, isMerged:boolean, worktreeDirty:boolean, openPr:({mergeable?:string}|null) }} input
 * @returns {'MERGED'|'CONFLICTED'|'IN_REVIEW'|'NEEDS_PR'|'WIP'}
 */
export function classifyBranch({ hasUpstream, isMerged, worktreeDirty, openPr }) {
  if (isMerged) return 'MERGED';
  if (openPr) return openPr.mergeable === 'CONFLICTING' ? 'CONFLICTED' : 'IN_REVIEW';
  if (hasUpstream && !worktreeDirty) return 'NEEDS_PR';
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
 * Returns an empty Map on any gh failure (degrade: treat as "no PR").
 * @param {string} repoPath
 * @returns {Promise<Map<string, {number:number, mergeable:string, isDraft:boolean, url:string}>>}
 */
async function getOpenPrsByHead(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin?.isGithub || !origin.fullName) return new Map();
  const raw = await execGh([
    'pr', 'list', '--repo', origin.fullName, '--state', 'open',
    '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,mergeable,isDraft,url'
  ]).catch(() => null);
  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) return new Map();
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
 * Is a worktree's working tree carrying real (non-lockfile) uncommitted changes?
 * @param {string} worktreePath
 * @returns {Promise<boolean>}
 */
async function isWorktreeDirty(worktreePath) {
  const { stdout } = await execGit(['status', '--porcelain'], worktreePath, { ignoreExitCode: true })
    .catch(() => ({ stdout: '' }));
  return classifyWorktreeDirt(stdout).hasRealChanges;
}

/**
 * Gather the raw git/PR facts for every local feature branch in `repoPath`.
 * Excludes the default branch, the currently-checked-out branch, and the
 * always-protected set. Effectful (git + gh).
 *
 * @param {string} repoPath
 * @param {{ defaultBranch:string }} ctx
 * @returns {Promise<object[]>} one entry per candidate branch:
 *   { branch, hasUpstream, isMerged, hasWorktree, worktreePath, worktreeDirty, openPr }
 */
export async function gatherBranchState(repoPath, { defaultBranch }) {
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);

  const [branches, worktrees, prsByHead] = await Promise.all([
    getBranches(repoPath),
    listWorktrees(repoPath).catch(() => []),
    getOpenPrsByHead(repoPath)
  ]);

  // Map local branch name -> worktree path (strip the refs/heads/ prefix).
  const worktreeByBranch = new Map();
  for (const wt of worktrees) {
    const name = wt.branch?.replace(/^refs\/heads\//, '');
    if (name) worktreeByBranch.set(name, wt.path);
  }

  const candidates = branches.filter(
    (b) => !b.isDefault && !b.current && !protectedSet.has(b.name)
  );

  const inputs = [];
  for (const b of candidates) {
    const worktreePath = worktreeByBranch.get(b.name) || null;
    const worktreeDirty = worktreePath ? await isWorktreeDirty(worktreePath) : false;
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
      worktreeDirty,
      openPr: prsByHead.get(b.name) || null
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
 * @returns {Promise<{cleaned:string[], skipped:{branch:string,reason:string}[]}>}
 */
export async function cleanupMerged(repoPath, defaultBranch, merged) {
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
 * @returns {Promise<{ defaultBranch:string, cleaned:string[], inFlight:object[], wip:object[], skipped:{branch:string,reason:string}[] }>}
 */
export async function reconcile(repoPath = PATHS.root) {
  const defaultBranch = await getDefaultBranch(repoPath).catch(() => 'main') || 'main';
  const inputs = await gatherBranchState(repoPath, { defaultBranch });
  const classified = classifyBranches(inputs);

  const merged = classified.filter((c) => c.state === 'MERGED');
  const inFlight = classified.filter((c) => ['CONFLICTED', 'IN_REVIEW', 'NEEDS_PR'].includes(c.state));
  const wip = classified.filter((c) => c.state === 'WIP');

  const { cleaned, skipped } = await cleanupMerged(repoPath, defaultBranch, merged);

  return { defaultBranch, cleaned, inFlight, wip, skipped };
}
