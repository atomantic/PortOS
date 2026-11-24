/**
 * Task Conflict Detection Service
 *
 * Decides whether a new task must leave the shared checkout. Occupancy is the
 * only signal: any running agent in the same git workspace forces a worktree,
 * because concurrent edits in one checkout are unpredictable whether or not
 * the checkout is dirty or the task prose overlaps.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';

async function isGitRepo(workspacePath) {
  if (!existsSync(join(workspacePath, '.git'))) return false;
  const { stdout } = await execGit(
    ['rev-parse', '--is-inside-work-tree'],
    workspacePath
  ).catch(() => ({ stdout: 'false' }));
  return stdout.trim() === 'true';
}

/**
 * Returns { hasConflict, reason, conflictingAgents, recommendation } where
 * recommendation is 'worktree' (same-workspace agent running in a git
 * checkout), 'proceed' (nobody else in the workspace) or 'skip' (occupied but
 * not a git checkout, so no worktree is possible).
 */
export async function detectConflicts(_task, workspacePath, activeAgentsList) {
  const sameWorkspaceAgents = activeAgentsList.filter(agent => {
    const agentWorkspace = agent.metadata?.workspacePath || agent.workspacePath;
    return agentWorkspace === workspacePath;
  });

  if (sameWorkspaceAgents.length === 0) {
    return {
      hasConflict: false,
      reason: 'no-active-agents-in-workspace',
      conflictingAgents: [],
      recommendation: 'proceed'
    };
  }

  // Only qualified now: git probing is wasted work when nobody occupies the checkout.
  if (!(await isGitRepo(workspacePath).catch(() => false))) {
    return {
      hasConflict: false,
      reason: 'not-a-git-repo',
      conflictingAgents: [],
      recommendation: 'skip'
    };
  }

  return {
    hasConflict: true,
    reason: 'concurrent-agents-in-same-workspace',
    conflictingAgents: sameWorkspaceAgents.map(a => a.id),
    recommendation: 'worktree'
  };
}
