/**
  * Worktree ownership: the one policy for whether PortOS may move or remove a worktree.
  *
  * Adoption moves a directory and reapers remove one, so callers share this pure gate (managed root, agent id, lock, liveness, claim) instead of slightly different copies; the ORDER is policy (see `worktreeOwnershipReason`). Callers opt into intentional differences: a reaper may include `.claude/worktrees/`, stale claims are reclaimed only by branch reconciliation, and a live claim reads as unowned only for branch-reconcile's dispatch side and a non-committing coordinator follow-up (review-loop, PR-remediation) adopting the exact branch it exists to land (all three name the branch, not merely the directory).
 */

import { win32 } from 'path';
import { isPathInsideDir } from './fileUtils.js';
import { kebabCase, truncateOnBoundary } from './textUtils.js';

/** Directory basename from either POSIX or Windows git worktree output. */
export function worktreeAgentId(worktreePath) {
  return win32.basename(worktreePath || '');
}

/** True for a worktree owned by the human `/claim` lifecycle. */
export function isHumanClaimWorktree(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('claim-');
}

/**
 * The per-app namespace segment for a worktree directory inside the SHARED `data/cos/worktrees/` root. A directory named only after the work item (`claim-issue-10`, `claim-<plan-slug>`) collides when two apps
 * share an issue number or PLAN slug (the second `git worktree add` fails on a tree the first owns, and reapers can't tell whose it is). The app NAME alone doesn't isolate (names may repeat), so the app ID disambiguates;
 * the name rides in front only for humans listing the directory. Eight id characters keep paths readable in agent logs and `git worktree list`.
 * Callers render this INSIDE the `claim-`-prefixed name (`claim-<slug>-issue-10`), never in front: `isHumanClaimWorktree` keys on that prefix. Pure.
 *
 * @param {{id?: string, name?: string}} app - the managed-app record
 * @returns {string}
 */
export function appWorktreeSlug(app) {
  const name = truncateOnBoundary(kebabCase(app?.name), 24);
  // Sliced inline rather than via fileUtils' `shortId`: this module is pure and reached by suites that partially mock that barrel, so borrowing a name from it breaks them on a missing export.
  const id = String(app?.id ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 8);
  return [name, id].filter(Boolean).join('-') || 'app';
}

/** True for the directory naming convention exclusively owned by CoS agents. */
export function isAgentWorktreeId(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('agent-');
}

/**
 * The live-agent sentinel every destructive caller reads the same way: a `Set` (INCLUDING an empty one, "nobody is running") is authoritative and passes through; anything else, `null` and `undefined`
 * included, is UNKNOWN liveness and returns `null`. Never coerce unknown to `new Set()`: an empty Set lets `agent-*` trees be removed (#12990: a checkout in its dispatch-registration window was exposed).
 *
 * @param {*} value
 * @returns {Set<string>|null}
 */
export function knownAgentIds(value) {
  return value instanceof Set ? value : null;
}

function normalizedRoots(roots) {
  return (Array.isArray(roots) ? roots : [])
    .filter((root) => typeof root?.path === 'string' && root.path);
}

/**
 * Why PortOS must leave a worktree alone, or null when this caller may handle it.
 *
 * `roots` is an explicit allowlist; a root may opt into arbitrary directory names with `{ path, requireAgentId: false }` (how the merged-tree reaper includes `.claude/worktrees/` without weakening the
 * CoS-agent root). `requireKnownLiveness` fails closed for `agent-*` trees when an authoritative `Set` of live agents is unavailable.
 *
 * ORDER IS THE POLICY: cheapest-and-most-absolute first, and the human-claim test LAST, since a claim hold is the one with caller-specific exceptions (`allowStaleClaim`, `allowLiveClaim`) and anything that
 * outranks it (an explicit `git worktree lock`, a running agent, undetermined liveness) must already have returned, so "a lock outranks a claim" is a fact of this function.
 *
 * @param {{
 *   path?: string,
 *   locked?: boolean,
 *   activeAgentIds?: Set<string>,
 *   roots?: Array<{path:string, requireAgentId?:boolean}>,
 *   requireAgentId?: boolean,
 *   allowStaleClaim?: boolean,
 *   allowLiveClaim?: boolean,
 *   ageMs?: number|null,
 *   staleClaimIdleMs?: number,
 *   unmanagedIdleMs?: number,
 *   requireKnownLiveness?: boolean,
 * }} options
 *   `unmanagedIdleMs` is the one way past the location gate: a tree outside every configured root is admitted (to the remaining gates, not past them) once its `ageMs` reaches the window.
 *   Off by default: a checkout a live run just cut from the default branch looks "merged and clean" (#10270). Name a window only with an INDEPENDENT proof the tree is unwanted (the superseded
 *   reap has one: a verdict against the tip and dirty paths plus a backup); the idle floor covers what that proof can't see, a process still standing in it.
 * @returns {string|null}
 */
