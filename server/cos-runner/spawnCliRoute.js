import { withBackupAssetPublication as defaultWithBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { spawn as defaultSpawn } from '../lib/childProcess.js';
import {
  pendingWindowsProcessTreeExit,
  guardChildStdin as defaultGuardChildStdin,
  deliverChildStdin as defaultDeliverChildStdin,
} from '../lib/bufferedSpawn.js';
import { prepareCliPrompt as defaultPrepareCliPrompt } from '../lib/cliProviderArgs.js';
import { createCliAgentOutputParser as defaultCreateCliAgentOutputParser } from '../lib/cliAgentOutputParser.js';
import { bodyErrorMessage, spawnBodySchema } from './requestSchemas.js';

export function registerSpawnCliRoute(app, {
  activeAgents, lifecycle, securityScans, emitToServer,
  persistCompletion, armForceKill, rootDir, assertDatabaseAdmission,
  prepareCliSpawn, killProcessTree, buildCliChildEnv,
  withState, isAllowedCommand, allowedCommands,
  prepareWindowsAgentLaunch, watchWindowsAgentProcess,
}, deps) {
  const spawn = deps.spawn ?? defaultSpawn;
  const withBackupAssetPublication = deps.withBackupAssetPublication ?? defaultWithBackupAssetPublication;
  const guardChildStdin = deps.guardChildStdin ?? defaultGuardChildStdin;
  const deliverChildStdin = deps.deliverChildStdin ?? defaultDeliverChildStdin;
  const prepareCliPrompt = deps.prepareCliPrompt ?? defaultPrepareCliPrompt;
  const createCliAgentOutputParser = deps.createCliAgentOutputParser ?? defaultCreateCliAgentOutputParser;

  /**
   * Spawn a new agent
   */
  app.post('/spawn', lifecycle.spawnRoute(async (req, res) => {
    assertDatabaseAdmission();
    const body = spawnBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: bodyErrorMessage(body.error) });
    const {
      agentId,
      taskId,
      prompt,
      workspacePath,
      envVars = {},
      // Non-secret provider identity used to retain that provider's ambient auth
      // allowlist when the runner builds the child environment.
      providerAuth = null,
      cliCommand,
      cliArgs,
    } = body.data;

    if (!agentId || !taskId || !prompt) {
      return res.status(400).json({ error: 'Missing required fields: agentId, taskId, prompt' });
    }

    // Every spawn names its command and it must pass the allowlist; the runner
    // never falls back to a default binary. The server has sent cliCommand on every
    // /spawn since e9d563d535 (2026-01), so no mixed-version window sends it absent.
    if (!isAllowedCommand(cliCommand)) {
      return res.status(400).json({
        error: `Command not allowed: ${cliCommand}. Permitted commands: ${[...allowedCommands].join(', ')}`,
      });
    }
    const command = cliCommand;
    // cliArgs is an array or a single string (the schema rejects anything else);
    // default to empty args when not provided.
    const args = cliArgs ?? [];
    const spawnArgs = Array.isArray(args) ? args : [args];

    if (activeAgents.has(agentId)) {
      return res.status(409).json({ error: `Agent ${agentId} is already running` });
    }

    console.log(`🤖 Spawning agent ${agentId} for task ${taskId} (CLI: ${command})`);

    // Ensure workspacePath is valid
    const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : rootDir;

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
    assertDatabaseAdmission();
    const { args: deliveredArgs, useStdin, cleanup: cleanupPromptFile } = prepareCliPrompt(command, spawnArgs, prompt, { cwd });
    const { command: spawnCommand, args: finalSpawnArgs } = prepareCliSpawn(command, deliveredArgs, childEnv);

    if (lifecycle.rejectSpawn(res)) {
      cleanupPromptFile();
      return;
    }

    // Spawn the CLI process
    await securityScans.register(agentId, body.data.securityScanGrant);
    // Read BEFORE spawn: Node reports child-launch failures (ENOENT/EACCES/EMFILE) via
    // process.nextTick, so no await may sit between creating the child and attaching its 'error'
    // listener or the unhandled event kills the runner (#11761).
    const securityScan = await securityScans.read(agentId);
    const launch = prepareWindowsAgentLaunch(agentId, spawnCommand, finalSpawnArgs, { cwd, env: childEnv });
    const claudeProcess = spawn(launch.command, launch.args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    watchWindowsAgentProcess(claudeProcess, launch);

    // The same parser the direct spawner feeds (lib/cliAgentOutputParser.js): ANSI stripping, stream-json,
    // the codex stderr formatter, stderr noise, the capped raw stream and the usage-limit detector. The
    // runner keeps only its own I/O: socket emits and the completion receipt.
    const parser = createCliAgentOutputParser({ command, args: spawnArgs, prompt });

    // Store in memory
    const agent = {
      process: claudeProcess,
      taskId,
      pid: claudeProcess.pid,
      startedAt: Date.now(),
      outputBuffer: '',
      parser,
      // Set once when the parser reports a usage-limit / auth banner; the run is then failed even if the
      // killed child exits 0, and the server reads this verdict instead of re-deriving one.
      fallbackAnalysis: null,
      workspacePath: cwd,
      securityScan,
      stopSecurityScan: () => securityScans.stop(agentId).catch(err => lifecycle.reportFailure(err)),
    };
    activeAgents.set(agentId, agent);

    const emitParsed = ({ lines, text }) => {
      for (const line of lines) {
        agent.outputBuffer += line + '\n';
        emitToServer('agent:output', { agentId, text: line + '\n' });
      }
      if (text) {
        agent.outputBuffer += text;
        emitToServer('agent:output', { agentId, text });
      }
    };

    // Stop the provider on its first usage-limit / auth signal, as the direct spawner does. Skipped for a run
    // being paused: that stop has its own owner and verdict.
    const stopForFallbackSignal = (signal) => {
      if (!signal || agent.fallbackAnalysis || agent.paused) return;
      agent.fallbackAnalysis = signal;
      console.log(`🛑 Agent ${agentId} detected provider fallback signal (${signal.category}); stopping ${command}`);
      killProcessTree(claudeProcess, 'SIGTERM');
      armForceKill(agentId, agent);
    };

    // Guard the stdin pipe BEFORE writing: a child that exits before reading it
    // (bad flag, missing CLI) emits EPIPE, and an unlistened stream 'error' out
    // here crashes the runner process. The 'error'/'close' handlers settle the run.
    guardChildStdin(claudeProcess);

    // Send prompt via stdin (skipped when the prompt was delivered via argv —
    // antigravity's --print value, or grok's Windows temp file).
    deliverChildStdin(claudeProcess, useStdin ? prompt : null, `agent ${agentId}`);

    // Child listeners handle bad chunks locally: an uncaught throw in a data callback would crash the runner.
    claudeProcess.stdout.on('data', (data) => {
      try {
        const parsed = agent.parser.stdout(data);
        stopForFallbackSignal(parsed.fallbackSignal);
        emitParsed(parsed);
      } catch (err) {
        console.error(`❌ Agent ${agentId} stdout handler failed: ${err.message}`);
      }
    });

    claudeProcess.stderr.on('data', (data) => {
      try {
        const parsed = agent.parser.stderr(data);
        stopForFallbackSignal(parsed.fallbackSignal);
        emitParsed(parsed);
      } catch (err) {
        console.error(`❌ Agent ${agentId} stderr handler failed: ${err.message}`);
      }
    });

    // Handle errors
    claudeProcess.on('error', (err) => {
      cleanupPromptFile();
      console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);
      emitToServer('agent:error', { agentId, error: err.message });
      activeAgents.delete(agentId);
    });

    // Handle process exit
    claudeProcess.on('close', lifecycle.agentExit(agentId, agent, async (code) => {
      cleanupPromptFile();
      try {
        const treeExit = pendingWindowsProcessTreeExit(claudeProcess);
        if (treeExit) await treeExit;
        agent.exited = true;
        await agent.stopSecurityScan?.();
        // Cancel any pending SIGKILL timer — process already exited.
        if (agent?.killTimer) {
          clearTimeout(agent.killTimer);
          agent.killTimer = null;
        }
        const duration = Date.now() - (agent?.startedAt || Date.now());

        // Flush the parsers' unterminated tails, then prefer the parsed final result as the transcript.
        const flushed = agent.parser.flush();
        emitParsed({ lines: flushed.lines, text: '' });
        if (flushed.finalResult) agent.outputBuffer = flushed.finalResult;

        const output = agent?.outputBuffer || '';
        const paused = agent?.paused === true;
        // A usage-limit stop can race to exit 0; it must not be recorded as a success or the provider
        // fallback / retry never fires. Optional fields below: an older server ignores them.
        const success = code === 0 && !agent.fallbackAnalysis;
        const verdictFields = {
          ...(agent.fallbackAnalysis ? { fallbackAnalysis: agent.fallbackAnalysis } : {}),
          ...(flushed.completionResult ? { finalSummary: flushed.completionResult } : {}),
          // The parsed transcript above lost the raw stream-json payload failure analysis reads, so a failed
          // run carries the capped raw tail with it. A success never needs it.
          ...(!success && agent.parser.rawStream() ? { rawStreamTail: agent.parser.rawStream() } : {}),
        };

        // A non-zero exit is a failure line, so it belongs on stderr where a
        // stderr-based monitor can see it (#7945). A pause or a clean exit is
        // ordinary progress and stays on stdout.
        const logExit = !paused && !success ? console.error : console.log;
        logExit(`${paused ? '⏸️' : success ? '✅' : '❌'} Agent ${agentId} exited with code ${code}${paused ? ' after pause' : ''}${agent.fallbackAnalysis ? ` (stopped on ${agent.fallbackAnalysis.category})` : ''}`);

        // Persist output and terminal evidence before publishing completion or
        // removing durable ownership. Failed writes leave recovery evidence intact.
        await withBackupAssetPublication(async () => {
          await persistCompletion(agentId, output, paused ? null : {
            taskId,
            completedAt: new Date().toISOString(),
            exitCode: code,
            success,
            duration,
            securityScan: agent.securityScan,
            ...verdictFields,
          });
          if (paused) {
            activeAgents.delete(agentId);
            return;
          }

          // Emit completion event
          emitToServer('agent:completed', {
            agentId,
            taskId,
            exitCode: code,
            success,
            duration,
            outputLength: output.length,
            securityScan: agent.securityScan,
            ...verdictFields,
          });

          // Update state — serialize with the spawn write path via withState.
          await withState((state) => {
            state.stats.completed++;
            if (!success) state.stats.failed++;
            delete state.agents[agentId];
          });
        });
        activeAgents.delete(agentId);
      } catch (err) {
        lifecycle.reportFailure(err);
        activeAgents.delete(agentId);
        return false;
      }
    }));

    // Update state — use withState to serialize the read-modify-write with the
    // close handler's own state update, preventing concurrent mutation of the
    // same state file.
    await withState((state) => {
      state.agents[agentId] = {
        pid: claudeProcess.pid,
        securityScanGrant: body.data.securityScanGrant,
        taskId,
        startedAt: Date.now(),
      };
      state.stats.spawned++;
    });

    res.json({
      success: true,
      agentId,
      pid: claudeProcess.pid,
    });
  }));
}
