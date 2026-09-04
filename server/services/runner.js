/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions with local overrides
 */
import { spawn } from '../lib/childProcess.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, tryReadFile, writeFileGuarded, PATHS } from '../lib/fileUtils.js';
import { resolveSpawnCwd } from '../lib/spawnCwd.js';
import { hasModelFlag, extractBakedModel } from '../lib/providerModels.js';
import { buildCliArgs, prepareCliPrompt } from '../lib/cliProviderArgs.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { createImmediateFallbackSignalDetector, ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';
import { killProcessTree, resolveWindowsExecutable, prepareWindowsSafeSpawn, guardChildStdin, deliverChildStdin } from '../lib/bufferedSpawn.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
// `./ollamaAgentContext.js` (and the ollama daemon manager behind it) is imported
// lazily inside the predicate-gated branch below, NOT here — see that call site.
import { isOllamaBackedProvider } from './providers.js';
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
const metadataPatchTails = new Map();

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
 * `identity` (optional `{ providerId, providerName, model }`) fills ONLY keys
 * the stored metadata doesn't already carry — for a caller that spawns against
 * a synthesized run id instead of a toolkit `createRun` record. `extras` still
 * overwrites, so the two are not interchangeable.
 *
 * `reportFailure: false` finalizes the record but skips the `onRunFailed` hook,
 * for a run that is a deliberate PROBE of a provider rather than work the user
 * asked for. Same reasoning as the `canceled` branch below: the failure is the
 * caller's measurement, not evidence that a configured provider is broken.
 *
 * @returns the merged metadata object (also written to disk).
 */
export async function finalizeRunRecord({ runId, output, exitCode, success, error, startTime, extras, identity, reportFailure = true }) {
  const toolkit = requireToolkit();
  const runDir = join(getRunsPath(), runId);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  await writeFileGuarded(outputPath, output).catch(() => {});

  const metadataStr = await readFile(metadataPath, 'utf-8').catch(() => '{}');
  let metadata = {};
  try { metadata = JSON.parse(metadataStr); } catch { console.log('⚠️ Corrupted metadata for run, using fresh'); }
  // A caller that never went through toolkit `createRun` — or whose run record
  // was lost — leaves `{}` here, and the completion fields below then describe a
  // run with no id, provider or model. That anonymous record still reaches the
  // `onRunFailed` hook, which published an investigation task literally titled
  // "Investigate AI provider failure: undefined (undefined)" and keyed its
  // dedupe + circuit breaker on `undefined-undefined` — one bucket every such
  // failure collapses into, suppressing unrelated real ones for the window.
  // Backfill what the caller already handed us.
  if (!metadata.id) metadata.id = runId;
  for (const [key, value] of Object.entries(identity || {})) {
    if (metadata[key] === undefined && value !== undefined) metadata[key] = value;
  }
  metadata.endTime = new Date().toISOString();
  metadata.duration = Date.now() - startTime;
  metadata.exitCode = exitCode;
  metadata.success = success;
  metadata.outputSize = Buffer.byteLength(output);
  if (error) metadata.error = error;
  if (extras && typeof extras === 'object') Object.assign(metadata, extras);
  const canceled = metadata.canceled === true;

  if (!success && canceled) {
    // Cancellation is an operator/host lifecycle outcome, not evidence about
    // provider health. Keep it explicit for /runs without scanning story text
    // (which may contain quota-like words) or firing the provider-failure hook.
    metadata.errorCategory = ERROR_CATEGORIES.CANCELED;
  } else if (!success && toolkit.services.errorDetection) {
    // Exit 124 is the host's authoritative wall-clock timeout. Do not scan the
    // model's entire TUI screen/prompt for a competing category in that case:
    // story text can legitimately contain words such as "credit" or
    // "billing", which used to turn a plain timeout into quota-exceeded and
    // bench a healthy provider for an hour. Other failures still analyze the
    // output because their provider banner is often the only useful signal.
    const analyzeError = toolkit.services.errorDetection.analyzeError;
    const analysisInput = exitCode === 124 ? (error || 'Process timed out') : output;
    let errorAnalysis = analyzeError(analysisInput, exitCode);
    // When that scan lands on nothing, the caller's own `error` is the better
    // evidence — and the run that proved it was a local-LLM playground timeout:
    // the host aborted its OWN deadline, finalized with exit 1 + `Timed out after
    // Nms`, and handed over the partial generation as `output`. Scanning a
    // generation that carries no failure signal returns UNKNOWN with its first
    // line lifted as the "error message", so a plain timeout reached the
    // provider-failure hook as an uncategorized Tier-4 failure titled with the
    // story's own headline. Consulted only as a fallback, so a scan that already
    // found a real category (the CLI/TUI banner case) keeps it.
    if (error && (!errorAnalysis.category || errorAnalysis.category === ERROR_CATEGORIES.UNKNOWN)) {
      const statedAnalysis = analyzeError(error, exitCode);
      if (statedAnalysis.category && statedAnalysis.category !== ERROR_CATEGORIES.UNKNOWN) {
        errorAnalysis = statedAnalysis;
      }
    }
    metadata.error = metadata.error || errorAnalysis.message || `Process exited with code ${exitCode}`;
    metadata.errorCategory = errorAnalysis.category;
    metadata.errorAnalysis = errorAnalysis;
  }

  await atomicWrite(metadataPath, metadata).catch(() => {});

  // Guarded: these hooks are host-supplied, and every caller of this function
  // runs outside the request lifecycle — the /runs route never awaits its
  // executor. An unguarded throw (or rejected promise) from a hook propagates
  // out of finalizeRunRecord, past the caller's own settlement, and lands as an
  // unhandled rejection with the run stuck looking in-flight. The metadata is
  // already persisted by this point, so a failing hook must not un-finalize it.
  if (success) {
    safeSettle(() => runnerConfig.hooks?.onRunCompleted?.(metadata, output), 'onRunCompleted');
  } else if (!canceled && reportFailure) {
    safeSettle(() => runnerConfig.hooks?.onRunFailed?.(metadata, metadata.error, output), 'onRunFailed');
  }

  return metadata;
}

