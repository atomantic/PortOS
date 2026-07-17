/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions with local overrides
 */
import { spawn } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, tryReadFile } from '../lib/fileUtils.js';
import { hasModelFlag, extractBakedModel } from '../lib/providerModels.js';
import { buildOpencodeEnvVars } from '../lib/opencodeConfig.js';
import { buildCliArgs, prepareCliPrompt } from '../lib/cliProviderArgs.js';
import { agentGuardEnv } from '../lib/agentGuard/index.js';
import { createImmediateFallbackSignalDetector } from '../lib/aiToolkit/errorDetection.js';
import { killProcessTree, resolveWindowsExecutable, prepareWindowsSafeSpawn } from '../lib/bufferedSpawn.js';
import {
  setAIToolkitInstance,
  getAIToolkitInstance,
  requireToolkit,
} from '../lib/aiToolkitState.js';

// Re-exported so `server/lib/promptRunner.js` can import via the runner
// (its existing dependency boundary). The canonical home is now
// `server/lib/providerModels.js` — that's where `server/lib/tuiHandshake.js`
// imports from directly (lib→lib, no service layer violation).
export { hasModelFlag, extractBakedModel };

// `buildCliArgs` was extracted to `server/lib/cliProviderArgs.js` (a
// dependency-light module the standalone autofixer + calendar MCP sync can
// import). Re-exported here so its existing importers — and runner.test.js —
// keep resolving it from runner.js unchanged.
export { buildCliArgs };

// Runner-only state. The toolkit singleton itself lives in
// `lib/aiToolkitState.js` and is shared with providers / promptService;
// `runnerConfig` (dataDir + hooks) is captured here because only the runner
// needs it.
let runnerConfig = { dataDir: './data', hooks: {} };

export function setAIToolkit(toolkit, config = {}) {
  setAIToolkitInstance(toolkit);
  runnerConfig = { dataDir: config.dataDir || './data', hooks: config.hooks || {} };
}

// Invoke a completion hook / callback so that a throw is logged but never
// propagates — these run at out-of-request boundaries where an uncaught throw
// is an unhandled rejection that crashes the process. Each call is isolated so
// a throwing hook can't prevent a later `onComplete` from settling the caller.
// Handles both a synchronous throw AND a rejected promise from an async hook —
// the latter would otherwise surface as an unhandled rejection.
function safeSettle(fn, label) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(err => console.error(`❌ ${label} threw during recovery: ${err.message}`));
    }
  } catch (err) {
    console.error(`❌ ${label} threw during recovery: ${err.message}`);
  }
}

export async function createRun(options) {
  // The toolkit's runner emits its own "🤖 AI run [source]: provider/model"
  // line — don't duplicate it here.
  return requireToolkit().services.runner.createRun(options);
}

/**
 * Returns the configured runs directory. Other execution paths
 * (`server/lib/tuiPromptRunner.js`) need this to write output + metadata
 * under the same tree as `createRun` — without it, runs configured with a
 * non-default `dataDir` end up split across two trees and `/runs` replay
 * breaks.
 */
export function getRunsPath() {
  return join(runnerConfig.dataDir, 'runs');
}

/**
 * Read existing metadata.json (written by toolkit createRun), merge in
 * completion fields, optionally run error analysis, write back, fire
 * onRunCompleted / onRunFailed hooks, and write the output buffer. Mirror
 * of the close-handler block in executeCliRun below — extracted so
 * `tuiPromptRunner.js` can produce the same run-record shape (otherwise
 * /runs shows TUI runs stuck with `success: null` forever).
 *
 * `extras` (optional object) is merged into the persisted metadata BEFORE
 * the file is written, so caller-specific fields like `completionReason`
 * (TUI) survive to disk and show up on /runs replay.
 *
 * @returns the merged metadata object (also written to disk).
 */
