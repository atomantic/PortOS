import { checkProcessRunning as defaultCheckProcessRunning } from './processStats.js';

export function createOrphanCleanup({ io, securityScans, withState }, deps) {
  const checkProcessRunning = deps.checkProcessRunning ?? defaultCheckProcessRunning;

  /**
   * Cleanup orphaned agents on startup
   * Checks if PIDs from state are still running
   * Emits a batch completion event for dead agents so main server can retry tasks
   */
  return async function cleanupOrphanedAgents() {
    const orphaned = [];
    // Recovery can overlap a signal and finalizers. Keep its entire read/check/
    // write in the same queue so an old snapshot cannot resurrect completed runs.
    await withState(async (state) => {
      for (const [agentId, agentInfo] of Object.entries(state.agents)) {
        if (agentInfo.securityScanGrant) await securityScans.recover(agentId);
        const isRunning = await checkProcessRunning(agentInfo.pid);
        if (!isRunning) {
          orphaned.push({ agentId, taskId: agentInfo.taskId });
          delete state.agents[agentId];
        }
      }
    });

    if (orphaned.length > 0) {
      console.log(`🧹 Cleaned up ${orphaned.length} orphaned agents from state`);

      // Emit a single batch event with all orphaned agents
      // This avoids log spam when many agents were orphaned
      io.emit('agents:orphaned', {
        agents: orphaned.map(o => ({
          agentId: o.agentId,
          taskId: o.taskId,
          exitCode: -1,
          success: false,
          orphaned: true,
          error: 'Agent process died (runner restart detected dead PID)',
        })),
        count: orphaned.length,
      });
      console.log(`📡 Emitted agents:orphaned (${orphaned.length} agents)`);
    }

    return orphaned;
  };
}
