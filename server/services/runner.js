/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions with local overrides
 */
import { spawn } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, tryReadFile } from '../lib/fileUtils.js';
import { resolveCliModel, hasModelFlag, extractBakedModel } from '../lib/providerModels.js';
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

// Runner-only state. The toolkit singleton itself lives in
// `lib/aiToolkitState.js` and is shared with providers / promptService;
// `runnerConfig` (dataDir + hooks) is captured here because only the runner
// needs it.
let runnerConfig = { dataDir: './data', hooks: {} };

export function setAIToolkit(toolkit, config = {}) {
  setAIToolkitInstance(toolkit);
  runnerConfig = { dataDir: config.dataDir || './data', hooks: config.hooks || {} };
}

export async function createRun(options) {
  // The toolkit's runner emits its own "🤖 AI run [source]: provider/model"
  // line — don't duplicate it here.
  return requireToolkit().services.runner.createRun(options);
}

/**
 * Build CLI args based on provider type.
 * Each CLI provider has different conventions for stdin input and model
 * selection. `provider.defaultModel` is honored for all three (codex /
 * claude-code / gemini-cli) so a per-call clone with an overridden
 * defaultModel (e.g. modal-selected "thinking" tier in Refine Prompt)
 * actually picks the modal-selected model instead of falling back to
 * whatever's baked into `provider.args`.
 *
 * Model-flag injection is GATED on `provider.args` not already containing
 * a model flag — users who hard-coded e.g. `--model gemini-2.5-pro` in
 * their saved provider config keep that override and don't get a
 * duplicate flag from us.
 */
export function buildCliArgs(provider) {
  const providerId = provider?.id || '';
  // Sanitize: drop any broken/dangling `--model` / `-m` tokens before
  // appending. hasModelFlag treats those as "not a real pin" so the
  // injection path fires — but if we kept the bogus token in baseArgs the
  // CLI would still see two `--model` occurrences and reject the argv.
  const baseArgs = stripBrokenModelFlags(Array.isArray(provider?.args) ? provider.args : []);
  const effectiveDefaultModel = providerId === 'codex'
    ? resolveCliModel(provider.defaultModel)
    : provider.defaultModel;

  // Codex CLI: `codex exec -` reads prompt from stdin, --model for model.
  // Detect an existing leading `exec` in user/legacy args so we don't end up
  // running `codex exec --full-auto exec -` after migration of legacy
  // configs that already pinned an `exec` subcommand.
  if (providerId === 'codex') {
    const hasExec = baseArgs.includes('exec');
    const args = hasExec ? [...baseArgs] : [...baseArgs, 'exec'];
    if (effectiveDefaultModel) {
      args.push('--model', effectiveDefaultModel);
    }
    args.push('-'); // stdin marker
    return args;
  }

  // Gemini CLI: prompt is piped via stdin directly. `-m <model>` is gemini-
  // cli's documented short flag for model selection (long form: `--model`).
  // Skip injection when the user's saved args already pin a model (either
  // form) so we don't duplicate the flag.
  if (providerId === 'gemini-cli') {
    const args = [...baseArgs];
    if (effectiveDefaultModel && !hasModelFlag(baseArgs)) {
      args.push('-m', effectiveDefaultModel);
    }
    return args;
  }

  // Default (Claude Code CLI): `-p -` means "read prompt from stdin".
  // `--model <id>` is claude-code's model flag; it parses flags
  // positionally so appending after `-p -` is fine. Same gate as gemini-
  // cli — respect user-baked model flags.
  const args = [...baseArgs, '-p', '-'];
  if (effectiveDefaultModel && !hasModelFlag(baseArgs)) {
    args.push('--model', effectiveDefaultModel);
  }
  return args;
}

// Strip dangling/empty `--model` / `-m` tokens (no value follows, or the
// joined form has an empty value). Those would survive into the spawned
// argv unchanged and cause the CLI to reject the invocation — see the
// comment on hasModelFlag for the full reasoning. Pinned-with-value tokens
// are preserved untouched so user-baked model selections still win.
function stripBrokenModelFlags(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && (a === '--model=' || a === '-m=')) {
      continue; // empty joined form
    }
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      const hasValue = typeof next === 'string' && next.length > 0 && !next.startsWith('-');
      if (!hasValue) continue; // dangling separated form
    }
    out.push(a);
  }
  return out;
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

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2)).catch(() => {});

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
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2)).catch(() => {});
}

/**
 * Override executeCliRun to fix shell security issue
 * This removes 'shell: true' which causes DEP0190 warning and potential security issues
 */
