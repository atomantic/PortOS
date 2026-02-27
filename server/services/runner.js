/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions with local overrides
 */
import { spawn } from 'child_process';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;
let runnerConfig = { dataDir: './data', hooks: {} };

export function setAIToolkit(toolkit, config = {}) {
  aiToolkitInstance = toolkit;
  runnerConfig = { dataDir: config.dataDir || './data', hooks: config.hooks || {} };
}

export async function createRun(options) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  const result = await aiToolkitInstance.services.runner.createRun(options);
  console.log(`🤖 AI run [${options.source || 'unknown'}]: ${result.provider.name}/${result.metadata.model}`);
  return result;
}

/**
 * Build CLI args based on provider type.
 * Each CLI provider has different conventions for stdin input and model selection.
 */
function buildCliArgs(provider) {
  const providerId = provider?.id || '';

  // Codex CLI: `codex exec -` reads prompt from stdin, --model for model
  if (providerId === 'codex') {
    const args = [...(provider.args || []), 'exec'];
    if (provider.defaultModel) {
      args.push('--model', provider.defaultModel);
    }
    args.push('-'); // stdin marker
    return args;
  }

  // Gemini CLI: prompt is piped via stdin directly
  if (providerId === 'gemini-cli') {
    return [...(provider.args || [])];
  }

  // Default (Claude Code CLI): -p - means "read prompt from stdin"
  return [...(provider.args || []), '-p', '-'];
}

/**
 * Override executeCliRun to fix shell security issue
 * This removes 'shell: true' which causes DEP0190 warning and potential security issues
 */
export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');

  const runsPath = join(runnerConfig.dataDir, 'runs');
  const runDir = join(runsPath, runId);
  await mkdir(runDir, { recursive: true });
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  const startTime = Date.now();
  let output = '';

  // Build provider-specific args for stdin-based prompt delivery
  const args = buildCliArgs(provider);
  console.log(`🚀 Executing CLI: ${provider.command} (${prompt.length} chars via stdin)`);

  const childProcess = spawn(provider.command, args, {
    cwd: workspacePath,
    env: { ...process.env, ...provider.envVars, CLAUDECODE: undefined },
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
    try { metadata = JSON.parse(metadataStr); } catch { /* corrupted metadata, start fresh */ }
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