/**
 * Report a PRE-SPAWN failure through the run record instead of throwing.
 *
 * Extracted from `resolveRunCwd` below so every "we can't even start this run"
 * check shares one settlement path. Both spawning runners invoke their executor
 * WITHOUT awaiting it (the /runs route never does), so a bare throw surfaces
 * only as an unhandled rejection and the UI shows the run hanging forever.
 *
 * @returns the finalized metadata (also handed to `onComplete`).
 */
export async function failRunRecord({ runId, error, exitCode = null, startTime = Date.now(), onData, onComplete, identity, reportFailure = true }) {
  const message = `❌ ${error}`;
  // Settle the caller's callbacks through the same guard the close handler
  // uses. A throwing (or rejecting) onComplete here would reject the caller
  // AFTER the failed run was already persisted — and since /runs never awaits
  // its executor, that lands as the unhandled rejection + hung-looking run
  // this helper exists to prevent.
  safeSettle(() => onData?.(message), 'onData');
  const failure = await finalizeRunRecord({
    runId, output: message, exitCode, success: false, error, startTime, identity, reportFailure,
  });
  safeSettle(() => onComplete?.(failure), 'onComplete');
  return failure;
}

/**
 * Resolve a run's spawn cwd, turning an unusable workspace into a normal failed
 * run rather than a throw.
 *
 * Shared by both spawning runners (`executeCliRun` here, `executeTuiRun` in
 * `lib/tuiPromptRunner.js`) because the /runs route invokes them WITHOUT
 * awaiting: a bare throw would surface only as an unhandled rejection and the
 * UI would show the run hanging forever. Returning the failure instead keeps
 * the "report it through the run record" contract in one place, so a third
 * runner can't reintroduce the hang by forgetting the try/catch.
 *
 * @returns {Promise<{cwd: string, failure?: undefined} | {cwd?: undefined, failure: object}>}
 *   `cwd` on success; `failure` (the finalized metadata) when the workspace is unusable.
 */
export async function resolveRunCwd({ runId, workspacePath, label, startTime = Date.now(), onData, onComplete, identity, reportFailure = true }) {
  try {
    return { cwd: resolveSpawnCwd(workspacePath, PATHS.root, label) };
  } catch (err) {
    const failure = await failRunRecord({
      runId, error: err.message, exitCode: null, startTime, onData, onComplete, identity, reportFailure,
    });
    return { failure };
  }
}

/**
 * Fire the `onRunStarted` lifecycle hook — used by execution paths that
 * don't go through the toolkit's executeCliRun/executeApiRun (which fire
 * it internally). `tuiPromptRunner.js` calls this on PTY spawn so UI/SSE
 * run tracking sees TUI runs as active.
 */
