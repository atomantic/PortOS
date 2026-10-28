/** Recovery needs supervised whole-tree proof, not an absent parent PID. */
export async function readReleaseCandidateSettlement(agent) {
  const [{ getActiveAgentIds }, { listAllSessions }] = await Promise.all([
    import('./agentState.js'), import('./shell.js'),
  ]);
  if (getActiveAgentIds().includes(agent.id) || listAllSessions().some(row => row.agentId === agent.id)) {
    throw new Error('candidate-processes-active');
  }
  if (agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true') {
    const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
    const running = await getActiveAgentsFromRunner();
    if (!Array.isArray(running) || running.some(row => !row || typeof row.id !== 'string' || row.id === agent.id)) {
      throw new Error('candidate-runner-unsettled');
    }
  }
  // POSIX currently has no durable, supervised descendant receipt. Neither
  // lsof of the checkout nor kill(pid, 0) can exclude detached descendants.
  if (process.platform !== 'win32') throw new Error('candidate-process-proof-unavailable');
  const { readWindowsAgentSettlement } = await import('../lib/windowsAgentProcess.js');
  return readWindowsAgentSettlement(agent).catch(() => { throw new Error('candidate-process-proof-unavailable'); });
}
