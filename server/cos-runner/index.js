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
import { spawn } from '../lib/childProcess.js';
import * as pty from 'node-pty';
import { join, basename } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { ensureDir, PATHS, sleep, watchForFile } from '../lib/fileUtils.js';
import { prepareCliSpawn, killProcessTree, guardChildStdin, deliverChildStdin } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { prepareCliPrompt } from '../lib/cliProviderArgs.js';
import { commandExists } from '../lib/commandExists.js';
import { adoptNpmGlobalBinDir } from '../lib/npmGlobalBin.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { createCodexStderrFormatter } from '../lib/codexCliOutput.js';
import { createStreamingAnsiStripper } from '../lib/ansiStrip.js';
import { createStreamJsonParser } from './streamJsonParser.js';
import { loadState, saveState, withState } from './runnerState.js';
import { getProcessStats, checkProcessRunning } from './processStats.js';
import { usableAgentPid, runnerAgentLivenessFields } from '../lib/runnerAgentLiveness.js';
import { ALLOWED_COMMANDS, isAllowedCommand } from './allowedCommands.js';
import { armForceKill as armForceKillShared } from './forceKill.js';
import { PORTS } from '../lib/ports.js';
import { setupProcessErrorHandlers } from '../lib/errorHandler.js';
import { parseSentinelPayload } from '../lib/agentSentinel.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agentOutputMarkers.js';

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
// Agentic CLIs can spend several seconds loading config/plugins before their
// lightweight version command returns. Keep this aligned with commandExists'
// documented heavy-CLI probe budget so a cold but runnable provider is not
// rejected before its PTY opens.
const TUI_CAPABILITY_PROBE_TIMEOUT_MS = 15 * 1000;

// Path + listen constants. These lived adjacent to the command allowlist before
// it was extracted to ./allowedCommands.js; they must stay here — they're
// referenced throughout (AGENTS_DIR/ROOT_DIR for spawn cwd + dirs, and
// server.listen(PORT, HOST)) and dropping them crashes the runner on boot.
const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;

const PORT = process.env.PORT || PORTS.COS;
const HOST = process.env.HOST || '127.0.0.1';

// Active agent processes (in memory)
const activeAgents = new Map();

// `tui:output` is live telemetry, so an immediate process exit can beat its
// socket delivery. Keep a small terminal tail with the exit event: the PortOS
// spawner owns failure analysis and can persist it when no ordinary TUI chunk
// arrived. This is deliberately much smaller than the runner's 512 KiB live
// buffer and is enough to carry a CLI's startup diagnostic.
const TUI_EXIT_OUTPUT_TAIL_CHARS = 16 * 1024;
const TUI_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT']);

// Bind the shared escalation to this process's map, grace window, and durable
// state. See forceKill.js for the contract (notably: a fresh termination always
// re-arms, and `dropState` is only for a kill relayed after the PortOS server
// has already finalized the agent).
const armForceKill = (agentId, agent, opts = {}) =>
  armForceKillShared(activeAgents, agentId, agent, {
    graceMs: SIGKILL_GRACE_MS,
    ...opts,
    onDropState: (id) => {
      withState((state) => { delete state.agents[id]; })
        .catch(err => console.error(`❌ Reap state write failed for ${id}: ${err.message}`));
    },
  });

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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeAgents: activeAgents.size,
    uptime: process.uptime()
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
    });
  }
  res.json(agents);
});

/**
 * Spawn an interactive TUI in a runner-owned PTY. PortOS remains responsible
 * for prompt timing and rich completion analysis while it is connected; the
 * runner owns process survival and emits normal agent completion if the server
 * restarts before the TUI exits.
 */
