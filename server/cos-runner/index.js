/**
 * CoS Agent Runner - Standalone PM2 Process
 *
 * This service runs as a separate PM2 app (portos-cos) that doesn't restart
 * when portos-server restarts. It manages Claude CLI agent spawning and
 * prevents orphaned processes when the main server cycles.
 *
 * Communication with portos-server happens via HTTP on port 5558.
 */

import express from 'express';
import { spawn } from 'child_process';
import { join, basename } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { prepareCliSpawn, killProcessTree } from '../lib/bufferedSpawn.js';
import { createCodexStderrFormatter } from '../lib/codexCliOutput.js';
import { createStreamJsonParser } from './streamJsonParser.js';
import { loadState, saveState, withState } from './runnerState.js';
import { getProcessStats, checkProcessRunning } from './processStats.js';
import { ALLOWED_COMMANDS, isAllowedCommand } from './allowedCommands.js';
import { PORTS } from '../lib/ports.js';
import { setupProcessErrorHandlers } from '../lib/errorHandler.js';

// Process-level safety net (defense-in-depth, see issue #1878). The main server
// (server/index.js) already wires this same shared helper via
// setupProcessErrorHandlers(io); the CoS runner — a separate long-lived PM2
// process that spawns and supervises child agents — had no such net, so a stray
// async handler that rejected/threw outside the request lifecycle would crash it
// with Node's default unhandled output. Reusing the shared helper gives the runner
// the identical, already-tested convention: log via the emoji-prefixed console.error
// style, and on an uncaughtException exit cleanly after flushing so PM2 restarts a
// process that would otherwise be left in an undefined state (boot then reaps any
// orphaned agents). Called with no `io` — the runner's socket server fans agent
// output to portos-server, not the error-alert UI, so the UI emit is skipped.
setupProcessErrorHandlers();

// Timing constants for process termination/cleanup (ms). Named so the grace
// windows are obvious at each call site instead of bare literals.
const SIGKILL_GRACE_MS = 5000;       // wait after SIGTERM before forcing SIGKILL
const ORPHAN_CLEANUP_DELAY_MS = 3000; // delay on boot before reaping orphaned agents
const SHUTDOWN_DRAIN_MS = 5000;       // SIGTERM drain window before closing the server

// Path + listen constants. These lived adjacent to the command allowlist before
// it was extracted to ./allowedCommands.js; they must stay here — they're
// referenced throughout (RUNS_DIR/AGENTS_DIR/ROOT_DIR for spawn cwd + dirs, and
// server.listen(PORT, HOST)) and dropping them crashes the runner on boot.
const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;
const RUNS_DIR = PATHS.runs;

const PORT = process.env.PORT || PORTS.COS;
const HOST = process.env.HOST || '127.0.0.1';

// Active agent processes (in memory)
const activeAgents = new Map();

// Active devtools runs (in memory)
const activeRuns = new Map();

// Express app setup
const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*' }
});

/**
 * Emit event to connected portos-server instances
 */
function emitToServer(event, data) {
  io.emit(event, data);
  console.log(`📡 Emitted ${event}`);
}

/**
 * Ensure runs directory exists
 */
async function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) {
    await ensureDir(RUNS_DIR);
  }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeAgents: activeAgents.size,
    activeRuns: activeRuns.size,
    uptime: process.uptime()
  });
});

/**
 * Get list of active agents with process stats
 */