export function worktreeOwnershipReason({
  path,
  locked = false,
  activeAgentIds,
  roots = [],
  requireAgentId = false,
  allowStaleClaim = false,
  allowLiveClaim = false,
  ageMs = null,
  staleClaimIdleMs,
  unmanagedIdleMs,
  requireKnownLiveness = false,
} = {}) {
  if (!path) return 'worktree-missing-path';

  const configuredRoots = normalizedRoots(roots);
  const root = configuredRoots.find((candidate) => isPathInsideDir(candidate.path, path));
  if (configuredRoots.length > 0 && !root && !unmanagedTreeIdle(ageMs, unmanagedIdleMs)) return 'worktree-unmanaged-location';

  const agentId = worktreeAgentId(path);
  const mustBeAgentWorktree = root?.requireAgentId ?? requireAgentId;
  // A claim-shaped id inside an agent-only root would fail here before the human-claim check, though it is the shape `allowLiveClaim` exists to admit; let it through to that check.
  if (mustBeAgentWorktree && !isAgentWorktreeId(agentId) && !(allowLiveClaim && isHumanClaimWorktree(agentId))) {
    return 'worktree-missing-agent-id';
  }
  if (locked) return 'worktree-locked';
  const liveIds = knownAgentIds(activeAgentIds);
  if (liveIds?.has(agentId)) return 'worktree-active-agent';
  if (requireKnownLiveness && isAgentWorktreeId(agentId) && !liveIds) {
    return 'worktree-agent-liveness-unknown';
  }

  // Last, so every unconditional hold already had its say. Two callers opt out of the claim hold: reapers reclaiming an ABANDONED claim once its window lapses (`allowStaleClaim` + `ageMs`),
  // and the dispatch side, which treats a `claim-*` directory as a marker (`allowLiveClaim`) once the classifier proved the tree clean.
  if (isHumanClaimWorktree(agentId) && !allowLiveClaim) {
    const stale = allowStaleClaim
      && typeof ageMs === 'number'
      && typeof staleClaimIdleMs === 'number'
      && ageMs >= staleClaimIdleMs;
    if (!stale) return 'worktree-human-claim';
  }
  return null;
}

/**
 * When a hold reported by `worktreeOwnershipReason` lifts on its OWN, as an ISO instant, or null when only an outside change can clear it. Lives next to the gate because the stale-claim window
 * (`ageMs >= staleClaimIdleMs`) is the one clock-keyed hold; a lock, a live agent and unknown liveness end at times nothing here can predict. Because the claim is tested LAST, `worktree-human-claim`
 * means every other hold already cleared, so with `allowStaleClaim` and a finite age the window is the whole remaining wait. Pure; same options as `worktreeOwnershipReason`.
 * @param {object} [options] - plus `nowMs` for the clock
 * @returns {string|null} ISO timestamp
 */
export function worktreeHoldExpiresAt({ nowMs = Date.now(), ...options } = {}) {
  const { ageMs, staleClaimIdleMs, unmanagedIdleMs, allowStaleClaim = false } = options;
  const reason = worktreeOwnershipReason(options);
  // The location hold lapses only for a caller that named an idle window (the gate already admitted a tree past it, so this is a future date).
  if (reason === 'worktree-unmanaged-location') {
    if (!Number.isFinite(ageMs) || !Number.isFinite(unmanagedIdleMs)) return null;
    // Dated only when the window is the LAST thing holding the tree: a lock or live agent behind the location gate lifts on a decision, not a clock.
    if (worktreeOwnershipReason({ ...options, ageMs: unmanagedIdleMs }) !== null) return null;
    return new Date(nowMs + (unmanagedIdleMs - ageMs)).toISOString();
  }
  if (reason !== 'worktree-human-claim') return null;
  // Without this caller's opt-in the window never lapses, so there is no date to report.
  if (!allowStaleClaim) return null;
  if (!Number.isFinite(ageMs) || !Number.isFinite(staleClaimIdleMs)) return null;
  return new Date(nowMs + (staleClaimIdleMs - ageMs)).toISOString();
}

/** True once a tree outside the managed roots has sat idle for the caller's window. */
function unmanagedTreeIdle(ageMs, unmanagedIdleMs) {
  return Number.isFinite(ageMs) && Number.isFinite(unmanagedIdleMs) && ageMs >= unmanagedIdleMs;
}