app.post('/spawn-tui', async (req, res) => {
  const {
    agentId,
    taskId,
    sessionId = agentId,
    command,
    args = [],
    workspacePath,
    envVars = {},
    // Non-secret provider identity used to retain that provider's ambient auth
    // allowlist when the runner builds the child environment.
    providerAuth = null,
    cols = 80,
    rows = 24,
    doneSentinelPath = null,
  } = req.body;

  // Name the offending field. A single opaque "missing or invalid fields" 400
  // sent a grok-tui agent to the zombie reaper with no shell and no clue why —
  // the real cause (`grok` absent from ALLOWED_COMMANDS) was invisible.
  const missing = Object.entries({ agentId, taskId, sessionId })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    return res.status(400).json({ error: `Missing TUI spawn fields: ${missing.join(', ')}` });
  }
  if (!isAllowedCommand(command)) {
    return res.status(400).json({
      error: `Command not allowed: ${command}. Permitted commands: ${[...ALLOWED_COMMANDS].join(', ')}`
    });
  }
  if (!Array.isArray(args)) {
    return res.status(400).json({ error: 'Invalid args: expected an array' });
  }
  if (activeAgents.has(agentId)) {
    return res.status(409).json({ error: `Agent ${agentId} is already running` });
  }

  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;
  const childEnv = buildCliChildEnv({ before: envVars, provider: providerAuth, cwd });
  // node-pty reports a missing executable as an immediate exit with no data.
  // Check the exact child PATH first so the caller gets a usable configuration
  // error instead of a generic startup-failure after a blank PTY transcript.
  // Keep the resolved path private: it may include the local account name.
  const executable = findCommandOnPath(command, { env: childEnv, cwd });
  if (!executable) {
    return res.status(422).json({
      error: `Command executable unavailable: ${basename(command)} is not on the CoS Runner PATH. Install it or update the provider command.`
    });
  }
  // A PATH hit can still be a broken npm shim or an incomplete CLI install.
  // Probe the same launch shape that the PTY will use: on Windows a .cmd/.bat
  // shim must run through cmd.exe, while on POSIX it remains the direct binary.
  // That prevents node-pty from reducing an immediate CLI error to a blank exit.
  const versionProbe = prepareCliSpawn(executable, ['--version'], childEnv);
  const runnable = await commandExists(versionProbe.command, versionProbe.args, {
    timeoutMs: TUI_CAPABILITY_PROBE_TIMEOUT_MS,
    env: childEnv,
    cwd,
  });
  if (!runnable) {
    return res.status(422).json({
      error: `Command executable unavailable: ${basename(command)} did not pass the CoS Runner capability check. Reinstall it or update the provider command.`
    });
  }
  // Use the same safe wrapper for the actual PTY launch. In particular, this
  // preserves the shared escaping contract for paths/args passed to cmd.exe.
  const { command: ptyCommand, args: ptyArgs } = prepareCliSpawn(executable, args, childEnv);
  const tuiProcess = pty.spawn(ptyCommand, ptyArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv,
  });
  const startedAt = Date.now();
  const agent = {
    kind: 'tui',
    process: tuiProcess,
    taskId,
    pid: tuiProcess.pid,
    startedAt,
    outputBuffer: '',
    workspacePath: cwd,
    sessionId,
    command,
    doneSentinelPath,
    completedBySentinel: false,
    doneWatcher: null,
    // node-pty reports pid 0 for ConPTY on Windows, so a pid probe is not a
    // liveness signal. onExit is the runner's authority; GET /agents reads this.
    exited: false,
  };
  activeAgents.set(agentId, agent);

  tuiProcess.onData((data) => {
    const current = activeAgents.get(agentId);
    if (!current) return;
    current.outputBuffer += data;
    if (current.outputBuffer.length > 512 * 1024) {
      current.outputBuffer = current.outputBuffer.slice(-512 * 1024);
    }
    io.emit('tui:output', { sessionId, agentId, data });
  });

  tuiProcess.onExit(async ({ exitCode, signal }) => {
    try {
      const current = activeAgents.get(agentId);
      if (!current) return;
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
      // A paused agent's process was stopped deliberately and its record is what
      // a later resume reads, so report nothing: emitting `agent:completed` here
      // would finalize it as FAILED and retire the task the pause meant to keep.
      // Mirrors the CLI close handler's own pause guard below. This became
      // reachable when the node-pty kill started landing on Windows — before
      // that, pausing a runner-owned TUI threw and the PTY simply never exited.
      if (current.paused === true) {
        console.log(`⏸️ TUI agent ${agentId} exited after pause`);
        activeAgents.delete(agentId);
        return;
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
  });

  if (doneSentinelPath) {
    agent.doneWatcher = watchForFile(doneSentinelPath, async () => {
      const current = activeAgents.get(agentId);
      if (!current) return;
      current.completedBySentinel = true;
      const contents = await readFile(doneSentinelPath, 'utf8').catch(err => {
        console.error(`❌ TUI agent ${agentId} sentinel read failed: ${err.message}`);
        return '';
      });
      const { summary } = parseSentinelPayload(contents);
      if (summary) {
        emitToServer('agent:output', {
          agentId,
          text: `${SENTINEL_COMPLETION_MARKER}\n${summary.slice(0, 4096)}\n`,
        });
      }
      current.process.kill();
    });
  }

  await withState((state) => {
    state.agents[agentId] = {
      pid: tuiProcess.pid,
      taskId,
      startedAt,
      kind: 'tui',
      sessionId,
      workspacePath: cwd,
      doneSentinelPath,
    };
    state.stats.spawned++;
  });

  console.log(`📟 Runner-owned TUI ${agentId} started (PID: ${tuiProcess.pid})`);
  res.json({ success: true, agentId, sessionId, pid: tuiProcess.pid });
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
    // Non-secret provider identity used to retain that provider's ambient auth
    // allowlist when the runner builds the child environment.
    providerAuth = null,
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

  // The env arrives already composed — agentLifecycle built it with
  // composeProviderEnv (provider.envVars + the OpenCode models map) and POSTed it
  // — so this side only needs the base, the PWD pin, and the CLAUDECODE strip.
  // The pin is the path #3193 was reported through: the log line above named the
  // app's workspace correctly while every OpenCode agent still ran in the PortOS
  // folder. No `guard` — this separate process has never carried the pm2 shim.
  const childEnv = buildCliChildEnv({ before: envVars, provider: providerAuth, cwd });

  // Resolve a bare npm-installed CLI (opencode/codex/claude/… — a .cmd/.bat
  // shim on Windows) to its real path and wrap a shim as `cmd.exe /c <path>` so
  // spawn() under shell:false can launch it. Without this, Windows can't find
  // `opencode.cmd` from the bare name → spawn ENOENT (errno -4058) → empty
  // output → startup-failure. Mirrors the working "Run Prompt" path
  // (server/services/runner.js); resolved against childEnv so a provider PATH
  // override is honored. See issue #2243.
  // Deliver the prompt per provider convention BEFORE resolving the spawn shim:
  //   - Antigravity (`agy`): spliced in as the --print VALUE (agy does not read
  //     stdin) → useStdin=false. Without this the prompt never reaches the model
  //     and the trailing --print marker swallows the next flag as its "prompt".
  //   - Grok on Windows: `/dev/stdin` rewritten to a temp file → useStdin=false.
  //   - Every other provider: unchanged, prompt over stdin → useStdin=true.
  const { args: deliveredArgs, useStdin, cleanup: cleanupPromptFile } = prepareCliPrompt(command, spawnArgs, prompt);
  const { command: spawnCommand, args: finalSpawnArgs } = prepareCliSpawn(command, deliveredArgs, childEnv);

  // Spawn the CLI process
  const claudeProcess = spawn(spawnCommand, finalSpawnArgs, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv
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
    // Per-stream ANSI strippers, mirroring spawnDirectly's headless path — the
    // same providers land here when the run is dispatched through the runner, so
    // without these the `[stderr] [0m` noise reproduces on that half of the
    // dispatch matrix. Stateful: each buffers an escape split across two chunks.
    // A stream-json stdout is NDJSON with no raw ESC byte, so it skips the scan.
    stripStdoutAnsi: isStreamJson ? (text) => text : createStreamingAnsiStripper(),
    stripStderrAnsi: createStreamingAnsiStripper(),
    workspacePath: cwd
  });

  // Guard the stdin pipe BEFORE writing: a child that exits before reading it
  // (bad flag, missing CLI) emits EPIPE, and an unlistened stream 'error' out
  // here crashes the runner process. The 'error'/'close' handlers settle the run.
  guardChildStdin(claudeProcess);

  // Send prompt via stdin (skipped when the prompt was delivered via argv —
  // antigravity's --print value, or grok's Windows temp file).
  deliverChildStdin(claudeProcess, useStdin ? prompt : null, `agent ${agentId}`);

  // Handle stdout
  claudeProcess.stdout.on('data', (data) => {
    const agent = activeAgents.get(agentId);
    const text = agent?.stripStdoutAnsi ? agent.stripStdoutAnsi(data.toString()) : data.toString();

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
      // Non-stream providers: emit stdout as-is once decolored. A chunk that was
      // purely terminal control has nothing left to show. Unlike stderr below,
      // whitespace is NOT dropped here — a blank line is legitimate formatting
      // when it isn't wearing an `[stderr]` tag.
      if (!text) return;
      if (agent) {
        agent.outputBuffer += text;
      }
      emitToServer('agent:output', { agentId, text });
    }
  });

  // Handle stderr
  claudeProcess.stderr.on('data', (data) => {
    const agent = activeAgents.get(agentId);
    const decolored = agent?.stripStderrAnsi ? agent.stripStderrAnsi(data.toString()) : data.toString();
    if (agent?.codexStderrFormatter) {
      const lines = agent.codexStderrFormatter.processChunk(decolored);
      for (const line of lines) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
      return;
    }

    // A chunk that decolors down to whitespace was pure terminal control
    // (`opencode run` emits a bare reset per progress redraw). Tagging it
    // `[stderr]` would add one blank noise line to the tail per redraw.
    if (!decolored.trim()) return;
    const text = `[stderr] ${decolored}`;
    if (agent) agent.outputBuffer += text;
    emitToServer('agent:output', { agentId, text });
  });

  // Handle errors
  claudeProcess.on('error', (err) => {
    cleanupPromptFile();
    console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);
    emitToServer('agent:error', { agentId, error: err.message });
    activeAgents.delete(agentId);
  });

  // Handle process exit
  claudeProcess.on('close', async (code) => {
    cleanupPromptFile();
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

  killProcessTree(agent.process, 'SIGTERM');
  armForceKill(agentId, agent);

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

  killProcessTree(agent.process, 'SIGTERM');
  // NOT armForceKill: a pause keeps its map entry (the agent is meant to be
  // resumable) and only escalates while the pause is still in force.
  agent.killTimer = setTimeout(() => {
    agent.killTimer = null;
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

/**
 * Socket.IO connection handling
 */
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('tui:input', ({ sessionId, data }) => {
    try {
      const agent = [...activeAgents.values()].find(candidate => candidate.sessionId === sessionId);
      if (agent?.kind === 'tui' && typeof data === 'string') agent.process.write(data);
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

  socket.on('tui:kill', ({ sessionId, signal = 'SIGTERM' }) => {
    try {
      if (!TUI_SIGNALS.has(signal)) return;
      const entry = [...activeAgents.entries()].find(([, candidate]) => candidate.sessionId === sessionId);
      if (!entry) return;
      const [agentId, agent] = entry;
      if (agent.kind !== 'tui') return;
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

  // The runner is its own PM2 app with its own environment, and it spawns
  // provider CLIs by bare name — so it must adopt npm's global bin directory
  // itself. Without this a CLI the AI Providers page reports as installed
  // (the main server adopted it there) still 422s here as "not on the CoS
  // Runner PATH". Fire-and-forget: never blocks accepting work.
  adoptNpmGlobalBinDir().catch((err) => console.error(`❌ npm global bin adoption failed: ${err.message}`));

  // Ensure agents directory exists. try/catch is mandatory: this listener runs
  // outside the request lifecycle, so a rejected await here escapes as an
  // unhandled rejection and takes the runner down at boot (fatal on Node >= 15).
  try {
    if (!existsSync(AGENTS_DIR)) {
      await ensureDir(AGENTS_DIR);
    }
  } catch (err) {
    console.error(`❌ Agents dir setup failed: ${err.message}`);
  }

  // Delay orphan cleanup to allow socket connections to establish
  // This ensures completion events reach the main server for task retry
  setTimeout(async () => {
    // Same rule, and this body is the one that reads and rewrites the agent
    // state file: a truncated/corrupt `agents.json` or an EACCES rejects out of
    // an async timer callback with no owner, killing the runner seconds after
    // boot and leaving PM2 to restart-loop it against the same bad file.
    // Log and continue — a corrupt state file must not stop the runner from
    // accepting new work, and the sweep re-runs on the next restart.
    try {
      const orphaned = await cleanupOrphanedAgents();
      if (orphaned.length > 0) {
        console.log(`🧹 Cleaned ${orphaned.length} orphaned agent(s)`);
      }
    } catch (err) {
      console.error(`❌ Orphan cleanup failed: ${err.message}`);
    }
  }, ORPHAN_CLEANUP_DELAY_MS);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📴 Received SIGTERM, shutting down gracefully...');

  // Terminate all agents
  for (const [agentId, agent] of activeAgents) {
    console.log(`🔪 Terminating agent ${agentId}`);
    killProcessTree(agent.process, 'SIGTERM');
  }

  // Wait for agents to terminate
  await sleep(SHUTDOWN_DRAIN_MS);

  server.close(() => {
    console.log('👋 CoS Agent Runner stopped');
    process.exit(0);
  });
});