app.get('/agents', async (req, res) => {
  const agents = [];
  for (const [agentId, agent] of activeAgents) {
    const stats = await getProcessStats(agent.pid);
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      pid: agent.pid,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt,
      processActive: stats.active,
      cpu: stats.cpu,
      memoryMb: stats.memoryMb,
      state: stats.state
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

  const stats = await getProcessStats(agent.pid);
  res.json({ agentId, pid: agent.pid, ...stats });
});

/**
 * Spawn a new agent
 */
app.post('/spawn', async (req, res) => {
  const {
    agentId,
    taskId,
    prompt,
    workspacePath,
    model,
    envVars = {},
    // New: CLI-agnostic parameters
    cliCommand,
    cliArgs,
    // Legacy: Claude-specific (deprecated)
    claudePath = process.env.CLAUDE_PATH || 'claude'
  } = req.body;

  if (!agentId || !taskId || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: agentId, taskId, prompt' });
  }

  // Use new CLI params if provided, otherwise fallback to legacy Claude defaults
  let command, spawnArgs;
  if (cliCommand) {
    // Validate command against allowlist to prevent arbitrary code execution
    if (!isAllowedCommand(cliCommand)) {
      return res.status(400).json({
        error: `Command not allowed: ${cliCommand}. Permitted commands: ${[...ALLOWED_COMMANDS].join(', ')}`
      });
    }
    command = cliCommand;
    // Default to empty args if cliArgs not provided
    const args = cliArgs ?? [];
    // Normalize cliArgs to an array
    if (Array.isArray(args)) {
      spawnArgs = args;
    } else if (typeof args === 'string') {
      spawnArgs = [args];
    } else {
      return res.status(400).json({
        error: 'Invalid cliArgs: expected an array or string'
      });
    }
  } else {
    // Legacy: Claude-specific args
    command = claudePath;
    spawnArgs = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages'
    ];
    if (model) {
      spawnArgs.push('--model', model);
    }
  }

  console.log(`🤖 Spawning agent ${agentId} for task ${taskId} (CLI: ${command})`);

  // Ensure workspacePath is valid
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;

  const childEnv = (() => { const e = { ...process.env, ...envVars }; delete e.CLAUDECODE; return e; })();

  // Resolve a bare npm-installed CLI (opencode/codex/claude/… — a .cmd/.bat
  // shim on Windows) to its real path and wrap a shim as `cmd.exe /c <path>` so
  // spawn() under shell:false can launch it. Without this, Windows can't find
  // `opencode.cmd` from the bare name → spawn ENOENT (errno -4058) → empty
  // output → startup-failure. Mirrors the working "Run Prompt" path
  // (server/services/runner.js); resolved against childEnv so a provider PATH
  // override is honored. See issue #2243.
  const { command: spawnCommand, args: finalSpawnArgs } = prepareCliSpawn(command, spawnArgs, childEnv);

  // Spawn the CLI process
  const claudeProcess = spawn(spawnCommand, finalSpawnArgs, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true
  });

  // Detect if stream-json format is active (Claude CLI with streaming)
  const isStreamJson = spawnArgs.includes('stream-json');
  const streamParser = isStreamJson ? createStreamJsonParser() : null;
  const isCodexCli = basename(command).replace(/\.exe$/i, '') === 'codex';
  const codexStderrFormatter = isCodexCli ? createCodexStderrFormatter(prompt) : null;

  // Store in memory
  activeAgents.set(agentId, {
    process: claudeProcess,
    taskId,
    pid: claudeProcess.pid,
    startedAt: Date.now(),
    outputBuffer: '',
    rawStreamBuffer: '',
    streamParser,
    codexStderrFormatter,
    workspacePath: cwd
  });

  // Send prompt via stdin
  claudeProcess.stdin.write(prompt);
  claudeProcess.stdin.end();

  // Handle stdout
  claudeProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const agent = activeAgents.get(agentId);

    if (agent?.streamParser) {
      // Parse stream-json and emit extracted text lines (cap buffer at 512KB for error analysis)
      agent.rawStreamBuffer += text;
      if (agent.rawStreamBuffer.length > 512 * 1024) {
        agent.rawStreamBuffer = agent.rawStreamBuffer.slice(-512 * 1024);
      }
      const lines = agent.streamParser.processChunk(text);
      for (const line of lines) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
    } else {
      // Non-stream providers: emit raw stdout as before
      if (agent) {
        agent.outputBuffer += text;
      }
      emitToServer('agent:output', { agentId, text });
    }
  });

  // Handle stderr
  claudeProcess.stderr.on('data', (data) => {
    const agent = activeAgents.get(agentId);
    if (agent?.codexStderrFormatter) {
      const lines = agent.codexStderrFormatter.processChunk(data.toString());
      for (const line of lines) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
      return;
    }

    const text = `[stderr] ${data.toString()}`;
    if (agent) agent.outputBuffer += text;
    emitToServer('agent:output', { agentId, text });
  });

  // Handle errors
  claudeProcess.on('error', (err) => {
    console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);
    emitToServer('agent:error', { agentId, error: err.message });
    activeAgents.delete(agentId);
  });

  // Handle process exit
  claudeProcess.on('close', async (code) => {
    try {
    const agent = activeAgents.get(agentId);
    // Cancel any pending SIGKILL timer — process already exited.
    if (agent?.killTimer) {
      clearTimeout(agent.killTimer);
      agent.killTimer = null;
    }
    const duration = Date.now() - (agent?.startedAt || Date.now());

    // Flush remaining stream parser data
    if (agent?.streamParser) {
      const remaining = agent.streamParser.flush();
      for (const line of remaining) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
      // Use the parsed final result for the output file if available
      const finalResult = agent.streamParser.getFinalResult();
      if (finalResult) {
        agent.outputBuffer = finalResult;
      }
    }
    if (agent?.codexStderrFormatter) {
      const remaining = agent.codexStderrFormatter.flush();
      for (const line of remaining) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
    }

    const output = agent?.outputBuffer || '';
    const paused = agent?.paused === true;

    console.log(`${paused ? '⏸️' : code === 0 ? '✅' : '❌'} Agent ${agentId} exited with code ${code}${paused ? ' after pause' : ''}`);

    // Save output to agent directory
    const agentDir = join(AGENTS_DIR, agentId);
    if (!existsSync(agentDir)) {
      await ensureDir(agentDir);
    }
    await writeFile(join(agentDir, 'output.txt'), output)
      .catch(err => console.error(`❌ Agent ${agentId} failed to persist output.txt: ${err.message}`));

    if (paused) {
      activeAgents.delete(agentId);
      return;
    }

    // Persist completion status to disk BEFORE emitting event
    // This ensures recovery is possible even if the socket event is lost
    const metadataPath = join(agentDir, 'metadata.json');
    const existingMetadata = JSON.parse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    const completionMetadata = {
      ...existingMetadata,
      agentId,
      taskId,
      completedAt: new Date().toISOString(),
      exitCode: code,
      success: code === 0,
      duration,
      outputSize: Buffer.byteLength(output)
    };
    // Recovery-critical: completion metadata is how a restart reconstructs a
    // finished task — never swallow a write failure here, log it.
    await writeFile(metadataPath, JSON.stringify(completionMetadata, null, 2))
      .catch(err => console.error(`❌ Agent ${agentId} failed to persist completion metadata: ${err.message}`));

    // Emit completion event
    emitToServer('agent:completed', {
      agentId,
      taskId,
      exitCode: code,
      success: code === 0,
      duration,
      outputLength: output.length
    });

    // Update state — serialize with the spawn write path via withState.
    await withState((state) => {
      state.stats.completed++;
      if (code !== 0) state.stats.failed++;
      delete state.agents[agentId];
    });

    activeAgents.delete(agentId);
    } catch (err) {
      console.error(`❌ Agent ${agentId} close handler error: ${err.message}`);
      activeAgents.delete(agentId);
    }
  });

  // Update state — use withState to serialize the read-modify-write with the
  // close handler's own state update, preventing concurrent mutation of the
  // same state file.
  await withState((state) => {
    state.agents[agentId] = {
      pid: claudeProcess.pid,
      taskId,
      startedAt: Date.now()
    };
    state.stats.spawned++;
  });

  res.json({
    success: true,
    agentId,
    pid: claudeProcess.pid
  });
});

