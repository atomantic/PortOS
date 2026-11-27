import * as defaultPty from 'node-pty';
import { basename } from 'path';
import { commandExists as defaultCommandExists } from '../lib/commandExists.js';
import { findCommandOnPath as defaultFindCommandOnPath } from '../lib/processEnv.js';
import {
  diagnosePtySpawnFailure as defaultDiagnosePtySpawnFailure,
  probePtyRuntime as defaultProbePtyRuntime,
  PTY_WORKSPACE_MISSING_PREFIX,
} from '../lib/ptySpawnDiagnostics.js';
import { createTuiExitHandler } from './tuiExit.js';
import { bodyErrorMessage, spawnTuiBodySchema } from './requestSchemas.js';
import { parseSentinelPayload } from '../lib/agent/agentSentinel.js';
import { createAgentSentinelAccess as defaultCreateAgentSentinelAccess } from '../services/agent/agentSentinelWatcher.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agent/agentOutputMarkers.js';

// Agentic CLIs can spend several seconds loading config/plugins before their
// lightweight version command returns. Keep this aligned with commandExists'
// documented heavy-CLI probe budget so a cold but runnable provider is not
// rejected before its PTY opens.
const TUI_CAPABILITY_PROBE_TIMEOUT_MS = 15 * 1000;

