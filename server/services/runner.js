/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions with local overrides
 */
import { spawn } from 'child_process';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir } from '../lib/fileUtils.js';

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;
let runnerConfig = { dataDir: './data', hooks: {} };

export function setAIToolkit(toolkit, config = {}) {
  aiToolkitInstance = toolkit;
  runnerConfig = { dataDir: config.dataDir || './data', hooks: config.hooks || {} };
}

export async function createRun(options) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  // The toolkit's runner emits its own "🤖 AI run [source]: provider/model"
  // line — don't duplicate it here.
  return aiToolkitInstance.services.runner.createRun(options);
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
  const effectiveDefaultModel = providerId === 'codex' && provider.defaultModel === 'codex-configured-default'
    ? null
    : provider.defaultModel;

  // Codex CLI: `codex exec -` reads prompt from stdin, --model for model
  if (providerId === 'codex') {
    const args = [...baseArgs, 'exec'];
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

// Detects whether the provider's stored argv already pins a model with a
// usable value. We check both flag forms (`--model` / `-m`) and both styles
// (separated `--model x` and joined `--model=x`). gemini-cli is the only
// one that uses `-m` short form; checking it on claude-code too is harmless
// (claude-code doesn't define a `-m` short flag).
//
// A separated flag with no value following (`['--model']` at end of argv,
// or `['--model', '--other']`) is treated as NOT a baked-in pin — the CLI
// would reject the argv at runtime anyway, and pretending it's a pin would
// also make refiners report `null` (from extractBakedModel) and skip
// injecting our own model. Better to leave injection on and let
// buildCliArgs fix the broken argv by appending a valid `--model X`.
export function hasModelFlag(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--model=') && a.length > '--model='.length) return true;
    if (a.startsWith('-m=') && a.length > '-m='.length) return true;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return true;
    }
  }
  return false;
}

/**
 * Extract the pinned model id from provider.args when a model flag is baked
 * in. Supports separated form (`--model X` / `-m X`) and joined form
 * (`--model=X` / `-m=X`). Returns null when no model flag is present or the
 * separated form has no value following the flag.
 *
 * Used by refiners (mediaPromptRefiner, worldBuilderRefine) so the model
 * reported back to the caller / persisted on the run record matches what
 * the CLI will actually run when the user has hard-coded a model in args.
 */
export function extractBakedModel(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      // Match hasModelFlag exactly: a value that starts with '-' is the next
      // flag, not the model id. Without this guard, `['--model', '--other']`
      // would extract `'--other'` even though hasModelFlag said "no baked
      // model" — the two would disagree and refiners could mis-report.
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      return null;
    }
    if (a.startsWith('--model=')) return a.slice('--model='.length) || null;
    if (a.startsWith('-m=')) return a.slice('-m='.length) || null;
  }
  return null;
}

/**
 * Override executeCliRun to fix shell security issue
 * This removes 'shell: true' which causes DEP0190 warning and potential security issues
 */
export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');

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
  if (!aiToolkitInstance.services.runner._portosActiveRuns) {
    aiToolkitInstance.services.runner._portosActiveRuns = new Map();
  }
  aiToolkitInstance.services.runner._portosActiveRuns.set(runId, childProcess);

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
    aiToolkitInstance.services.runner._portosActiveRuns?.delete(runId);
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
    aiToolkitInstance.services.runner._portosActiveRuns?.delete(runId);

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
    if (!metadata.success && aiToolkitInstance.services.errorDetection) {
      const errorAnalysis = aiToolkitInstance.services.errorDetection.analyzeError(output, code);
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
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete);
}

export async function stopRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  // Check local active runs first (CLI runs spawned by this override)
  const localProcess = aiToolkitInstance.services.runner._portosActiveRuns?.get(runId);
  if (localProcess && !localProcess.killed) {
    localProcess.kill('SIGTERM');
    aiToolkitInstance.services.runner._portosActiveRuns.delete(runId);
    return { stopped: true, runId };
  }
  return aiToolkitInstance.services.runner.stopRun(runId);
}

export async function getRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRun(runId);
}

export async function getRunOutput(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRunOutput(runId);
}

export async function getRunPrompt(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRunPrompt(runId);
}

export async function listRuns(limit, offset, source) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.listRuns(limit, offset, source);
}

export async function deleteRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.deleteRun(runId);
}

export async function deleteFailedRuns() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.deleteFailedRuns();
}

export async function isRunActive(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.isRunActive(runId);
}