/**
 * Terminate an agent (graceful with SIGTERM, then SIGKILL after timeout)
 */
app.post('/terminate/:agentId', (req, res) => {
  const { agentId } = req.params;
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found or not running' });
  }

  console.log(`🔪 Terminating agent ${agentId}`);

  // killProcessTree (not .kill) so a Windows cmd.exe-wrapped CLI shim's real
  // child is taken down too, not orphaned (#2243). No-op difference on POSIX.
  killProcessTree(agent.process, 'SIGTERM');

  // Force kill after timeout; store handle so it can be cancelled if the
  // process exits cleanly before the grace window expires.
  agent.killTimer = setTimeout(() => {
    if (activeAgents.has(agentId)) {
      killProcessTree(agent.process, 'SIGKILL');
      activeAgents.delete(agentId);
    }
  }, SIGKILL_GRACE_MS);

  res.json({ success: true, agentId });
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

  // Use SIGKILL for immediate termination — killProcessTree so a Windows
  // cmd.exe-wrapped shim's real child isn't orphaned (#2243). POSIX unchanged.
  killProcessTree(agent.process, 'SIGKILL');

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
  const { reason = null } = req.body || {};
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found or not running' });
  }

  const pausedAt = new Date().toISOString();
  console.log(`⏸️ Pausing agent ${agentId} (PID: ${agent.pid})${reason ? `: ${reason}` : ''}`);

  agent.paused = true;
  agent.pausedAt = pausedAt;
  agent.pauseReason = reason;

  // killProcessTree so a Windows cmd.exe-wrapped shim's child isn't orphaned (#2243).
  killProcessTree(agent.process, 'SIGTERM');
  // Store handle so the close handler can clear it when the process exits first.
  agent.killTimer = setTimeout(() => {
    const current = activeAgents.get(agentId);
    if (current?.paused) killProcessTree(current.process, 'SIGKILL');
  }, SIGKILL_GRACE_MS);

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
      // killProcessTree so a Windows cmd.exe-wrapped shim's child isn't orphaned (#2243).
      killProcessTree(agent.process, 'SIGTERM');
      agent.killTimer = setTimeout(() => {
        if (activeAgents.has(agentId)) {
          killProcessTree(agent.process, 'SIGKILL');
          activeAgents.delete(agentId);
        }
      }, SIGKILL_GRACE_MS);
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
  const { message } = req.body;
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found or not running' });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid message' });
  }

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

  console.log(`💬 BTW message delivered to agent ${agentId}: ${message.substring(0, 80)}`);

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

