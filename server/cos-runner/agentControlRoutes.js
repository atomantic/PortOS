import { join } from 'path';
import { writeFile as defaultWriteFile, readFile as defaultReadFile } from 'fs/promises';
import { confirmWindowsProcessTreeExit } from '../lib/bufferedSpawn.js';
import { getProcessStats as defaultGetProcessStats } from './processStats.js';
import { usableAgentPid, runnerAgentLivenessFields } from '../lib/runnerAgentLiveness.js';
import { bodyErrorMessage, btwBodySchema, pauseBodySchema, terminateBodySchema } from './requestSchemas.js';

export function registerAgentControlRoutes(app, {
  activeAgents, emitToServer, armForceKill, proc, sigkillGraceMs,
  killProcessTree, withState,
}, deps) {
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const getProcessStats = deps.getProcessStats ?? defaultGetProcessStats;

  /**
   * Health check endpoint
   */
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      activeAgents: activeAgents.size,
      uptime: proc.uptime(),
    });
  });

  async function inspectAgentProcess(agent) {
    const pid = usableAgentPid(agent.pid);
    const stats = pid ? await getProcessStats(pid) : null;
    return { stats, ...runnerAgentLivenessFields(agent, stats) };
  }

  /**
   * Get list of active agents with process stats
   */
  app.get('/agents', async (req, res) => {
    const agents = [];
    for (const [agentId, agent] of activeAgents) {
      // onExit stamps exited then awaits disk I/O; skip so a dying handle is
      // not advertised as a stale listing that sweeps would reap before
      // agent:completed lands.
      if (agent.exited === true) continue;
      const inspected = await inspectAgentProcess(agent);
      agents.push({
        id: agentId,
        taskId: agent.taskId,
        pid: agent.pid,
        startedAt: agent.startedAt,
        runningTime: Date.now() - agent.startedAt,
        processActive: inspected.processActive,
        cpu: inspected.cpu,
        memoryMb: inspected.memoryMb,
        state: inspected.state,
        liveness: inspected.liveness,
        kind: agent.kind || 'cli',
        sessionId: agent.sessionId || null,
        command: agent.command || null,
        workspacePath: agent.workspacePath || null,
        securityScan: agent.securityScan || null,
        // null means an older caller did not opt into submission tracking.
        promptSubmitted: agent.promptSubmitted ?? null,
      });
    }
    res.json(agents);
  });

  /**
   * Get process stats for a specific agent
   */
  app.get('/agents/:agentId/stats', async (req, res) => {
    const { agentId } = req.params;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not running' });
    }

    const inspected = await inspectAgentProcess(agent);
    res.json({
      agentId,
      pid: agent.pid,
      active: inspected.processActive,
      cpu: inspected.cpu,
      memoryKb: inspected.stats?.memoryKb ?? 0,
      memoryMb: inspected.memoryMb,
      state: inspected.state,
      liveness: inspected.liveness,
    });
  });

  /**
   * Terminate an agent (graceful with SIGTERM, then SIGKILL after timeout)
   */
  app.post('/terminate/:agentId', async (req, res) => {
    const body = terminateBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: bodyErrorMessage(body.error) });
    const { agentId } = req.params;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not running' });
    }

    if (body.data.onlyIfPromptUnsubmitted === true) {
      if (agent.kind !== 'tui' || agent.promptSubmitted !== false) {
        return res.json({ success: true, agentId, terminated: false });
      }
      // Claim cancellation synchronously with the receipt check, before scanner
      // settlement yields. Late server writes must not start this canceled task.
      agent.startupInterrupted = true;
    }

    console.log(`🔪 Terminating agent ${agentId}`);
    await agent.stopSecurityScan?.();
    killProcessTree(agent.process, 'SIGTERM');
    armForceKill(agentId, agent);

    res.json({ success: true, agentId, terminated: true });
  });

  /**
   * Force kill an agent immediately with SIGKILL (no graceful shutdown)
   */
  app.post('/kill/:agentId', async (req, res) => {
    const { agentId } = req.params;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not running' });
    }

    console.log(`💀 Force killing agent ${agentId} (PID: ${agent.pid})`);
    await agent.stopSecurityScan?.();
    const treeExit = confirmWindowsProcessTreeExit(agent.process, proc.platform === 'win32');
    if (treeExit) await treeExit;
    else killProcessTree(agent.process, 'SIGKILL');

    // Clean up immediately
    activeAgents.delete(agentId);

    // Update state
    await withState((state) => {
      delete state.agents[agentId];
    });

    res.json({ success: true, agentId, pid: agent.pid, signal: 'SIGKILL' });
  });

  /**
   * Pause an agent: stop the child process without reporting normal completion.
   * PortOS server persists the paused agent/task state and preserves the
   * worktree; the runner just ensures the process stops spending tokens.
   */
  app.post('/pause/:agentId', async (req, res) => {
    const { agentId } = req.params;
    const body = pauseBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: bodyErrorMessage(body.error) });
    const { reason = null } = body.data;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not running' });
    }

    const pausedAt = new Date().toISOString();
    console.log(`⏸️ Pausing agent ${agentId} (PID: ${agent.pid})${reason ? `: ${reason}` : ''}`);

    agent.paused = true;
    agent.pausedAt = pausedAt;
    agent.pauseReason = reason;
    await agent.stopSecurityScan?.();
    killProcessTree(agent.process, 'SIGTERM');
    // NOT armForceKill: a pause keeps its map entry (the agent is meant to be
    // resumable) and only escalates while the pause is still in force.
    if (agent.killTimer) clearTimeout(agent.killTimer);
    agent.killTimer = setTimeout(() => {
      try {
        agent.killTimer = null;
        const current = activeAgents.get(agentId);
        if (current?.paused) killProcessTree(current.process, 'SIGKILL');
      } catch (err) {
        console.error(`❌ Pause force kill failed for ${agentId}: ${err?.message || err}`);
      }
    }, sigkillGraceMs);

    res.json({ success: true, agentId, pid: agent.pid, pausedAt });
  });

  /**
   * Kill all agents
   */
  app.post('/terminate-all', async (req, res) => {
    const agentIds = Array.from(activeAgents.keys());

    // Per-agent SIGKILL fallback timers. Each agent gets its OWN timer (stored
    // as agent.killTimer so its close handler can cancel it on clean exit). A
    // single shared timer would be cleared by the FIRST agent to exit, leaving
    // any agent that ignores SIGTERM running with no force-kill escalation.
    for (const agentId of agentIds) {
      const agent = activeAgents.get(agentId);
      if (agent) {
        await agent.stopSecurityScan?.();
        killProcessTree(agent.process, 'SIGTERM');
        armForceKill(agentId, agent);
      }
    }

    res.json({ success: true, killed: agentIds.length });
  });

  /**
   * Send a BTW (additional context) message to a running agent.
   * Writes the message to a BTW.md file in the agent's workspace so the
   * agent can discover it during file operations.
   */
  app.post('/btw/:agentId', async (req, res) => {
    const { agentId } = req.params;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not running' });
    }

    const body = btwBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: bodyErrorMessage(body.error) });
    const { message } = body.data;

    // Derive workspace from the agent's known record, not from request body
    const agentWorkspace = agent.workspacePath;
    if (!agentWorkspace || typeof agentWorkspace !== 'string') {
      return res.status(400).json({ error: 'Agent has no known workspacePath' });
    }

    const timestamp = new Date().toISOString();
    const entry = `\n---\n**[${timestamp}]** ${message}\n`;
    const btwPath = join(agentWorkspace, 'BTW.md');

    // Append to BTW.md (create if first message)
    const existing = await readFile(btwPath, 'utf-8').catch(() => '');
    const header = existing ? '' : '# Additional Context from User\n\nThe user has sent you additional context while you are working. Read and incorporate this information.\n';
    await writeFile(btwPath, header + existing + entry);

    console.log(`💬 BTW message delivered to agent ${agentId} (${message.length} chars)`);

    // Emit the btw event so the main server can track it
    emitToServer('agent:btw', { agentId, message, timestamp });

    res.json({ success: true, agentId, btwPath });
  });

  /**
   * Get agent output
   */
  app.get('/agents/:agentId/output', (req, res) => {
    const { agentId } = req.params;
    const agent = activeAgents.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agentId, output: agent.outputBuffer });
  });
}
