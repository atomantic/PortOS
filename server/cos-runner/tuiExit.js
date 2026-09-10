/** Finish a runner TUI on observed process exit, even after force-kill reaping. */
// `tui:output` is live telemetry, so an immediate process exit can beat its
// socket delivery. Keep a small terminal tail with the exit event: the PortOS
// spawner owns failure analysis and can persist it when no ordinary TUI chunk
// arrived. This is deliberately much smaller than the runner's 512 KiB live
// buffer and is enough to carry a CLI's startup diagnostic.
const TUI_EXIT_OUTPUT_TAIL_CHARS = 16 * 1024;

export function createTuiExitHandler({ agentId, taskId, sessionId, agent, activeAgents, io, emitToServer, withState }) {
  return async ({ exitCode, signal }) => {
    try {
      // The force-kill timer removes the registry entry before node-pty emits
      // onExit. Keep the original handle so that exit still releases the server
      // session and the worktree. An actual exit, not a kill request, owns this.
      const current = agent;
      if (current.exited) return;
      current.exited = true;
      // Drop the handle before the awaited state write so GET /agents cannot
      // publish processActive:false for a TUI whose completion event is still
      // in flight (completeAgent keeps the first terminal verdict).
      activeAgents.delete(agentId);
      current.doneWatcher?.();
      // Cancel any pending SIGKILL timer — process already exited.
      if (current.killTimer) {
        clearTimeout(current.killTimer);
        current.killTimer = null;
      }
      const duration = Date.now() - current.startedAt;
      const success = current.completedBySentinel;
      const effectiveExitCode = success ? 0 : exitCode;
      const effectiveSignal = success ? 0 : signal;
      const outputTail = current.outputBuffer.slice(-TUI_EXIT_OUTPUT_TAIL_CHARS);
      io.emit('tui:exit', {
        sessionId,
        agentId,
        exitCode: effectiveExitCode,
        signal: effectiveSignal,
        ...(outputTail ? { outputTail } : {}),
      });
      // A pause still needs the transport exit: the server consumes it to
      // release its process map and unblock worktree adoption. Preserve the
      // durable paused record and omit the task-completion verdict.
      if (current.paused === true) return;
      emitToServer('agent:completed', {
        agentId,
        taskId,
        exitCode: effectiveExitCode,
        success,
        duration,
        outputLength: current.outputBuffer.length,
        completionReason: current.completedBySentinel ? 'agent-signaled-done' : 'tui-exit',
      });
      await withState((state) => {
        state.stats.completed++;
        if (!success) state.stats.failed++;
        delete state.agents[agentId];
      });
    } catch (err) {
      console.error(`❌ TUI agent ${agentId} exit handler error: ${err.message}`);
      activeAgents.delete(agentId);
    }
  };
}