// ============================================
// DEVTOOLS RUNS - CLI execution for devtools
// ============================================

/**
 * Execute a CLI run (devtools runner)
 */
app.post('/run', async (req, res) => {
  const {
    runId,
    command,
    args = [],
    prompt,
    workspacePath,
    envVars = {},
    timeout
  } = req.body;

  if (!runId || !command || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: runId, command, prompt' });
  }

  await ensureRunsDir();

  console.log(`🔧 Starting devtools run ${runId}: ${command} ${args.join(' ')}`);

  // Build command args - add prompt at the end
  const spawnArgs = [...args, prompt];

  // Ensure workspacePath is valid
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;

  // Spawn the CLI process
  const childProcess = spawn(command, spawnArgs, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: (() => { const e = { ...process.env, ...envVars }; delete e.CLAUDECODE; return e; })(),
    windowsHide: true
  });

  const startTime = Date.now();

  // Store in memory
  activeRuns.set(runId, {
    process: childProcess,
    pid: childProcess.pid,
    startedAt: startTime,
    outputBuffer: ''
  });

  // Handle stdout
  childProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const run = activeRuns.get(runId);
    if (run) {
      run.outputBuffer += text;
    }
    emitToServer('run:data', { runId, text });
  });

  // Handle stderr
  childProcess.stderr.on('data', (data) => {
    const text = data.toString();
    const run = activeRuns.get(runId);
    if (run) {
      run.outputBuffer += text;
    }
    emitToServer('run:data', { runId, text });
  });

  // Handle errors
  childProcess.on('error', (err) => {
    console.error(`❌ Run ${runId} spawn error: ${err.message}`);
    emitToServer('run:error', { runId, error: err.message });
    activeRuns.delete(runId);
  });

  // Handle process exit
  childProcess.on('close', async (code) => {
    try {
    const run = activeRuns.get(runId);
    const duration = Date.now() - startTime;
    const output = run?.outputBuffer || '';

    console.log(`${code === 0 ? '✅' : '❌'} Run ${runId} exited with code ${code} (${duration}ms)`);

    // Save output to run directory
    const runDir = join(RUNS_DIR, runId);
    if (!existsSync(runDir)) {
      await ensureDir(runDir);
    }
    await writeFile(join(runDir, 'output.txt'), output).catch(err => console.error(`❌ Run ${runId} failed to persist output.txt: ${err.message}`));

    // Persist completion status to disk BEFORE emitting event
    // This ensures recovery is possible even if the socket event is lost
    const metadataPath = join(runDir, 'metadata.json');
    const existingMetadata = JSON.parse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    const updatedMetadata = {
      ...existingMetadata,
      endTime: new Date().toISOString(),
      exitCode: code,
      success: code === 0,
      duration,
      outputSize: Buffer.byteLength(output)
    };
    await writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2)).catch(err => console.error(`❌ Run ${runId} failed to persist completion metadata: ${err.message}`));

    // Emit completion event
    emitToServer('run:complete', {
      runId,
      exitCode: code,
      success: code === 0,
      duration,
      outputLength: output.length
    });

    activeRuns.delete(runId);
    } catch (err) {
      console.error(`❌ Run ${runId} close handler error: ${err.message}`);
      activeRuns.delete(runId);
    }
  });

  // Set timeout if specified
  if (timeout) {
    setTimeout(() => {
      if (activeRuns.has(runId)) {
        console.log(`⏰ Run ${runId} timed out after ${timeout}ms`);
        childProcess.kill('SIGTERM');
      }
    }, timeout);
  }

  res.json({
    success: true,
    runId,
    pid: childProcess.pid
  });
});