export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout) {
  const toolkit = requireToolkit();

  const runsPath = join(runnerConfig.dataDir, 'runs');
  const runDir = join(runsPath, runId);
  await ensureDir(runDir);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  const startTime = Date.now();
  let output = '';

  // Build provider-specific args for stdin-based prompt delivery
  const args = buildCliArgs(provider);
  console.log(`🚀 Executing CLI: ${provider.command} (${prompt.length} chars via stdin)`);

  const childProcess = spawn(provider.command, args, {
    cwd: workspacePath,
    env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
    windowsHide: true
  });

  // Pass prompt via stdin to avoid OS argv limits
  childProcess.stdin.write(prompt);
  childProcess.stdin.end();

  // Track active run (store on the runner service itself for stopRun to access)
  if (!toolkit.services.runner._portosActiveRuns) {
    toolkit.services.runner._portosActiveRuns = new Map();
  }
  toolkit.services.runner._portosActiveRuns.set(runId, childProcess);

  // Call hooks
  runnerConfig.hooks?.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel });

  // Set timeout (default 5 min, guard against undefined which would fire immediately)
  const effectiveTimeout = timeout ?? provider.timeout ?? 300000;
  const timeoutHandle = effectiveTimeout > 0 ? setTimeout(() => {
    if (childProcess && !childProcess.killed) {
      console.log(`⏱️ Run ${runId} timed out after ${effectiveTimeout}ms`);
      childProcess.kill('SIGTERM');
    }
  }, effectiveTimeout) : null;

  childProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text);
  });

  childProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text);
  });

  childProcess.on('error', async (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    toolkit.services.runner._portosActiveRuns?.delete(runId);
    console.error(`❌ Run ${runId} spawn error: ${err.message}`);

    const metadata = {
      endTime: new Date().toISOString(),
      duration: Date.now() - startTime,
      exitCode: -1,
      success: false,
      error: `Spawn failed: ${err.message}`,
      errorCategory: 'spawn_error',
      outputSize: Buffer.byteLength(output)
    };

    await writeFile(outputPath, output).catch(() => {});
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2)).catch(() => {});
    runnerConfig.hooks?.onRunFailed?.(metadata, metadata.error, output);
    onComplete?.(metadata);
  });

  childProcess.on('close', async (code) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    toolkit.services.runner._portosActiveRuns?.delete(runId);

    await writeFile(outputPath, output);

    const metadataStr = await readFile(metadataPath, 'utf-8').catch(() => '{}');
    let metadata = {};
    try { metadata = JSON.parse(metadataStr); } catch { console.log('⚠️ Corrupted metadata for run, using fresh'); }
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.exitCode = code;
    metadata.success = code === 0;
    metadata.outputSize = Buffer.byteLength(output);

    // Analyze errors if the run failed (delegate to toolkit's error detection)
    if (!metadata.success && toolkit.services.errorDetection) {
      const errorAnalysis = toolkit.services.errorDetection.analyzeError(output, code);
      metadata.error = errorAnalysis.message || `Process exited with code ${code}`;
      metadata.errorCategory = errorAnalysis.category;
      metadata.errorAnalysis = errorAnalysis;
    }

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    if (metadata.success) {
      runnerConfig.hooks?.onRunCompleted?.(metadata, output);
    } else {
      runnerConfig.hooks?.onRunFailed?.(metadata, metadata.error, output);
    }

    onComplete?.(metadata);
  });

  return runId;
}

export async function executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete) {
  return requireToolkit().services.runner.executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete);
}

/**
 * Register an in-flight run's killable process (ChildProcess or IPty) in the
 * same `_portosActiveRuns` map the patched `stopRun`/`isRunActive` consult.
 * Used by `executeTuiRun` so TUI runs can be stopped from /runs the same way
 * CLI runs can. Both ChildProcess and node-pty IPty expose `.kill(signal?)`.
 */
export function registerActiveRun(runId, killable) {
  const toolkit = requireToolkit();
  if (!toolkit.services.runner._portosActiveRuns) {
    toolkit.services.runner._portosActiveRuns = new Map();
  }
  toolkit.services.runner._portosActiveRuns.set(runId, killable);
}

export function unregisterActiveRun(runId) {
  // No-throw read: cleanup paths may run after the toolkit is gone (e.g.
  // shutdown), so use `getAIToolkitInstance()` rather than `requireToolkit()`.
  getAIToolkitInstance()?.services?.runner?._portosActiveRuns?.delete(runId);
}

export async function stopRun(runId) {
  const toolkit = requireToolkit();
  // Check local active runs first (CLI runs spawned by this override)
  const localProcess = toolkit.services.runner._portosActiveRuns?.get(runId);
  if (localProcess && !localProcess.killed) {
    localProcess.kill('SIGTERM');
    toolkit.services.runner._portosActiveRuns.delete(runId);
    return { stopped: true, runId };
  }
  return toolkit.services.runner.stopRun(runId);
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
