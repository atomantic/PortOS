/**
 * Agent Workspace Preparation
 *
 * Resolves the working directory an agent runs in and provisions any
 * isolation it needs before the agent is registered/spawned. Extracted from
 * `spawnAgentForTask` in agentLifecycle.js so that orchestrator stays
 * readable — this owns: workspace-path resolution, the pre-task git pull
 * (with conflict deferral), optional JIRA ticket + feature branch creation,
 * persistent feature-agent worktrees, and explicit/auto-detected worktree
 * creation.
 *
 * Side effects that don't touch spawn-local state (creating a conflict task,
 * flipping the task to pending/blocked, creating worktrees, mutating
 * `task.metadata` with JIRA fields) happen inline. Outcomes that the caller
 * must finish are returned as a discriminated result so the caller can fire
 * `cleanupOnError` + the matching `agent:deferred` / `agent:error` event:
 *
 *   { outcome: 'ready', workspacePath, resolvedAppName, worktreeInfo, jiraTicket, jiraBranchName, explicitWorktree }
 *   { outcome: 'deferred', reason, deferReason, branch }   // git conflict — task re-queued
 *   { outcome: 'blocked', reason }                          // explicit worktree requested but creation failed
 *
 * An unexpected throw bubbles to the caller's widened try/catch the same way
 * the inline code did.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { execGit } from '../lib/execGit.js';
import { emitLog } from './cosEvents.js';
import { updateTask, addTask } from './cos.js';
import { getAppById } from './apps.js';
import { isTruthyMeta, isFalsyMeta } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import * as git from './git.js';
import { detectConflicts } from './taskConflict.js';
import { createWorktree } from './worktreeManager.js';
import { getAppWorkspace, getAppDataForTask, createJiraTicketForTask } from './agentPromptBuilder.js';

const ROOT_DIR = PATHS.root;

/**
 * Prepare the workspace (and any worktree/JIRA branch) for an agent task.
 *
 * @param {{ agentId: string, task: object }} params
 * @returns {Promise<object>} discriminated outcome (see module doc)
 */