/**
 * Get list of active runs
 */
app.get('/runs', (req, res) => {
  const runs = [];
  for (const [runId, run] of activeRuns) {
    runs.push({
      id: runId,
      pid: run.pid,
      startedAt: run.startedAt,
      runningTime: Date.now() - run.startedAt
    });
  }
  res.json(runs);
});

/**
 * Get run output
 */
app.get('/runs/:runId/output', (req, res) => {
  const { runId } = req.params;
  const run = activeRuns.get(runId);

  if (!run) {
    return res.status(404).json({ error: 'Run not found or not active' });
  }

  res.json({ runId, output: run.outputBuffer });
});

/**
 * Check if a run is active
 */
app.get('/runs/:runId/active', (req, res) => {
  const { runId } = req.params;
  res.json({ runId, active: activeRuns.has(runId) });
});

/**
 * Stop a run
 */
app.post('/runs/:runId/stop', (req, res) => {
  const { runId } = req.params;
  const run = activeRuns.get(runId);

  if (!run) {
    return res.status(404).json({ error: 'Run not found or not active' });
  }

  console.log(`🛑 Stopping run ${runId}`);

  run.process.kill('SIGTERM');

  // Force kill after timeout
  setTimeout(() => {
    if (activeRuns.has(runId)) {
      run.process.kill('SIGKILL');
      activeRuns.delete(runId);
    }
  }, SIGKILL_GRACE_MS);

  res.json({ success: true, runId });
});

/**
 * Socket.IO connection handling
 */
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

/**
 * Cleanup orphaned agents on startup
 * Checks if PIDs from state are still running
 * Emits a batch completion event for dead agents so main server can retry tasks
 */
async function cleanupOrphanedAgents() {
  const state = await loadState();
  const orphaned = [];

  for (const [agentId, agentInfo] of Object.entries(state.agents)) {
    // Check if process is still running
    const isRunning = await checkProcessRunning(agentInfo.pid);
    if (!isRunning) {
      orphaned.push({ agentId, taskId: agentInfo.taskId });
      delete state.agents[agentId];
    }
  }

  if (orphaned.length > 0) {
    console.log(`🧹 Cleaned up ${orphaned.length} orphaned agents from state`);
    await saveState(state);

    // Emit a single batch event with all orphaned agents
    // This avoids log spam when many agents were orphaned
    io.emit('agents:orphaned', {
      agents: orphaned.map(o => ({
        agentId: o.agentId,
        taskId: o.taskId,
        exitCode: -1,
        success: false,
        orphaned: true,
        error: 'Agent process died (runner restart detected dead PID)'
      })),
      count: orphaned.length
    });
    console.log(`📡 Emitted agents:orphaned (${orphaned.length} agents)`);
  }

  return orphaned;
}

/**
 * Start the server
 */
server.listen(PORT, HOST, async () => {
  console.log(`🤖 CoS Agent Runner started on http://${HOST}:${PORT}`);

  // Ensure agents directory exists
  if (!existsSync(AGENTS_DIR)) {
    await ensureDir(AGENTS_DIR);
  }

  // Delay orphan cleanup to allow socket connections to establish
  // This ensures completion events reach the main server for task retry
  setTimeout(async () => {
    const orphaned = await cleanupOrphanedAgents();
    if (orphaned.length > 0) {
      console.log(`🧹 Cleaned ${orphaned.length} orphaned agent(s)`);
    }
  }, ORPHAN_CLEANUP_DELAY_MS);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📴 Received SIGTERM, shutting down gracefully...');

  // Terminate all agents
  for (const [agentId, agent] of activeAgents) {
    console.log(`🔪 Terminating agent ${agentId}`);
    killProcessTree(agent.process, 'SIGTERM'); // tree-kill so Windows cmd.exe shims aren't orphaned (#2243)
  }

  // Wait for agents to terminate
  await new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

  server.close(() => {
    console.log('👋 CoS Agent Runner stopped');
    process.exit(0);
  });
});