export async function finalizeRunRecord({ runId, output, exitCode, success, error, startTime, extras }) {
  const toolkit = requireToolkit();
  const runDir = join(getRunsPath(), runId);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  await writeFile(outputPath, output).catch(() => {});

  const metadataStr = await readFile(metadataPath, 'utf-8').catch(() => '{}');
  let metadata = {};
  try { metadata = JSON.parse(metadataStr); } catch { console.log('⚠️ Corrupted metadata for run, using fresh'); }
  metadata.endTime = new Date().toISOString();
  metadata.duration = Date.now() - startTime;
  metadata.exitCode = exitCode;
  metadata.success = success;
  metadata.outputSize = Buffer.byteLength(output);
  if (error) metadata.error = error;
  if (extras && typeof extras === 'object') Object.assign(metadata, extras);

  if (!success && toolkit.services.errorDetection) {
    const errorAnalysis = toolkit.services.errorDetection.analyzeError(output, exitCode);
    metadata.error = metadata.error || errorAnalysis.message || `Process exited with code ${exitCode}`;
    metadata.errorCategory = errorAnalysis.category;
    metadata.errorAnalysis = errorAnalysis;
  }

  await atomicWrite(metadataPath, metadata).catch(() => {});

  if (success) {
    runnerConfig.hooks?.onRunCompleted?.(metadata, output);
  } else {
    runnerConfig.hooks?.onRunFailed?.(metadata, metadata.error, output);
  }

  return metadata;
}

/**
 * Fire the `onRunStarted` lifecycle hook — used by execution paths that
 * don't go through the toolkit's executeCliRun/executeApiRun (which fire
 * it internally). `tuiPromptRunner.js` calls this on PTY spawn so UI/SSE
 * run tracking sees TUI runs as active.
 */
export function emitRunStarted({ runId, provider, model }) {
  runnerConfig.hooks?.onRunStarted?.({
    runId,
    provider: provider?.name || provider?.id,
    model: model ?? provider?.defaultModel,
  });
}

/**
 * Best-effort merge of `patch` into an existing run's metadata.json.
 * Used by `promptRunner.js` when the toolkit's createRun falls back to a
 * different provider — the original `metadata.model` then claims a model
 * that doesn't belong to the fallback. Patch it post-hoc so /runs
 * attribution matches what actually ran. Silent on read/write failures
 * because the run record is best-effort tracking, not load-bearing.
 */
export async function patchRunMetadata(runId, patch) {
  if (!patch || typeof patch !== 'object') return;
  const metadataPath = join(getRunsPath(), runId, 'metadata.json');
  const metadataStr = await tryReadFile(metadataPath);
  if (!metadataStr) return;
  let metadata;
  try { metadata = JSON.parse(metadataStr); } catch { return; }
  Object.assign(metadata, patch);
  await atomicWrite(metadataPath, metadata).catch(() => {});
}

/**
 * Override executeCliRun.
 *
 * Runs without `shell:true` (never set it here): npm-installed CLI providers
 * (opencode, codex, claude, …) are .cmd/.bat shims on Windows, but
 * `shell:true` + an args array does NOT escape arguments — it just
 * space-joins them (the literal DEP0190 warning) — so any arg or prompt
 * content containing a space or a cmd.exe metacharacter would silently
 * corrupt or be shell-injectable. The fix for #1865 instead resolves the
 * bare command to its explicit-extension path (`resolveWindowsExecutable`)
 * and, when that's a `.cmd`/`.bat` shim, spawns it via Node's own documented
 * safe pattern — `cmd.exe /c <path> <args>` — instead of targeting it
 * directly (`prepareWindowsSafeSpawn`; see its docstring for why a direct
 * `.cmd`/`.bat` spawn under `shell:false` fails outright post-CVE-2024-27980,
 * and why the `cmd.exe` wrapper avoids DEP0190's unescaped-join hazard).
 */