export async function prepareAgentWorkspace({ agentId, task }) {
  // Determine workspace path and resolve app name
  const isReadOnly = isTruthyMeta(task.metadata?.readOnly);
  let workspacePath = task.metadata?.app
    ? await getAppWorkspace(task.metadata.app)
    : ROOT_DIR;
  const resolvedAppName = task.metadata?.app
    ? (await getAppById(task.metadata.app).catch(() => null))?.name || null
    : null;

  let jiraTicket = null;
  let jiraBranchName = null;
  let worktreeInfo = null;
  const explicitOpenPR = isTruthyMeta(task.metadata?.openPR);
  const explicitWorktree = isTruthyMeta(task.metadata?.useWorktree) || explicitOpenPR;

  if (!isReadOnly) {
    // Pull latest from git before starting work
    const pullResult = await git.ensureLatest(workspacePath).catch(err => {
      emitLog('warn', `⚠️ Pre-task git pull failed for ${workspacePath}: ${err.message}`, { taskId: task.id, workspace: workspacePath });
      return { success: false, error: err.message };
    });

    if (pullResult.skipped) {
      emitLog('debug', `Pre-task git pull skipped: ${pullResult.skipped}`, { taskId: task.id, workspace: workspacePath });
    } else if (pullResult.conflict) {
      emitLog('warn', `🔀 Git conflict in ${workspacePath} (branch: ${pullResult.branch}): ${pullResult.error}`, {
        taskId: task.id, workspace: workspacePath, branch: pullResult.branch
      });

      const appId = task.metadata?.app || null;
      const conflictDesc = `Resolve git conflict in ${resolvedAppName || workspacePath} on branch ${pullResult.branch}. `
        + `The branch has diverged from origin and automatic rebase failed. `
        + `Error: ${pullResult.error}`;

      await addTask({
        description: conflictDesc,
        priority: 'HIGH',
        app: appId,
        context: `This conflict is blocking task ${task.id}: "${task.description}". `
          + `Resolve the conflict, commit, and push so the blocked task can proceed.`,
        position: 'top'
      }, 'internal').catch(err => {
        emitLog('warn', `Failed to create conflict resolution task: ${err.message}`, { taskId: task.id });
      });

      await updateTask(task.id, { status: 'pending' }, task.taskType || 'user').catch(() => {});
      return {
        outcome: 'deferred',
        reason: 'Git conflict blocks task — conflict resolution task created',
        deferReason: 'git-conflict',
        branch: pullResult.branch
      };
    } else if (pullResult.success && !pullResult.upToDate && !pullResult.skipped) {
      emitLog('info', `📥 Pulled latest for ${resolvedAppName || 'workspace'} (branch: ${pullResult.branch})`, {
        taskId: task.id, workspace: workspacePath, branch: pullResult.branch
      });
    } else if (!pullResult.success) {
      emitLog('warn', `⚠️ Pre-task git pull error: ${pullResult.error}`, { taskId: task.id, workspace: workspacePath });
    }

    // JIRA integration: create ticket + feature branch if app has JIRA enabled and task opted in
    const appData = await getAppDataForTask(task);

    if (appData?.jira?.enabled && task.metadata?.createJiraTicket) {
      jiraTicket = await createJiraTicketForTask(task, appData);

      if (jiraTicket) {
        const slug = (task.description || 'task')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 40);
        jiraBranchName = `feature/${jiraTicket.ticketId}-${slug}`;

        if (task.metadata?.app) {
          await git.fetchOrigin(workspacePath).catch(() => {});
          const { baseBranch: defaultBranch } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
          if (defaultBranch) {
            await git.checkout(workspacePath, defaultBranch).catch(() => {});
            await execGit(['merge', '--ff-only', `origin/${defaultBranch}`], workspacePath).catch(err => { emitLog('warn', `Fast-forward merge of ${defaultBranch} failed: ${err.message}`, { taskId: task.id }); });
          }
        }

        await git.createBranch(workspacePath, jiraBranchName).catch(err => {
          emitLog('warn', `Failed to create JIRA branch ${jiraBranchName}: ${err.message}`, { taskId: task.id });
          jiraBranchName = null;
        });

        if (jiraBranchName) {
          emitLog('success', `Created feature branch ${jiraBranchName}`, { taskId: task.id, ticketId: jiraTicket.ticketId });
        }

        task.metadata = {
          ...task.metadata,
          jiraTicketId: jiraTicket.ticketId,
          jiraTicketUrl: jiraTicket.ticketUrl,
          jiraBranch: jiraBranchName,
          jiraInstanceId: appData.jira.instanceId,
          jiraCreatePR: appData.jira.createPR !== false
        };
      }
    }

    // Feature agent tasks: use persistent worktree instead of creating a new one
    if (task.metadata?.featureAgentRun && task.metadata?.featureAgentId) {
      const { getFeatureAgent } = await import('./featureAgents.js');
      const fa = await getFeatureAgent(task.metadata.featureAgentId).catch(() => null);
      if (fa) {
        const faWorktreePath = join(PATHS.cos, 'feature-agents', fa.id, 'worktree');
        if (existsSync(faWorktreePath)) {
          workspacePath = faWorktreePath;
          worktreeInfo = {
            worktreePath: faWorktreePath,
            branchName: fa.git.branchName,
            baseBranch: fa.git.baseBranch || 'main',
            isPersistentWorktree: true
          };
          const { mergeBaseIntoFeatureWorktree } = await import('./worktreeManager.js');
          if (fa.git.autoMergeBase) {
            await mergeBaseIntoFeatureWorktree(fa.id, fa.git.baseBranch).catch(err => {
              emitLog('warn', `🌳 Feature agent base merge failed: ${err.message}`, { featureAgentId: fa.id });
            });
          }
          emitLog('info', `🌳 Feature agent ${fa.name} using persistent worktree: ${fa.git.branchName}`, {
            featureAgentId: fa.id, worktreePath: faWorktreePath
          });
        }
      }
    }

    if (explicitWorktree && !jiraBranchName) {
      const existingBranch = task.metadata?.existingBranch || null;
      const { baseBranch: detectedBase } = await git.getRepoBranches(workspacePath).catch(() => ({ baseBranch: null }));
      if (existingBranch) {
        emitLog('info', `🌳 Worktree requested for task ${task.id} on existing branch ${existingBranch}`, {
          taskId: task.id, app: task.metadata?.app, branch: existingBranch
        });
      } else {
        emitLog('info', `🌳 Worktree requested for task ${task.id} — creating isolated worktree from ${detectedBase || 'default branch'}`, {
          taskId: task.id, app: task.metadata?.app, baseBranch: detectedBase
        });
      }

      worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
        baseBranch: detectedBase || undefined,
        existingBranch: existingBranch || undefined,
        planId: task.metadata?.planId || undefined
      }).catch(err => {
        emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
        return null;
      });

      if (worktreeInfo) {
        workspacePath = worktreeInfo.worktreePath;
        emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName} (base: ${worktreeInfo.baseBranch})`, {
          agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName, baseBranch: worktreeInfo.baseBranch
        });
      } else {
        // Isolation was EXPLICITLY requested (useWorktree/openPR) but the
        // worktree couldn't be created. Falling back to the shared workspace
        // would run the agent against the live checkout and — with openPR —
        // auto-commit to the current branch, exactly the isolation the
        // caller opted into. Fail closed: block the task rather than touch
        // the working tree behind the user's back. (The auto-detected
        // conflict branch below keeps its lenient shared-workspace fallback,
        // since there the worktree was only a recommendation, not a request.)
        const reason = `Worktree creation failed for task ${task.id}; refusing to run in the shared workspace because isolation was explicitly requested`;
        emitLog('warn', `🌳 ${reason}`, { taskId: task.id });
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: 'Worktree creation failed — isolation was explicitly requested',
            blockedCategory: 'worktree-failed',
            blockedAt: new Date().toISOString(),
          },
        }, task.taskType || 'user').catch(() => {});
        return { outcome: 'blocked', reason };
      }
    } else if (!jiraBranchName && !isFalsyMeta(task.metadata?.useWorktree)) {
      const { getAgents } = await import('./cos.js');
      const allAgents = await getAgents();
      const runningAgents = allAgents.filter(a => a.status === 'running');

      const conflictResult = await detectConflicts(task, workspacePath, runningAgents).catch(err => {
        emitLog('warn', `Conflict detection failed: ${err.message}`, { taskId: task.id });
        return { hasConflict: false, recommendation: 'proceed' };
      });

      if (conflictResult.recommendation === 'worktree') {
        emitLog('info', `🌳 Conflict detected for task ${task.id}: ${conflictResult.reason} — creating worktree`, {
          taskId: task.id,
          conflictingAgents: conflictResult.conflictingAgents,
          reason: conflictResult.reason
        });

        worktreeInfo = await createWorktree(agentId, workspacePath, task.id, {
          planId: task.metadata?.planId || undefined
        }).catch(err => {
          emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
          return null;
        });

        if (worktreeInfo) {
          workspacePath = worktreeInfo.worktreePath;
          emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName}`, {
            agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName
          });
        }
      } else if (conflictResult.recommendation === 'proceed') {
        emitLog('debug', `No conflicts for task ${task.id}, using shared workspace`, { taskId: task.id });
      }
    }
  } // end !isReadOnly

  return {
    outcome: 'ready',
    workspacePath,
    resolvedAppName,
    worktreeInfo,
    jiraTicket,
    jiraBranchName,
    explicitWorktree
  };
}
