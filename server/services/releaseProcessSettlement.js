/** Fresh process settlement at the destructive boundary; a completion record
 * or an earlier sync inspection does not prove the process is still gone. */
export async function publisherProcessesSettled(entry, agents, path) {
  const owners = agents.filter(agent => agent.id === entry.owner.agentId || agent.taskId === entry.task.id);
  if (!owners.some(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)
    || owners.some(agent => agent.status !== 'completed' || !Number.isFinite(Date.parse(agent.completedAt))
      || Date.parse(agent.completedAt) < Date.parse(agent.startedAt) || Date.parse(agent.completedAt) > Date.now())) return false;
  const [{ getActiveAgentIds }, { listAllSessions }, { hasProcessCwdInside }] = await Promise.all([
    import('./agentState.js'), import('./shell.js'), import('../lib/processCwdProbe.js'),
  ]);
  const active = new Set(getActiveAgentIds());
  const sessions = listAllSessions();
  if (owners.some(agent => active.has(agent.id) || sessions.some(session => session.agentId === agent.id))) return false;
  if (owners.some(agent => agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true')) {
    const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
    const running = await getActiveAgentsFromRunner();
    if (!Array.isArray(running) || running.some(row => !row || typeof row.id !== 'string')
      || running.some(row => owners.some(agent => agent.id === row.id))) return false;
  }
  if (process.platform === 'win32') {
    const { readWindowsAgentSettlement } = await import('../lib/windowsAgentProcess.js');
    for (const owner of owners) await readWindowsAgentSettlement(owner);
    return true;
  } else for (const owner of owners.filter(agent => Number.isSafeInteger(agent.pid) && agent.pid > 0)) {
    try { process.kill(owner.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return !await hasProcessCwdInside(path);
}
