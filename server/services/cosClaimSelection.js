/** Pre-claim picker evidence. Recording a candidate grants no branch authority. */
import { resolve } from 'node:path';
import { expandHome } from '../lib/fileUtils.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b);

/** Validate persisted selection against the server's current task, app and instance. */
export function claimSelectionIssues(agent, task, { repoPath, tracker, target, instanceId }) {
  const selection = agent.metadata?.claimSelection;
  if (selection?.version !== 1 || selection.agentId !== agent.id || selection.taskId !== task.id
    || selection.startedAt !== agent.startedAt || !Number.isFinite(Date.parse(agent.startedAt))
    || !instanceId || instanceId === 'unknown' || selection.instanceId !== instanceId
    || agent.metadata?.instanceId !== instanceId || !samePath(selection.repoPath, repoPath)
    || !samePath(agent.metadata?.workspacePath, repoPath)
    || selection.tracker !== tracker || selection.repository !== `${target.webHost}/${target.fullName}`
    || !Number.isFinite(Date.parse(selection.recordedAt)) || !Array.isArray(selection.issues)
    || !selection.issues.length || selection.issues.length > 50
    || !selection.issues.every(number => Number.isSafeInteger(number) && number > 0)) return null;
  return [...new Set(selection.issues)];
}

export async function recordClaimSelection({ agentId, issueNumber }) {
  const { withStateLock, loadState, saveState } = await import('./cosState.js');
  return withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents?.[agentId];
    const refuse = reason => ({ recorded: false, reason });
    if (!agent || agent.id !== agentId || agent.status !== 'running'
      || agent.metadata?.configClaimFlow !== true || agent.metadata?.claimPicksOwnBranch !== true
      || agent.metadata?.isWorktree !== false) return refuse('picker-run-unverified');
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return refuse('issue-number-invalid');
    // Existing claims must be delivered independently; selection cannot replace them.
    if (['claimBranches', 'claimReleasedBranches', 'checkoutSeeds'].some(key =>
      agent.metadata[key] != null && (!Array.isArray(agent.metadata[key]) || agent.metadata[key].length))) {
      return refuse('picker-already-claimed');
    }
    const [{ getTaskById }, { getAppDataForTask }, { resolveAppForgeTarget }, { getInstanceId }] = await Promise.all([
      import('./cosTaskStore.js'), import('./agentAppWorkspace.js'), import('../lib/workTracker.js'), import('./instanceIdentity.js'),
    ]);
    const task = await getTaskById(agent.taskId);
    if (task?.id !== agent.taskId || !hasClaimFlowContract(task) || task.metadata?.claimTarget) return refuse('task-binding-unverified');
    const app = await getAppDataForTask(task);
    const source = agent.metadata.sourceWorkspace || agent.metadata.workspacePath;
    if (!app?.repoPath || !samePath(expandHome(app.repoPath), source)
      || !samePath(agent.metadata.workspacePath, source)) return refuse('repository-binding-unverified');
    const { tracker, target } = await resolveAppForgeTarget(app);
    if (!['github', 'gitlab'].includes(tracker) || target?.forge !== tracker
      || !target.webHost || !target.fullName?.includes('/')) return refuse('tracker-unsupported');
    const instanceId = await getInstanceId();
    if (!instanceId || instanceId === 'unknown' || agent.metadata.instanceId !== instanceId
      || !Number.isFinite(Date.parse(agent.startedAt))) return refuse('instance-binding-unverified');
    const context = { repoPath: source, tracker, target, instanceId };
    const prior = agent.metadata.claimSelection == null ? [] : claimSelectionIssues(agent, task, context);
    if (!prior) return refuse('selection-binding-unverified');
    const issues = [...new Set([...prior, issueNumber])];
    if (issues.length > 50) return refuse('selection-limit');
    const selection = { version: 1, agentId, taskId: task.id, startedAt: agent.startedAt,
      instanceId, repoPath: source, tracker, repository: `${target.webHost}/${target.fullName}`,
      issues, recordedAt: new Date().toISOString() };
    const updated = { ...agent, metadata: { ...agent.metadata, claimSelection: selection } };
    await saveState({ ...state, agents: { ...state.agents, [agentId]: updated } });
    const { cosEvents } = await import('./cosEvents.js');
    cosEvents.emit('agent:updated', updated);
    return { recorded: true, issues };
  });
}