export function registerSpawnTuiRoute(app, {
  activeAgents, lifecycle, securityScans, emitToServer,
  persistCompletion, rootDir, assertDatabaseAdmission, io,
  existsSync, prepareCliSpawn, buildCliChildEnv, withState,
  isAllowedCommand, allowedCommands, prepareWindowsAgentLaunch,
  watchWindowsAgentProcess,
}, deps) {
  const pty = deps.pty ?? defaultPty;
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const findCommandOnPath = deps.findCommandOnPath ?? defaultFindCommandOnPath;
  const diagnosePtySpawnFailure = deps.diagnosePtySpawnFailure ?? defaultDiagnosePtySpawnFailure;
  const probePtyRuntime = deps.probePtyRuntime ?? defaultProbePtyRuntime;
  const createAgentSentinelAccess = deps.createAgentSentinelAccess ?? defaultCreateAgentSentinelAccess;

  /**
   * Spawn an interactive TUI in a runner-owned PTY. PortOS remains responsible
   * for prompt timing and rich completion analysis while it is connected; the
   * runner owns process survival and emits normal agent completion if the server
   * restarts before the TUI exits.
   */
  app.post('/spawn-tui', lifecycle.spawnRoute(async (req, res) => {
    assertDatabaseAdmission();
    const body = spawnTuiBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: bodyErrorMessage(body.error) });
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
      trackPromptSubmission = false,
    } = body.data;

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
        error: `Command not allowed: ${command}. Permitted commands: ${[...allowedCommands].join(', ')}`,
      });
    }
    if (activeAgents.has(agentId)) {
      return res.status(409).json({ error: `Agent ${agentId} is already running` });
    }

    const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : rootDir;
    // Ahead of the executable checks below, because both of them run the child IN
    // this directory: a worktree reaped before the spawn makes the `--version`
    // probe fail too, and the runner would then blame the provider CLI and tell a
    // human to reinstall a binary that is sitting right there on PATH.
    if (!existsSync(cwd)) {
      return res.status(422).json({
        error: `${PTY_WORKSPACE_MISSING_PREFIX} the workspace for this spawn does not exist. Its worktree was probably removed before the agent launched.`,
      });
    }
    const childEnv = buildCliChildEnv({ before: envVars, provider: providerAuth, cwd });
    // node-pty reports a missing executable as an immediate exit with no data.
    // Check the exact child PATH first so the caller gets a usable configuration
    // error instead of a generic startup-failure after a blank PTY transcript.
    // Keep the resolved path private: it may include the local account name.
    const executable = findCommandOnPath(command, { env: childEnv, cwd });
    if (!executable) {
      return res.status(422).json({
        error: `Command executable unavailable: ${basename(command)} is not on the CoS Runner PATH. Install it or update the provider command.`,
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
    if (lifecycle.rejectSpawn(res)) return;
    if (!runnable) {
      return res.status(422).json({
        error: `Command executable unavailable: ${basename(command)} did not pass the CoS Runner capability check. Reinstall it or update the provider command.`,
      });
    }
    // Use the same safe wrapper for the actual PTY launch. In particular, this
    // preserves the shared escaping contract for paths/args passed to cmd.exe.
    const { command: ptyCommand, args: ptyArgs } = prepareCliSpawn(executable, args, childEnv);
    const tuiLaunch = prepareWindowsAgentLaunch(agentId, ptyCommand, ptyArgs, { cwd, env: childEnv, pty: true });
    await securityScans.register(agentId, body.data.securityScanGrant);
    // Read BEFORE pty.spawn so onData/onExit subscribe with no await after the
    // spawn: a PTY that exits during the read would otherwise lose its exit (#11761).
    const securityScan = await securityScans.read(agentId);
    // Both checks above cleared the executable, so a throw here is about the PTY
    // layer or the workspace — not the command. node-pty collapses those into one
    // opaque `posix_spawn failed: No such file or directory`, which read as a
    // transient runner refusal and sent the whole fleet into a retry storm. Name
    // the actual fault instead, and let the caller block on the unrecoverable ones.
    let tuiProcess;
    assertDatabaseAdmission();
    try {
      tuiProcess = pty.spawn(tuiLaunch.command, tuiLaunch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: childEnv,
      });
      watchWindowsAgentProcess(tuiProcess, tuiLaunch);
    } catch (err) {
      const { diagnosed, message } = diagnosePtySpawnFailure(err, {
        cwd,
        probeCwd: rootDir,
        runtimeProbe: (probeCwd) => probePtyRuntime(pty, probeCwd),
      });
      // Neither known fault: let the original bubble to the error middleware exactly
      // as it did before, rather than dressing an unknown cause in a confident 422.
      if (!diagnosed) throw err;
      console.error(`❌ PTY spawn failed for ${agentId}: ${message}`);
      return res.status(422).json({ error: message });
    }
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
      // Kept beside the live PTY, so a portos-server restart cannot erase the
      // distinction between a running task and an empty startup composer.
      promptSubmitted: trackPromptSubmission ? false : null,
      doneWatcher: null,
      // node-pty reports pid 0 for ConPTY on Windows, so a pid probe is not a
      // liveness signal. onExit is the runner's authority; GET /agents reads this.
      exited: false,
      securityScan,
      stopSecurityScan: () => securityScans.stop(agentId).catch(err => lifecycle.reportFailure(err)),
    };
    activeAgents.set(agentId, agent);
    const sentinelAccess = createAgentSentinelAccess({
      workspacePath: cwd,
      agentId,
      sentinelPath: doneSentinelPath,
      startedAt,
      getActiveAgentIds: () => activeAgents.keys(),
    });

    tuiProcess.onData((data) => {
      const current = activeAgents.get(agentId);
      if (!current) return;
      current.outputBuffer += data;
      if (current.outputBuffer.length > 512 * 1024) {
        current.outputBuffer = current.outputBuffer.slice(-512 * 1024);
      }
      io.emit('tui:output', { sessionId, agentId, data });
    });

    tuiProcess.onExit(lifecycle.agentExit(agentId, agent, createTuiExitHandler({
      agentId, taskId, sessionId, agent, activeAgents, io, emitToServer, withState,
      persistCompletion, onError: lifecycle.reportFailure,
    })));

    if (doneSentinelPath) {
      const handleSentinel = () => {
        agent.sentinelWork = lifecycle.trackWork(async () => {
          const current = activeAgents.get(agentId);
          if (!current) return;
          const sentinelSourcePath = sentinelAccess.resolvedPath?.();
          let sentinelReadSucceeded = true;
          const contents = await sentinelAccess.read().catch(err => {
            sentinelReadSucceeded = false;
            console.error(`❌ TUI agent ${agentId} sentinel read failed: ${err.message}`);
            return '';
          });
          let sentinelValidated = sentinelReadSucceeded;
          let validatedContents = contents;
          if (sentinelReadSucceeded) {
            sentinelValidated = await sentinelAccess.promote(contents).catch(err => {
              console.error(`❌ TUI agent ${agentId} canonical sentinel promotion failed: ${err.message}`);
              return false;
            });
            if (sentinelValidated && sentinelSourcePath && sentinelSourcePath !== sentinelAccess.path) {
              let canonicalReadSucceeded = true;
              validatedContents = await sentinelAccess.read().catch(err => {
                canonicalReadSucceeded = false;
                console.error(`❌ TUI agent ${agentId} canonical sentinel read failed: ${err.message}`);
                return '';
              });
              sentinelValidated = canonicalReadSucceeded;
            }
          }
          if (!sentinelValidated) {
            if (activeAgents.get(agentId) === current) {
              current.doneWatcher?.();
              current.doneWatcher = sentinelAccess.watch(handleSentinel);
            }
            return;
          }
          current.completedBySentinel = true;
          const { summary } = parseSentinelPayload(validatedContents);
          if (summary) {
            current.completionOutput = `${SENTINEL_COMPLETION_MARKER}\n${summary}\n`;
            emitToServer('agent:output', {
              agentId,
              text: `${SENTINEL_COMPLETION_MARKER}\n${summary.slice(0, 4096)}\n`,
            });
          }
          if (!current.exited) current.process.kill();
          await sentinelAccess.cleanup();
        });
        return agent.sentinelWork;
      };
      agent.doneWatcher = sentinelAccess.watch(handleSentinel);
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
        securityScanGrant: body.data.securityScanGrant,
      };
      state.stats.spawned++;
    });

    console.log(`📟 Runner-owned TUI ${agentId} started (PID: ${tuiProcess.pid})`);
    res.json({ success: true, agentId, sessionId, pid: tuiProcess.pid });
  }));
}