export async function executeCliRun({ runId, provider, prompt, workspacePath, onData, onComplete, timeout }) {
  const toolkit = requireToolkit();

  const runsPath = join(runnerConfig.dataDir, 'runs');
  const runDir = join(runsPath, runId);
  await ensureDir(runDir);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  const startTime = Date.now();
  let output = '';
  let immediateFallbackAnalysis = null;
  let childProcess = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();

  const abortForImmediateFallbackSignal = (text) => {
    if (immediateFallbackAnalysis || childProcess.killed) return;
    const analysis = detectImmediateFallbackSignal(text);
    if (!analysis) return;
    immediateFallbackAnalysis = analysis;
    console.log(`⚡ Run ${runId} detected fallback signal (${analysis.category}); stopping ${provider.name || provider.id || provider.command}`);
    killProcessTree(childProcess);
  };

  // Build provider-specific args for prompt delivery
  const builtArgs = buildCliArgs(provider);
  // Rewrite the argv for prompt delivery and learn whether to still write stdin:
  //   - Antigravity (`agy`): prompt spliced in as the --print VALUE (agy doesn't
  //     read stdin) → useStdin=false.
  //   - Grok: `--prompt-file /dev/stdin` on POSIX (fed by the stdin write below),
  //     rewritten to a temp file on Windows → useStdin=false.
  //   - Every other provider: unchanged, prompt over stdin → useStdin=true.
  // cleanupPromptFile removes any temp file after the run (no-op otherwise).
  const { args, useStdin, cleanup: cleanupPromptFile } = prepareCliPrompt(provider.command, builtArgs, prompt);
  console.log(`🚀 Executing CLI: ${provider.command} (${prompt.length} chars via ${useStdin ? 'stdin' : 'argv'})`);

  // Prepend the pm2 shim (agentGuardEnv) onto the final PATH so an unrestricted
  // agent can't `pm2 kill` the shared daemon. See server/lib/agentGuard.
  // buildOpencodeEnvVars rebuilds OPENCODE_CONFIG_CONTENT with a declared models
  // map for OpenCode Ollama providers (empty/no-op otherwise) so the injected
  // `--model ollama/<id>` isn't rejected as "not valid" — see issue-2190.
  const childEnv = { ...process.env, ...provider.envVars, ...buildOpencodeEnvVars(provider, provider.defaultModel) };
  delete childEnv.CLAUDECODE;
  Object.assign(childEnv, agentGuardEnv(childEnv));

  // See the executeCliRun docblock above for why this is a resolve+wrap, not
  // a shell:true. Resolved against `childEnv` (not bare process.env) so a
  // provider-configured PATH override is honored.
  const resolvedCommand = resolveWindowsExecutable(provider.command, undefined, childEnv) || provider.command;
  const { command: spawnCommand, args: spawnArgs } = prepareWindowsSafeSpawn(resolvedCommand, args);

  childProcess = spawn(spawnCommand, spawnArgs, {
    cwd: workspacePath,
    env: childEnv,
    windowsHide: true
  });

  // Pass prompt via stdin to avoid OS argv limits. When grok is delivered via a
  // Windows temp file (useStdin === false) the prompt is already on disk, so
  // just close stdin.
  if (useStdin) childProcess.stdin.write(prompt);
  childProcess.stdin.end();

  // Track active run via the toolkit's declared external-run registry so its
  // stopRun/isRunActive/deleteRun account for this host-spawned child process.
  toolkit.services.runner.registerExternalRun(runId, childProcess);

  // Call hooks
  runnerConfig.hooks?.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel });

  // Set timeout (default 5 min, guard against undefined which would fire immediately)
  const effectiveTimeout = timeout ?? provider.timeout ?? 300000;
  const timeoutHandle = effectiveTimeout > 0 ? setTimeout(() => {
    if (childProcess && !childProcess.killed) {
      console.log(`⏱️ Run ${runId} timed out after ${effectiveTimeout}ms`);
      killProcessTree(childProcess);
    }
  }, effectiveTimeout) : null;

  childProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text);
    abortForImmediateFallbackSignal(text);
  });

  childProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text);
    abortForImmediateFallbackSignal(text);
  });

  // Node emits `error` for a spawn failure and commonly follows it with `close`.
  // Funnel both events through one promise so terminal persistence + hooks run
  // exactly once. The finalizer always merges into createRun's metadata instead
  // of replacing attribution fields on the spawn-error path.
  let finalizationPromise = null;
  const finalizeTerminal = async ({ exitCode, spawnError = null }) => {
    const metadataStr = await readFile(metadataPath, 'utf-8').catch(() => '{}');
    let metadata = {};
    try {
      const parsed = JSON.parse(metadataStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      console.log('⚠️ Corrupted metadata for run, using fresh');
    }

    // Direct callers may not have gone through createRun. Fill only absent
    // attribution fields; never overwrite the persisted provider/workspace.
    metadata.id ??= runId;
    if (metadata.providerId == null && provider.id) metadata.providerId = provider.id;
    if (metadata.providerName == null && (provider.name || provider.id)) metadata.providerName = provider.name || provider.id;
    if (metadata.model == null && provider.defaultModel) metadata.model = provider.defaultModel;
    if (metadata.workspacePath == null && workspacePath) metadata.workspacePath = workspacePath;

    try {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      toolkit.services.runner.unregisterExternalRun(runId);
      cleanupPromptFile();
      if (spawnError) console.error(`❌ Run ${runId} spawn error: ${spawnError.message}`);

      await writeFile(outputPath, output);

      metadata.endTime = new Date().toISOString();
      metadata.duration = Date.now() - startTime;
      metadata.exitCode = exitCode;
      metadata.success = spawnError ? false : exitCode === 0 && !immediateFallbackAnalysis;
      metadata.outputSize = Buffer.byteLength(output);

      if (spawnError) {
        metadata.error = `Spawn failed: ${spawnError.message}`;
        metadata.errorCategory = 'spawn_error';
      } else if (!metadata.success && toolkit.services.errorDetection) {
        // A mid-stream fallback signal (e.g. usage-limit hit) SIGTERM-kills the
        // child; even an exit 0 must remain a failure so fallback can run.
        const errorAnalysis = immediateFallbackAnalysis || toolkit.services.errorDetection.analyzeError(output, exitCode);
        metadata.error = errorAnalysis.message || `Process exited with code ${exitCode}`;
        metadata.errorCategory = errorAnalysis.category;
        metadata.errorAnalysis = errorAnalysis;
      }

      await atomicWrite(metadataPath, metadata);

      // Isolate lifecycle hooks from onComplete so a hook failure never changes
      // the terminal result or prevents the caller from settling.
      if (metadata.success) {
        safeSettle(() => runnerConfig.hooks?.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
      } else {
        safeSettle(() => runnerConfig.hooks?.onRunFailed?.(metadata, metadata.error, output), `Run ${runId} onRunFailed hook`);
      }
      safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
      return metadata;
    } catch (err) {
      const handler = spawnError ? 'error' : 'close';
      console.error(`❌ Run ${runId} ${handler} handler error: ${err.message}`);
      const failMetadata = {
        ...metadata,
        endTime: new Date().toISOString(),
        duration: Date.now() - startTime,
        exitCode,
        success: false,
        error: `Run finalization failed: ${err.message}`,
        errorCategory: 'finalization_error',
        outputSize: Buffer.byteLength(output),
      };
      safeSettle(() => runnerConfig.hooks?.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
      safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
      return failMetadata;
    }
  };
  const finalizeOnce = (terminal) => {
    if (!finalizationPromise) finalizationPromise = finalizeTerminal(terminal);
    return finalizationPromise;
  };

  childProcess.on('error', (err) => {
    void finalizeOnce({ exitCode: -1, spawnError: err });
  });

  childProcess.on('close', (code) => {
    void finalizeOnce({ exitCode: code });
  });

  return runId;
}

export async function executeApiRun(options) {
  return requireToolkit().services.runner.executeApiRun(options);
}

/**
 * Register an in-flight run's killable process (ChildProcess or IPty) in the
 * toolkit's declared external-run registry the toolkit `stopRun`/`isRunActive`/
 * `deleteRun` consult. Used by `executeTuiRun` so TUI runs can be stopped from
 * /runs the same way CLI runs can. Both ChildProcess and node-pty IPty expose
 * `.kill(signal?)`.
 */
export function registerActiveRun(runId, killable) {
  requireToolkit().services.runner.registerExternalRun(runId, killable);
}

export function unregisterActiveRun(runId) {
  // No-throw read: cleanup paths may run after the toolkit is gone (e.g.
  // shutdown), so use `getAIToolkitInstance()` rather than `requireToolkit()`.
  getAIToolkitInstance()?.services?.runner?.unregisterExternalRun?.(runId);
}

export async function stopRun(runId) {
  // The toolkit's stopRun now consults the external-run registry first (it kills
  // the registered child/pty before falling back to its own activeRuns map), so
  // this is a thin pass-through.
  return requireToolkit().services.runner.stopRun(runId);
}

export async function getRun(runId) {
  return requireToolkit().services.runner.getRun(runId);
}

export async function getRunOutput(runId) {
  return requireToolkit().services.runner.getRunOutput(runId);
}

export async function getRunPrompt(runId) {
  return requireToolkit().services.runner.getRunPrompt(runId);
}

export async function listRuns(limit, offset, source) {
  return requireToolkit().services.runner.listRuns(limit, offset, source);
}

export async function deleteRun(runId) {
  return requireToolkit().services.runner.deleteRun(runId);
}

export async function deleteFailedRuns() {
  return requireToolkit().services.runner.deleteFailedRuns();
}

export async function isRunActive(runId) {
  return requireToolkit().services.runner.isRunActive(runId);
}
