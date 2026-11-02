import { resolve } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';

export const REPO_REPAIR_TASK_DESCRIPTION = 'Restore the PortOS checkout to a clean default branch so automatic updates can run';

export function isUpdateRepoRepairTask(task) {
  // The exact legacy producer shape remains valid for retained repair attempts.
  return task?.taskType === 'internal' && task.description === REPO_REPAIR_TASK_DESCRIPTION
    && task.metadata?.app === PORTOS_APP_ID
    && [false, 'false'].includes(task.metadata.useWorktree);
}

/** Validate the requested checkout result, without moving Git or starting an update. */
export async function verifyUpdateRepoRepairCompletion(task, agentId, workspacePath) {
  if (!isUpdateRepoRepairTask(task) || !agentId || !workspacePath || resolve(workspacePath) !== resolve(PATHS.root)) return false;
  const contract = task.metadata.repoRepair;
  if (contract !== undefined && (contract?.version !== 1 || contract.repoPath !== PATHS.root)) return false;
  const [{ getTaskById }, { getAgentRecord }, { getInstanceId }, { checkUpdateRepoReadiness }] = await Promise.all([
    import('./cosTaskStore.js'), import('./cosAgentLifecycle.js'),
    import('./instanceIdentity.js'), import('./updateRepoReadiness.js'),
  ]);
  const [live, owner, instanceId] = await Promise.all([getTaskById(task.id), getAgentRecord(agentId), getInstanceId()]);
  if (!live || live.status !== 'in_progress' || !isUpdateRepoRepairTask(live)
    || !isDeepStrictEqual(task.metadata.repoRepair, live.metadata.repoRepair)
    || owner?.id !== agentId || owner.taskId !== task.id
    || owner.metadata?.instanceId !== instanceId || live.metadata.claimedBy !== instanceId
    || !owner.metadata.workspacePath || resolve(owner.metadata.workspacePath) !== resolve(PATHS.root)
    || !matchesCompletionTaskDispatch(owner, live) || !matchesCompletionTaskDispatch(owner, task)) return false;
  const verdict = await checkUpdateRepoReadiness({ repoPath: PATHS.root, excludeAgentId: agentId });
  if (!verdict.ready) return false;
  // Inspection awaits Git and the registry; do not reuse evidence for a changed dispatch.
  return isDeepStrictEqual(await getTaskById(task.id), live)
    && isDeepStrictEqual(await getAgentRecord(agentId), owner);
}
