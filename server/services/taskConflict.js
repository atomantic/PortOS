/**
 * Task Conflict Detection Service
 *
 * Analyzes whether a new task conflicts with active agents working in
 * the same workspace. When conflicts are detected, the spawner should
 * use a git worktree for isolation.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Execute a git command and return stdout
 */
function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `git exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
    child.on('error', reject);
  });
}

/**
 * Get list of files modified in the working tree (unstaged + staged + untracked)
 */
async function getModifiedFiles(workspacePath) {
  const stdout = await execGit(['status', '--porcelain'], workspacePath);
  return stdout.trim().split('\n')
    .filter(Boolean)
    .map(line => line.substring(3).trim());
}

/**
 * Check whether a workspace path is inside a git repository
 */
async function isGitRepo(workspacePath) {
  if (!existsSync(join(workspacePath, '.git'))) return false;
  const stdout = await execGit(
    ['rev-parse', '--is-inside-work-tree'],
    workspacePath
  ).catch(() => 'false');
  return stdout.trim() === 'true';
}

/**
 * Detect conflicts between a new task and currently active agents.
 *
 * Returns:
 *   { hasConflict, reason, conflictingAgents, recommendation }
 *
 * recommendation is one of:
 *   'worktree'  – use a git worktree for the new task
 *   'proceed'   – no conflict, run in the normal workspace
 *   'skip'      – task targets a non-git workspace, worktrees not possible
 */
export async function detectConflicts(task, workspacePath, activeAgentsList) {
  // If the workspace isn't a git repo, worktrees aren't an option
  const gitRepo = await isGitRepo(workspacePath).catch(() => false);
  if (!gitRepo) {
    return {
      hasConflict: false,
      reason: 'not-a-git-repo',
      conflictingAgents: [],
      recommendation: 'skip'
    };
  }

  // Find agents currently working in the same workspace
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

  // There are active agents in the same workspace – check for file-level overlap
  const modifiedFiles = await getModifiedFiles(workspacePath).catch(() => []);

  // If the workspace already has uncommitted changes (from another agent), conflict
  if (modifiedFiles.length > 0) {
    return {
      hasConflict: true,
      reason: 'workspace-has-uncommitted-changes',
      conflictingAgents: sameWorkspaceAgents.map(a => a.id),
      modifiedFiles,
      recommendation: 'worktree'
    };
  }

  // Even without uncommitted changes, concurrent agents in the same workspace
  // can step on each other. Use description heuristics for overlap.
  const taskDesc = (task.description || '').toLowerCase();
  const taskApp = task.metadata?.app;

  const overlappingAgents = sameWorkspaceAgents.filter(agent => {
    const agentDesc = (agent.metadata?.taskDescription || agent.taskDescription || '').toLowerCase();
    const agentApp = agent.metadata?.app || agent.app;

    // Same target app is a strong conflict signal
    if (taskApp && agentApp && taskApp === agentApp) return true;

    // Check for keyword overlap in descriptions (files, components, features)
    const taskKeywords = extractKeywords(taskDesc);
    const agentKeywords = extractKeywords(agentDesc);
    const overlap = taskKeywords.filter(k => agentKeywords.includes(k));
    return overlap.length >= 2;
  });

  if (overlappingAgents.length > 0) {
    return {
      hasConflict: true,
      reason: 'concurrent-agents-likely-overlap',
      conflictingAgents: overlappingAgents.map(a => a.id),
      recommendation: 'worktree'
    };
  }

  // Agents in same workspace but no obvious overlap – still use worktree
  // to be safe, since concurrent file edits are unpredictable
  return {
    hasConflict: true,
    reason: 'concurrent-agents-in-same-workspace',
    conflictingAgents: sameWorkspaceAgents.map(a => a.id),
    recommendation: 'worktree'
  };
}

/**
 * Extract meaningful keywords from a task description for overlap detection.
 * Filters out common stop words and short tokens.
 */
function extractKeywords(text) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'be', 'as',
    'are', 'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does',
    'not', 'no', 'can', 'will', 'should', 'may', 'task', 'fix', 'add',
    'update', 'change', 'make', 'use', 'new', 'all', 'any', 'each'
  ]);

  return text
    .replace(/[^a-z0-9\s-_/.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

export { extractKeywords, getModifiedFiles, isGitRepo };
