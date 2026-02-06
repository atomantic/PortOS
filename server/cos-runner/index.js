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
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import http from 'http';
import { Server as SocketServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../../');
const STATE_FILE = join(ROOT_DIR, 'data/cos/runner-state.json');
const AGENTS_DIR = join(ROOT_DIR, 'data/cos/agents');

const PORT = process.env.PORT || 5558;
const HOST = process.env.HOST || '127.0.0.1';
const RUNS_DIR = join(ROOT_DIR, 'data/runs');

// Allowlist of permitted CLI commands to prevent arbitrary code execution.
// Only commands in this list can be spawned by the runner.
const ALLOWED_COMMANDS = new Set([
  'claude',
  'aider',
  'codex',
  'copilot',
  'gemini'
]);

/**
 * Validate that a command is in the allowlist.
 * Extracts the base command name from the full path using path.basename for cross-platform support.
 * Handles Windows .exe extensions by stripping them before checking.
 */
function isAllowedCommand(command) {
  if (!command || typeof command !== 'string') return false;
  // Extract base command name from full path (e.g., /usr/bin/claude -> claude)
  // Uses path.basename for correct handling on both Unix and Windows
  let baseName = basename(command);
  // Normalize for Windows: strip trailing .exe (case-insensitive)
  if (baseName.toLowerCase().endsWith('.exe')) {
    baseName = baseName.slice(0, -4);
  }
  return ALLOWED_COMMANDS.has(baseName);
}

/**
 * Create a Claude stream-json parser that extracts human-readable text from JSON stream events.
 * Returns a stateful parser with a `processChunk(data)` method that returns extracted text lines.
 */
function createStreamJsonParser() {
  let lineBuffer = '';
  let finalResult = '';
  let textBuffer = '';

  const processChunk = (rawData) => {
    const lines = [];
    lineBuffer += rawData;

    const parts = lineBuffer.split('\n');
    lineBuffer = parts.pop() || '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      let parsed;
      parsed = JSON.parse(trimmed);
      if (!parsed) continue;

      if (parsed.type === 'stream_event') {
        const event = parsed.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          textBuffer += text;
          const textLines = textBuffer.split('\n');
          textBuffer = textLines.pop() || '';
          for (const tl of textLines) {
            lines.push(tl);
          }
        }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const toolName = event.content_block.name || 'unknown';
          lines.push(`🔧 Using ${toolName}...`);
        }
      }

      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              const firstLine = block.content.split('\n')[0]?.substring(0, 200);
              if (firstLine) {
                lines.push(`  ↳ ${firstLine}`);
              }
            }
          }
        }
      }

      if (parsed.type === 'result') {
        if (textBuffer) {
          lines.push(textBuffer);
          textBuffer = '';
        }
        finalResult = parsed.result || '';
      }
    }

    return lines;
  };

  const flush = () => {
    const lines = [];
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = '';
    }
    return lines;
  };

  const getFinalResult = () => finalResult;

  return { processChunk, flush, getFinalResult };
}

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
 * Validate JSON string before parsing
 */
function isValidJSON(str) {
  if (!str || !str.trim()) return false;
  const trimmed = str.trim();
  // Check for basic JSON structure
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
  // Check for common corruption patterns
  if (trimmed.endsWith('}}') || trimmed.includes('}{')) return false;
  return true;
}

/**
 * Load runner state from disk
 */
async function loadState() {
  const defaultState = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };

  if (!existsSync(STATE_FILE)) {
    return defaultState;
  }

  const content = await readFile(STATE_FILE, 'utf-8');

  if (!isValidJSON(content)) {
    console.log('⚠️ Corrupted or empty state file, returning default state');
    // Backup the corrupted file for debugging
    const backupPath = `${STATE_FILE}.corrupted.${Date.now()}`;
    await writeFile(backupPath, content).catch(() => {});
    console.log(`📝 Backed up corrupted state to ${backupPath}`);
    return defaultState;
  }

  return JSON.parse(content);
}

/**
 * Save runner state to disk
 */
async function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

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
    await mkdir(RUNS_DIR, { recursive: true });
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
 * Get process stats (CPU, memory) for a PID
 */
