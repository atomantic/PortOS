/**
 * Worktree ownership — the one policy for whether PortOS may move or remove a
 * worktree.
 *
 * Worktree operations are destructive: adoption moves a directory and reapers
 * remove one. The callers therefore share this pure gate instead of carrying
 * slightly different copies of "managed root, agent id, claim, liveness, lock".
 * Callers can explicitly opt into the differences that are intentional: a
 * reaper may include `.claude/worktrees/`, and stale claims may be reclaimed
 * only by branch reconciliation.
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
 * @param {{
 *   path?: string,
 *   locked?: boolean,
 *   activeAgentIds?: Set<string>,
 *   roots?: Array<{path:string, requireAgentId?:boolean}>,
 *   requireAgentId?: boolean,
 *   allowStaleClaim?: boolean,
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
  ageMs = null,
  staleClaimIdleMs,
  requireKnownLiveness = false,
} = {}) {
  if (!path) return 'worktree-missing-path';

  const configuredRoots = normalizedRoots(roots);
  const root = configuredRoots.find((candidate) => isPathInsideDir(candidate.path, path));
  if (configuredRoots.length > 0 && !root) return 'worktree-unmanaged-location';

  const agentId = worktreeAgentId(path);
  if (isHumanClaimWorktree(agentId)) {
    const stale = allowStaleClaim
      && typeof ageMs === 'number'
      && typeof staleClaimIdleMs === 'number'
      && ageMs >= staleClaimIdleMs;
    if (!stale) return 'worktree-human-claim';
  }

  const mustBeAgentWorktree = root?.requireAgentId ?? requireAgentId;
  if (mustBeAgentWorktree && !isAgentWorktreeId(agentId)) return 'worktree-missing-agent-id';
  if (locked) return 'worktree-locked';
  if (activeAgentIds instanceof Set && activeAgentIds.has(agentId)) return 'worktree-active-agent';
  if (requireKnownLiveness && isAgentWorktreeId(agentId) && !(activeAgentIds instanceof Set)) {
    return 'worktree-agent-liveness-unknown';
  }
  return null;
}
