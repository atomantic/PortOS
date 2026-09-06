/**
 * Worktree ownership — the one policy for whether PortOS may move or remove a
 * worktree.
 *
 * Worktree operations are destructive: adoption moves a directory and reapers
 * remove one. The callers therefore share this pure gate instead of carrying
 * slightly different copies of "managed root, agent id, lock, liveness, claim".
 * That list is also the ORDER the gate applies them in, which is itself policy —
 * see `worktreeOwnershipReason` for why the claim comes last. Callers can
 * explicitly opt into the differences that are intentional: a reaper may
 * include `.claude/worktrees/`, stale claims may be reclaimed only by branch
 * reconciliation, and a live claim reads as unowned only for branch-reconcile's
 * dispatch side and a non-committing coordinator follow-up (review-loop,
 * PR-remediation) adopting the exact branch it exists to land — all three name
 * the branch, not merely the directory.
 */

import { win32 } from 'path';
import { isPathInsideDir } from './fileUtils.js';

/** Directory basename from either POSIX or Windows git worktree output. */
export function worktreeAgentId(worktreePath) {
  return win32.basename(worktreePath || '');
}

/** True for a worktree owned by the human `/claim` lifecycle. */
export function isHumanClaimWorktree(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('claim-');
}

/** True for the directory naming convention exclusively owned by CoS agents. */
export function isAgentWorktreeId(agentId) {
  return typeof agentId === 'string' && agentId.startsWith('agent-');
}

function normalizedRoots(roots) {
  return (Array.isArray(roots) ? roots : [])
    .filter((root) => typeof root?.path === 'string' && root.path);
}

/**
 * Why PortOS must leave a worktree alone, or null when this caller may handle it.
 *
 * `roots` is an explicit allowlist. Each root may opt into arbitrary directory
 * names with `{ path, requireAgentId: false }`, which is how the safe merged-tree
 * reaper can include `.claude/worktrees/` without weakening the CoS-agent root.
 * `requireKnownLiveness` fails closed for `agent-*` trees when an authoritative
 * `Set` of live agents is unavailable.
 *
 * ORDER IS THE POLICY. The checks run cheapest-and-most-absolute first, and the
 * human-claim test runs LAST on purpose: a claim hold is the one hold with
 * caller-specific exceptions (`allowStaleClaim`, `allowLiveClaim`), so anything
 * that outranks it — an explicit `git worktree lock`, a running agent, liveness
 * we could not determine — must already have returned by the time those
 * exceptions are consulted. That way "a lock outranks a claim" is a fact of this
 * function rather than something each caller re-derives from the returned slug.
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
 *   requireKnownLiveness?: boolean,
 * }} options
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
  requireKnownLiveness = false,
} = {}) {
  if (!path) return 'worktree-missing-path';

  const configuredRoots = normalizedRoots(roots);
  const root = configuredRoots.find((candidate) => isPathInsideDir(candidate.path, path));
  if (configuredRoots.length > 0 && !root) return 'worktree-unmanaged-location';

  const agentId = worktreeAgentId(path);
  const mustBeAgentWorktree = root?.requireAgentId ?? requireAgentId;
  // A claim-shaped id inside an agent-only root would otherwise fail here before
  // ever reaching the human-claim check below — which is exactly the id shape
  // `allowLiveClaim` exists to admit. Let it through to that check instead of
  // being turned away one gate early.
  if (mustBeAgentWorktree && !isAgentWorktreeId(agentId) && !(allowLiveClaim && isHumanClaimWorktree(agentId))) {
    return 'worktree-missing-agent-id';
  }
  if (locked) return 'worktree-locked';
  if (activeAgentIds instanceof Set && activeAgentIds.has(agentId)) return 'worktree-active-agent';
  if (requireKnownLiveness && isAgentWorktreeId(agentId) && !(activeAgentIds instanceof Set)) {
    return 'worktree-agent-liveness-unknown';
  }

  // Last, so every unconditional hold above already had its say. Two callers
  // opt out of the claim hold: reapers that may reclaim an ABANDONED claim once
  // its window lapses (`allowStaleClaim` + `ageMs`), and the dispatch side,
  // which treats a `claim-*` directory as a marker rather than a live process
  // (`allowLiveClaim`) once the classifier has proven the tree clean.
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
 * When a hold reported by `worktreeOwnershipReason` lifts on its OWN, as an ISO
 * instant — or null when only an outside change can clear it.
 *
 * Lives here, next to the gate, because the expiry is the same policy as the
 * hold: the stale-claim window (`ageMs >= staleClaimIdleMs`) is the one gate
 * keyed to a clock, so this is the only module that can name the deadline
 * without re-deriving it from a returned slug. A lock, a live agent, and
 * unknown liveness all end at times nothing here can predict.
 *
 * Because the gate tests the claim LAST, `worktree-human-claim` now means every
 * other hold already cleared — so the deadline needs no hypothetical re-ask:
 * with `allowStaleClaim` and a finite age, that slug is returned only while
 * `ageMs < staleClaimIdleMs`, and the window is the whole remaining wait.
 *
 * Pure. Takes the same options object as `worktreeOwnershipReason`.
 * @param {object} [options] - plus `nowMs` for the clock
 * @returns {string|null} ISO timestamp
 */
export function worktreeHoldExpiresAt({ nowMs = Date.now(), ...options } = {}) {
  const { ageMs, staleClaimIdleMs, allowStaleClaim = false } = options;
  // Without this caller's opt-in the window never lapses, so there is no date to
  // report even though the tree does read `worktree-human-claim`.
  if (!allowStaleClaim) return null;
  if (!Number.isFinite(ageMs) || !Number.isFinite(staleClaimIdleMs)) return null;
  if (worktreeOwnershipReason(options) !== 'worktree-human-claim') return null;
  return new Date(nowMs + (staleClaimIdleMs - ageMs)).toISOString();
}