async function getProcessStats(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return { active: false, pid, cpu: 0, memoryKb: 0, state: 'invalid' };
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  // Get process stats using ps command
  // %cpu = CPU percentage, rss = resident set size in KB
  const result = await execAsync(`ps -p ${safePid} -o pid=,pcpu=,rss=,state= 2>/dev/null`).catch(() => ({ stdout: '' }));
  const line = result.stdout.trim();

  if (!line) {
    return { active: false, pid, cpu: 0, memoryKb: 0, state: 'dead' };
  }

  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    return {
      active: true,
      pid: parseInt(parts[0], 10),
      cpu: parseFloat(parts[1]) || 0,
      memoryKb: parseInt(parts[2], 10) || 0,
      memoryMb: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
      state: parts[3] || 'unknown'
    };
  }

  return { active: true, pid, cpu: 0, memoryKb: 0, state: 'unknown' };
}

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

  // Spawn the CLI process
  const claudeProcess = spawn(command, spawnArgs, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...envVars }
  });

  // Detect if stream-json format is active (Claude CLI with streaming)
  const isStreamJson = spawnArgs.includes('stream-json');
  const streamParser = isStreamJson ? createStreamJsonParser() : null;

  // Store in memory
  activeAgents.set(agentId, {
    process: claudeProcess,
    taskId,
    pid: claudeProcess.pid,
    startedAt: Date.now(),
    outputBuffer: '',
    rawStreamBuffer: '',
    streamParser
  });

  // Send prompt via stdin
  claudeProcess.stdin.write(prompt);
  claudeProcess.stdin.end();

  // Handle stdout
  claudeProcess.stdout.on('data', (data) => {
    const text = data.toString();
    const agent = activeAgents.get(agentId);

    if (agent?.streamParser) {
      // Parse stream-json and emit extracted text lines
      agent.rawStreamBuffer += text;
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
    const text = `[stderr] ${data.toString()}`;
    const agent = activeAgents.get(agentId);
    if (agent) {
      agent.outputBuffer += text;
    }
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
    const agent = activeAgents.get(agentId);
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

    const output = agent?.outputBuffer || '';

    console.log(`${code === 0 ? '✅' : '❌'} Agent ${agentId} exited with code ${code}`);

    // Save output to agent directory
    const agentDir = join(AGENTS_DIR, agentId);
    if (!existsSync(agentDir)) {
      await mkdir(agentDir, { recursive: true });
    }
    await writeFile(join(agentDir, 'output.txt'), output).catch(() => {});

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
    await writeFile(metadataPath, JSON.stringify(completionMetadata, null, 2)).catch(() => {});

    // Emit completion event
    emitToServer('agent:completed', {
      agentId,
      taskId,
      exitCode: code,
      success: code === 0,
      duration,
      outputLength: output.length
    });

    // Update state
    const state = await loadState();
    state.stats.completed++;
    if (code !== 0) state.stats.failed++;
    await saveState(state);

    activeAgents.delete(agentId);
  });

  // Update state
  const state = await loadState();
  state.agents[agentId] = {
    pid: claudeProcess.pid,
    taskId,
    startedAt: Date.now()
  };
  state.stats.spawned++;
  await saveState(state);

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

  agent.process.kill('SIGTERM');

  // Force kill after timeout
  setTimeout(() => {
    if (activeAgents.has(agentId)) {
      agent.process.kill('SIGKILL');
      activeAgents.delete(agentId);
    }
  }, 5000);

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

  // Use SIGKILL for immediate termination
  agent.process.kill('SIGKILL');

  // Clean up immediately
  activeAgents.delete(agentId);

  // Update state
  const state = await loadState();
  delete state.agents[agentId];
  await saveState(state);

  res.json({ success: true, agentId, pid: agent.pid, signal: 'SIGKILL' });
});

/**
 * Kill all agents
 */
app.post('/terminate-all', async (req, res) => {
  const agentIds = Array.from(activeAgents.keys());

  for (const agentId of agentIds) {
    const agent = activeAgents.get(agentId);
    if (agent) {
      agent.process.kill('SIGTERM');
    }
  }

  // Force kill after timeout
  setTimeout(() => {
    for (const agentId of agentIds) {
      const agent = activeAgents.get(agentId);
      if (agent) {
        agent.process.kill('SIGKILL');
        activeAgents.delete(agentId);
      }
    }
  }, 5000);

  res.json({ success: true, killed: agentIds.length });
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
    env: { ...process.env, ...envVars }
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
    const run = activeRuns.get(runId);
    const duration = Date.now() - startTime;
    const output = run?.outputBuffer || '';

    console.log(`${code === 0 ? '✅' : '❌'} Run ${runId} exited with code ${code} (${duration}ms)`);

    // Save output to run directory
    const runDir = join(RUNS_DIR, runId);
    if (!existsSync(runDir)) {
      await mkdir(runDir, { recursive: true });
    }
    await writeFile(join(runDir, 'output.txt'), output).catch(() => {});

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
    await writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2)).catch(() => {});

    // Emit completion event
    emitToServer('run:complete', {
      runId,
      exitCode: code,
      success: code === 0,
      duration,
      outputLength: output.length
    });

    activeRuns.delete(runId);
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
  }, 5000);

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
 * Check if a process is running by PID
 */
async function checkProcessRunning(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return false;
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const result = await execAsync(`ps -p ${safePid} -o pid=`).catch(() => ({ stdout: '' }));
  return result.stdout.trim() !== '';
}

/**
 * Start the server
 */
server.listen(PORT, HOST, async () => {
  console.log(`🤖 CoS Agent Runner started on http://${HOST}:${PORT}`);

  // Ensure agents directory exists
  if (!existsSync(AGENTS_DIR)) {
    await mkdir(AGENTS_DIR, { recursive: true });
  }

  // Delay orphan cleanup to allow socket connections to establish
  // This ensures completion events reach the main server for task retry
  setTimeout(async () => {
    const orphaned = await cleanupOrphanedAgents();
    if (orphaned.length > 0) {
      console.log(`🧹 Cleaned ${orphaned.length} orphaned agent(s)`);
    }
  }, 3000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📴 Received SIGTERM, shutting down gracefully...');

  // Terminate all agents
  for (const [agentId, agent] of activeAgents) {
    console.log(`🔪 Terminating agent ${agentId}`);
    agent.process.kill('SIGTERM');
  }

  // Wait for agents to terminate
  await new Promise(resolve => setTimeout(resolve, 5000));

  server.close(() => {
    console.log('👋 CoS Agent Runner stopped');
    process.exit(0);
  });
});