export function emitRunStarted({ runId, provider, model }) {
  // Fire-and-forget lifecycle notification — a throwing hook must not take
  // down the already-registered PTY run (same orphaned-run shape as #5792).
  safeSettle(
    () => runnerConfig.hooks?.onRunStarted?.({
      runId,
      provider: provider?.name || provider?.id,
      model: model ?? provider?.defaultModel,
    }),
    `Run ${runId} onRunStarted hook`,
  );
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
  const previous = metadataPatchTails.get(runId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const metadataPath = join(getRunsPath(), runId, 'metadata.json');
    const metadataStr = await tryReadFile(metadataPath);
    if (!metadataStr) return;
    let metadata;
    try { metadata = JSON.parse(metadataStr); } catch { return; }
    Object.assign(metadata, patch);
    await atomicWrite(metadataPath, metadata).catch(() => {});
  });
  metadataPatchTails.set(runId, operation);
  await operation.finally(() => {
    if (metadataPatchTails.get(runId) === operation) metadataPatchTails.delete(runId);
  });
}

/**
 * A spawn failure phrased for the person reading the run log.
 *
 * Node reports a binary that isn't on PATH as `spawn codex ENOENT` — precise,
 * and meaningless to anyone who doesn't already know that ENOENT is "no such
 * file". Routing now skips a provider whose CLI is known to be absent (#4611),
 * so reaching this line means the probe hadn't caught up yet; name the binary
 * and where to install it rather than leaving the errno as the whole story.
 * Every other spawn failure keeps its raw message.
 *
 * @param {NodeJS.ErrnoException} spawnError
 * @param {string} command — the provider's configured command
 */
