const TUI_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT']);

export function registerRunnerSockets({ io, activeAgents, lifecycle, armForceKill, killProcessTree }) {
  /**
   * Socket.IO connection handling
   */
  io.on('connection', (socket) => {
    if (lifecycle.isStopping()) { socket.disconnect(true); return; }
    socket.use((packet, next) => {
      if (!lifecycle.isStopping()) next();
    });
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('tui:input', ({ sessionId, data, promptSubmission }) => {
      try {
        const agent = [...activeAgents.values()].find(candidate => candidate.sessionId === sessionId);
        if (agent?.kind === 'tui' && !agent.startupInterrupted && typeof data === 'string') {
          agent.process.write(data);
          // The write and receipt are synchronous in the runner. A queued socket
          // write in the server is not evidence that the Enter reached the PTY.
          if (promptSubmission === true && data === '\r' && agent.promptSubmitted !== null) {
            agent.promptSubmitted = true;
          }
        }
      } catch (err) {
        console.error(`❌ TUI input relay failed: ${err.message}`);
      }
    });

    socket.on('tui:resize', ({ sessionId, cols, rows }) => {
      try {
        const agent = [...activeAgents.values()].find(candidate => candidate.sessionId === sessionId);
        if (agent?.kind !== 'tui') return;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
        agent.process.resize(cols, rows);
      } catch (err) {
        console.error(`❌ TUI resize relay failed: ${err.message}`);
      }
    });

    socket.on('tui:kill', async ({ sessionId, signal = 'SIGTERM' }) => {
      try {
        if (!TUI_SIGNALS.has(signal)) return;
        const entry = [...activeAgents.entries()].find(([, candidate]) => candidate.sessionId === sessionId);
        if (!entry) return;
        const [agentId, agent] = entry;
        if (agent.kind !== 'tui') return;
        await agent.stopSecurityScan?.();
        killProcessTree(agent.process, signal);
        // `dropState` only for an agent the server has already FINALIZED. A pause
        // also relays a kill (the server stops a TUI session through this socket),
        // and its durable record is exactly what a later resume reads — reaping it
        // would strand the paused run.
        armForceKill(agentId, agent, { dropState: agent.paused !== true });
      } catch (err) {
        console.error(`❌ TUI termination relay failed: ${err.message}`);
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });
}