const describeSpawnFailure = (spawnError, command) =>
  spawnError?.code === 'ENOENT'
    ? `${command || 'The provider CLI'} is not installed on PortOS's PATH — install it from the AI Providers page, then re-run`
    : `Spawn failed: ${spawnError.message}`;

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
export async function executeCliRun({ runId, provider, prompt, workspacePath, screenshots = [], onData, onComplete, timeout }) {
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
  // Set by the wall-clock timeout below so the close handler can classify the
  // kill as a timeout instead of scanning the model's output for a category.
  let timeoutError = null;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();

  const abortForImmediateFallbackSignal = (text) => {
    if (immediateFallbackAnalysis || childProcess.killed) return;
    const analysis = detectImmediateFallbackSignal(text);
    if (!analysis) return;
    immediateFallbackAnalysis = analysis;
    console.log(`⚡ Run ${runId} detected fallback signal (${analysis.category}); stopping ${provider.name || provider.id || provider.command}`);
    killProcessTree(childProcess);
  };

  // Resolve (and log) the working directory before spawning, so a supplied-but-
  // missing workspace fails the run with an actionable message instead of
  // silently spawning in the PortOS checkout, where relative file writes from
  // the prompt would land in the wrong repo (#3180). Placed ahead of
  // prepareCliPrompt so a bad workspace short-circuits before any temp-file I/O.
  const { cwd: effectiveCwd, failure } = await resolveRunCwd({
    runId, workspacePath, label: `Run ${runId}`, startTime, onData, onComplete,
  });
  if (failure) return;

  const prepareVision = screenshots.length > 0 ? await import('./visionCli.js') : null;
  const vision = prepareVision
    ? await prepareVision.prepareCliVisionRun({
        provider,
        imagePaths: screenshots,
        prompt,
        model: provider.defaultModel || null,
        effort: provider.effort || null,
      })
    : null;
  const cleanupVisionFiles = vision?.cleanup || (() => Promise.resolve());
  // Build provider-specific args for prompt delivery
  const builtArgs = vision?.invocation.args || buildCliArgs(provider);
  // Rewrite the argv for prompt delivery and learn whether to still write stdin:
  //   - Antigravity (`agy`): prompt spliced in as the --print VALUE (agy doesn't
  //     read stdin) → useStdin=false.
  //   - Grok: `--prompt-file /dev/stdin` on POSIX (fed by the stdin write below),
  //     rewritten to a temp file on Windows → useStdin=false.
  //   - Every other provider: unchanged, prompt over stdin → useStdin=true.
  // cleanupPromptFile removes any temp file after the run (no-op otherwise).
  const promptInput = vision ? vision.invocation.stdin : prompt;
  const { args, useStdin, cleanup: cleanupPromptFile } = vision
    ? { args: builtArgs, useStdin: promptInput != null, cleanup: () => {} }
    : prepareCliPrompt(provider.command, builtArgs, promptInput);
  console.log(`🚀 Executing CLI: ${provider.command} (${prompt.length} chars via ${useStdin ? 'stdin' : 'argv'}${vision ? `, ${screenshots.length} images` : ''})`);

  // Ollama-backed CLIs (claude-ollama, opencode-ollama) reach the daemon
  // themselves, so the toolkit's per-request `num_ctx` never applies to them —
  // hold the daemon at the provider's configured window (or warn) first. See
  // services/ollamaAgentContext.js.
  // Gated on the predicate here (not just inside the helper) so a cloud-provider
  // run — the overwhelmingly common case — takes no async hop at all, and the
  // import sits INSIDE that gate so it never instantiates the daemon manager's
  // subtree either. ~160 suites reach runner.js and none of them run ollama.
  const ollamaContext = isOllamaBackedProvider(provider)
    ? await import('./ollamaAgentContext.js')
      .then(({ ensureOllamaAgentContext }) => ensureOllamaAgentContext(provider, { model: provider.defaultModel ?? null }))
    : null;
  if (ollamaContext?.warning) onData?.(`${ollamaContext.warning}\n`);

  // Shared composition (provider.envVars + OpenCode models map + PWD pin +
  // CLAUDECODE strip) — see buildCliChildEnv. `guard: true` prepends the pm2
  // shim onto the final PATH so an unrestricted agent can't `pm2 kill` the
  // shared daemon.
  const childEnv = buildCliChildEnv({
    provider,
    cwd: vision?.invocation.cwd || effectiveCwd,
    guard: true,
  });

  // See the executeCliRun docblock above for why this is a resolve+wrap, not
  // a shell:true. Resolved against `childEnv` (not bare process.env) so a
  // provider-configured PATH override is honored.
  const runCommand = vision?.invocation.command || provider.command;
  const runCwd = vision?.invocation.cwd || effectiveCwd;
  const resolvedCommand = resolveWindowsExecutable(runCommand, undefined, childEnv) || runCommand;
  const { command: spawnCommand, args: spawnArgs } = prepareWindowsSafeSpawn(resolvedCommand, args);

  childProcess = spawn(spawnCommand, spawnArgs, {
    cwd: runCwd,
    env: childEnv
  });

  // Claim the child's 'error' event in the SAME tick as spawn(). Everything
  // between here and the terminal handlers below — stdin delivery, the
  // external-run registration, the onRunStarted hook — can throw, and a throw
  // there leaves a live registered child whose 'error' has no listener; Node
  // re-throws an unhandled ChildProcess 'error' and kills the server process.
  // Buffer until the real handler is wired, then replay it exactly once
  // (same shape as `spawnDirectly` in agentCliSpawning.js).
  let pendingSpawnError = null;
  let handleSpawnError = null;
  childProcess.on('error', (err) => {
    if (handleSpawnError) handleSpawnError(err);
    else pendingSpawnError = err;
  });

  // Guard the stdin pipe BEFORE writing: a child that exits before reading it
  // (bad flag, missing CLI) emits EPIPE, and an unlistened stream 'error' out
  // here crashes the server. The 'error'/'close' handlers below settle the run.
  guardChildStdin(childProcess);

  // Pass prompt via stdin to avoid OS argv limits. When grok is delivered via a
  // Windows temp file (useStdin === false) the prompt is already on disk, so
  // just close stdin.
  deliverChildStdin(childProcess, useStdin ? promptInput : null, `run ${runId}`);

  // Track active run via the toolkit's declared external-run registry so its
  // stopRun/isRunActive/deleteRun account for this host-spawned child process.
  toolkit.services.runner.registerExternalRun(runId, childProcess);

  // Call hooks — isolated like every other hook invocation here: a throw would
  // otherwise reject executeCliRun with the child already spawned and
  // registered, leaving the run permanently non-terminal.
  safeSettle(
    () => runnerConfig.hooks?.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel }),
    `Run ${runId} onRunStarted hook`,
  );

  // Set timeout (default 5 min, guard against undefined which would fire immediately)
  const effectiveTimeout = timeout ?? provider.timeout ?? 300000;
  const timeoutHandle = effectiveTimeout > 0 ? setTimeout(() => {
    if (childProcess && !childProcess.killed) {
      console.log(`⏱️ Run ${runId} timed out after ${effectiveTimeout}ms`);
      // Record the verdict BEFORE the kill: the close handler cannot otherwise
      // tell this SIGKILL apart from a provider failure, and killProcessTree
      // leaves `exitCode: null` — not the 124 the TUI runner synthesizes for
      // the same condition.
      timeoutError = `CLI run timed out after ${effectiveTimeout}ms`;
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
  const finalizeTerminal = async ({ exitCode, signal = null, spawnError = null }) => {
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
    // Record the cwd the child ACTUALLY ran in, not the requested one — when no
    // workspace was selected these differ, and the /runs replay claiming a
    // workspace the run never used is the confusion this fixes (#3180).
    metadata.workspacePath ??= effectiveCwd;

    // Consume before unregistering: unregisterExternalRun deliberately clears
    // stale markers, while this close event is the one place that can turn the
    // marker into a canceled terminal outcome.
    const stopRequested = toolkit.services.runner.consumeExternalRunStop?.(runId) === true;
    const hostInterrupted = !!signal && isHostShuttingDown();
    const canceled = !spawnError && !immediateFallbackAnalysis && (stopRequested || hostInterrupted);

    try {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      toolkit.services.runner.unregisterExternalRun(runId);
      cleanupPromptFile();
      await cleanupVisionFiles().catch((error) => console.error(`❌ Failed to clean CLI vision files: ${error.message}`));
      if (spawnError) console.error(`❌ Run ${runId} spawn error: ${spawnError.message}`);

      await writeFileGuarded(outputPath, output);

      metadata.endTime = new Date().toISOString();
      metadata.duration = Date.now() - startTime;
      metadata.exitCode = exitCode;
      metadata.success = spawnError ? false : exitCode === 0 && !immediateFallbackAnalysis && !canceled;
      metadata.outputSize = Buffer.byteLength(output);

      if (spawnError) {
        metadata.error = describeSpawnFailure(spawnError, provider.command);
        metadata.errorCategory = 'spawn_error';
      } else if (canceled) {
        metadata.canceled = true;
        metadata.completionReason = hostInterrupted ? 'host-shutdown' : 'canceled';
        metadata.error = hostInterrupted
          ? `CLI interrupted by PortOS shutdown${signal ? ` (signal ${signal})` : ''}`
          : `CLI canceled${signal ? ` (signal ${signal})` : ''}`;
        metadata.errorCategory = ERROR_CATEGORIES.CANCELED;
      } else if (!metadata.success && toolkit.services.errorDetection) {
        // A mid-stream fallback signal (e.g. usage-limit hit) SIGTERM-kills the
        // child; even an exit 0 must remain a failure so fallback can run.
        //
        // Our own wall-clock timeout is authoritative about WHY the child died,
        // so analyze that message rather than the output — the same guard
        // `finalizeRunRecord` applies to exit 124 for TUI runs. Codex echoes the
        // whole prompt to stdout, so scanning `output` for a category let one
        // word of story prose ("…without demanding credit.") match the
        // billing/credit pattern and file a plain 5-minute timeout as
        // `quota-exceeded`: a healthy provider benched and an investigation task
        // spawned over a run that simply needed longer (#3726).
        // A mid-stream signal outranks the clock in both places: it names a
        // specific provider condition, where the timeout only says the run ran
        // out of time — and the two can coexist if the deadline lands between
        // the signal's kill and the child's close.
        const timedOut = !!timeoutError && !immediateFallbackAnalysis;
        if (timedOut) metadata.completionReason = 'timeout';
        const errorAnalysis = immediateFallbackAnalysis
          || toolkit.services.errorDetection.analyzeError(timedOut ? timeoutError : output, exitCode);
        metadata.error = errorAnalysis.message || `Process exited with code ${exitCode}`;
        metadata.errorCategory = errorAnalysis.category;
        metadata.errorAnalysis = errorAnalysis;
      }

      await atomicWrite(metadataPath, metadata);

      // Isolate lifecycle hooks from onComplete so a hook failure never changes
      // the terminal result or prevents the caller from settling.
      if (metadata.success) {
        safeSettle(() => runnerConfig.hooks?.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
      } else if (!canceled) {
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
        ...(canceled ? { canceled: true, completionReason: hostInterrupted ? 'host-shutdown' : 'canceled' } : {}),
      };
      if (!canceled) {
        safeSettle(() => runnerConfig.hooks?.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
      }
      safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
      return failMetadata;
    }
  };
  const finalizeOnce = (terminal) => {
    if (!finalizationPromise) finalizationPromise = finalizeTerminal(terminal);
    return finalizationPromise;
  };

  handleSpawnError = (err) => {
    void finalizeOnce({ exitCode: -1, spawnError: err });
  };

  childProcess.on('close', (code, signal) => {
    void finalizeOnce({ exitCode: code, signal });
  });

  // A failed spawn emits 'error' and commonly 'close' after it; finalizeOnce
  // is idempotent, so replaying the buffered error here settles the run and
  // the later 'close' is a no-op.
  if (pendingSpawnError) handleSpawnError(pendingSpawnError);

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

/**
 * Consume the toolkit's one-shot marker that says stopRun initiated this
 * external child/PTY exit. The TUI runner reads it inside onExit before its
 * normal cleanup unregisters the run.
 */
export function consumeRunStopRequested(runId) {
  return getAIToolkitInstance()?.services?.runner?.consumeExternalRunStop?.(runId) === true;
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
