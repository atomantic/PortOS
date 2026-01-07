import { mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getProviderById } from './providers.js';
import { errorEvents } from '../lib/errorHandler.js';
import { recordSession, recordMessages } from './usage.js';
import {
  isRunnerAvailable,
  executeCliRunViaRunner,
  isRunActiveInRunner,
  stopRunViaRunner,
  initCosRunnerConnection,
  onCosRunnerEvent,
  getActiveRunsFromRunner
} from './cosRunnerClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const RUNS_DIR = join(DATA_DIR, 'runs');

/**
 * Safe JSON parse with fallback to empty object
 */
function safeJsonParse(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Track active runs for cancellation (only used for API runs, CLI runs are in cos-runner)
const activeRuns = new Map();

// Track pending callbacks for runs delegated to cos-runner
const pendingRunCallbacks = new Map();

// Initialize cos-runner connection and event handlers
let cosRunnerInitialized = false;

function initRunnerEvents() {
  if (cosRunnerInitialized) return;
  cosRunnerInitialized = true;

  initCosRunnerConnection();

  // Handle reconnection - sync active runs to detect completions we may have missed
  onCosRunnerEvent('connection:ready', async () => {
    await syncActiveRuns();
  });

  // Handle run output from cos-runner
  onCosRunnerEvent('run:data', ({ runId, text }) => {
    const callbacks = pendingRunCallbacks.get(runId);
    if (callbacks?.onData) {
      callbacks.onData(text);
    }
  });

  // Handle run completion from cos-runner
  onCosRunnerEvent('run:complete', async ({ runId, exitCode, success, duration }) => {
    const callbacks = pendingRunCallbacks.get(runId);
    if (callbacks) {
      // Read the final metadata and update it
      const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
      const outputPath = join(RUNS_DIR, runId, 'output.txt');

      const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
      const output = await readFile(outputPath, 'utf-8').catch(() => '');

      metadata.endTime = new Date().toISOString();
      metadata.duration = duration;
      metadata.exitCode = exitCode;
      metadata.success = success;
      metadata.outputSize = Buffer.byteLength(output);

      // Record usage for successful runs (estimate ~4 chars per token)
      if (success && metadata.providerId && metadata.model) {
        const estimatedTokens = Math.ceil(output.length / 4);
        recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens).catch(err => {
          console.error(`❌ Failed to record usage: ${err.message}`);
        });
      }

      // Extract and store error details for failed runs
      if (!success) {
        const errorDetails = extractErrorDetails(output, exitCode);
        const { category, suggestion } = categorizeError(output, exitCode);
        metadata.error = errorDetails;
        metadata.errorDetails = errorDetails;
        metadata.errorCategory = category;
        metadata.suggestedFix = suggestion;
        console.log(`🔴 Run ${runId} failed with exit code ${exitCode}, category: ${category}`);
        emitProviderError(metadata, errorDetails, output);
      }

      await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      if (callbacks.onComplete) {
        callbacks.onComplete(metadata);
      }

      pendingRunCallbacks.delete(runId);
    }
  });

  // Handle run errors from cos-runner
  onCosRunnerEvent('run:error', async ({ runId, error }) => {
    const callbacks = pendingRunCallbacks.get(runId);
    if (callbacks) {
      const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
      const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));

      metadata.endTime = new Date().toISOString();
      metadata.success = false;
      metadata.error = error;
      metadata.errorDetails = error;
      const { category, suggestion } = categorizeError(error, -1);
      metadata.errorCategory = category;
      metadata.suggestedFix = suggestion;

      emitProviderError(metadata, error, '');

      await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      if (callbacks.onComplete) {
        callbacks.onComplete(metadata);
      }

      pendingRunCallbacks.delete(runId);
    }
  });
}

/**
 * Categorize errors into actionable types
 */
function categorizeError(output, exitCode) {
  const lowerOutput = output.toLowerCase();

  // API/Model errors - check specific patterns first
  if (lowerOutput.includes('not_found_error') && lowerOutput.includes('model:')) {
    return { category: 'model_not_found', suggestion: 'The specified model does not exist - check AI provider settings and select a valid model' };
  }
  if (lowerOutput.includes('model:') && (lowerOutput.includes('not_found') || lowerOutput.includes('not found'))) {
    return { category: 'model_not_found', suggestion: 'Check AI provider settings - the model may be invalid or deprecated' };
  }
  if (lowerOutput.includes('api error') || lowerOutput.includes('api_error')) {
    return { category: 'api_error', suggestion: 'API request failed - check provider endpoint and API key' };
  }

  // Authentication errors
  if (lowerOutput.includes('unauthorized') || lowerOutput.includes('401') || lowerOutput.includes('invalid_api_key') || lowerOutput.includes('authentication failed')) {
    return { category: 'auth_error', suggestion: 'Authentication failed - verify API key is valid and has correct permissions' };
  }

  // Rate limiting
  if (lowerOutput.includes('rate limit') || lowerOutput.includes('429') || lowerOutput.includes('too many requests') || lowerOutput.includes('rate_limit_error')) {
    return { category: 'rate_limit', suggestion: 'Rate limited - wait before retrying or upgrade API plan' };
  }

  // Quota/billing
  if (lowerOutput.includes('quota') || lowerOutput.includes('billing') || lowerOutput.includes('exceeded') || lowerOutput.includes('insufficient')) {
    return { category: 'quota_exceeded', suggestion: 'Quota or billing issue - check your API account' };
  }

  // Network errors
  if (lowerOutput.includes('connection refused') || lowerOutput.includes('econnrefused') || lowerOutput.includes('network error')) {
    return { category: 'network_error', suggestion: 'Network error - check internet connection and endpoint URL' };
  }
  if (lowerOutput.includes('timeout') || lowerOutput.includes('etimedout')) {
    return { category: 'timeout', suggestion: 'Request timed out - try again or increase timeout setting' };
  }

  // Command/CLI errors - be more specific to avoid false positives
  if (lowerOutput.includes('command not found') || lowerOutput.includes('enoent')) {
    return { category: 'command_not_found', suggestion: 'Command not found - verify CLI tool is installed' };
  }
  if (lowerOutput.includes('permission denied')) {
    return { category: 'permission_denied', suggestion: 'Permission denied - check file/directory permissions' };
  }

  // Process signals
  if (exitCode === 143) {
    return { category: 'terminated', suggestion: 'Process was terminated (SIGTERM) - likely hit timeout or was manually stopped' };
  }
  if (exitCode === 137) {
    return { category: 'killed', suggestion: 'Process was killed (SIGKILL) - likely out of memory or force stopped' };
  }
  if (exitCode === 130) {
    return { category: 'interrupted', suggestion: 'Process was interrupted (SIGINT)' };
  }

  return { category: 'unknown', suggestion: 'Check the output above for specific error details' };
}

/**
 * Extract meaningful error details from CLI output
 * Looks for common error patterns and extracts actionable info
 */
function extractErrorDetails(output, exitCode) {
  const lines = output.split('\n').filter(l => l.trim());
  const lastLines = lines.slice(-20); // Last 20 lines often contain error info

  // Try to extract error message from JSON-like structure
  // This handles API responses like: {"type":"error","error":{"type":"not_found_error","message":"model: codex"}}
  const messageMatch = output.match(/"message"\s*:\s*"([^"]+)"/);
  if (messageMatch) {
    // Also try to get the error type for more context
    const typeMatch = output.match(/"type"\s*:\s*"([^"]+_error)"/);
    if (typeMatch) {
      return `${typeMatch[1]}: ${messageMatch[1]}`;
    }
    return messageMatch[1];
  }

  // Look for common error patterns
  const errorPatterns = [
    /API Error[:\s]+\d+\s*(.+)/i,   // "API Error: 404 {...}"
    /API Error[:\s]+(.+)/i,
    /error[:\s]*\{(.+)\}/i,
    /error[:\s]+(.+)/i,
    /failed[:\s]+(.+)/i,
    /exception[:\s]+(.+)/i,
    /fatal[:\s]+(.+)/i,
    /not found[:\s]+(.+)/i,
    /permission denied[:\s]+(.+)/i,
    /connection refused/i,
    /timeout/i,
    /rate limit/i,
    /invalid.*key/i,
    /unauthorized/i,
    /authentication failed/i,
    /"message"[:\s]*"([^"]+)"/i,
    /"error"[:\s]*"([^"]+)"/i
  ];

  const matchedErrors = [];
  for (const line of lastLines) {
    for (const pattern of errorPatterns) {
      if (pattern.test(line)) {
        matchedErrors.push(line.trim());
        break;
      }
    }
  }

  // If we found specific errors, return them; otherwise return last few lines
  if (matchedErrors.length > 0) {
    return matchedErrors.slice(0, 5).join('\n');
  }

  // Return last 5 non-empty lines as fallback
  return lastLines.slice(-5).join('\n') || `Process exited with code ${exitCode}`;
}

/**
 * Emit an AI provider execution error for autofix handling
 */
function emitProviderError(metadata, errorDetails, output) {
  console.log(`🔴 AI provider execution failed: ${metadata.providerName} - ${metadata.error}`);

  errorEvents.emit('error', {
    code: 'AI_PROVIDER_EXECUTION_FAILED',
    message: `AI provider ${metadata.providerName} execution failed: ${metadata.error}`,
    severity: 'error',
    canAutoFix: true,
    timestamp: Date.now(),
    context: {
      runId: metadata.id,
      provider: metadata.providerName,
      providerId: metadata.providerId,
      model: metadata.model,
      exitCode: metadata.exitCode,
      duration: metadata.duration,
      workspacePath: metadata.workspacePath,
      workspaceName: metadata.workspaceName,
      errorDetails: errorDetails,
      errorCategory: metadata.errorCategory,
      suggestedFix: metadata.suggestedFix,
      promptPreview: metadata.prompt,
      outputTail: output ? output.slice(-2000) : null // Last 2KB of output for context
    }
  });
}

async function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) {
    await mkdir(RUNS_DIR, { recursive: true });
  }
}

export async function createRun(options) {
  const {
    providerId,
    model,
    prompt,
    workspacePath,
    workspaceName
  } = options;

  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new Error('Provider not found');
  }

  if (!provider.enabled) {
    throw new Error('Provider is disabled');
  }

  await ensureRunsDir();

  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir);

  const metadata = {
    id: runId,
    type: 'ai',
    providerId,
    providerName: provider.name,
    model: model || provider.defaultModel,
    workspacePath,
    workspaceName,
    prompt: prompt.substring(0, 500), // Store truncated prompt in metadata
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    exitCode: null,
    success: null,
    error: null,
    outputSize: 0
  };

  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'prompt.txt'), prompt);
  await writeFile(join(runDir, 'output.txt'), '');

  // Record usage session
  recordSession(providerId, provider.name, model || provider.defaultModel).catch(err => {
    console.error(`❌ Failed to record usage session: ${err.message}`);
  });

  return { runId, runDir, provider, metadata };
}

export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete) {
  // Initialize runner events if not already done
  initRunnerEvents();

  // Check if cos-runner is available
  const runnerAvailable = await isRunnerAvailable().catch(() => false);

  if (!runnerAvailable) {
    // Fall back to error - cos-runner must be running
    console.error(`❌ CoS runner not available for run ${runId}`);
    const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    metadata.endTime = new Date().toISOString();
    metadata.success = false;
    metadata.error = 'CoS runner service not available';
    metadata.errorDetails = 'The portos-cos process is not running. Start it with: pm2 start ecosystem.config.cjs';
    metadata.errorCategory = 'service_unavailable';
    metadata.suggestedFix = 'Start the portos-cos process using PM2';
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
    return runId;
  }

  // Build command args (without prompt - cos-runner adds it)
  const args = [...(provider.args || [])];

  console.log(`🔧 Delegating run ${runId} to cos-runner: ${provider.command} ${args.join(' ')}`);

  // Store callbacks for when cos-runner reports completion
  pendingRunCallbacks.set(runId, { onData, onComplete });

  // Execute via cos-runner
  await executeCliRunViaRunner({
    runId,
    command: provider.command,
    args,
    prompt,
    workspacePath: workspacePath || process.cwd(),
    envVars: provider.envVars || {},
    timeout: provider.timeout
  }).catch(async (err) => {
    console.error(`❌ Failed to delegate run ${runId} to cos-runner: ${err.message}`);
    pendingRunCallbacks.delete(runId);

    const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    metadata.endTime = new Date().toISOString();
    metadata.success = false;
    metadata.error = err.message;
    metadata.errorDetails = err.message;
    const { category, suggestion } = categorizeError(err.message, -1);
    metadata.errorCategory = category;
    metadata.suggestedFix = suggestion;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  });

  return runId;
}

export async function executeApiRun(runId, provider, model, prompt, workspacePath, onData, onComplete) {
  const runDir = join(RUNS_DIR, runId);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  const startTime = Date.now();
  let output = '';

  const headers = {
    'Content-Type': 'application/json'
  };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  activeRuns.set(runId, controller);

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: model || provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  }).catch(err => ({ ok: false, error: err.message }));

  if (!response.ok) {
    activeRuns.delete(runId);
    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;

    // Try to extract detailed error info from response
    let errorDetails = response.error || `API error: ${response.status}`;
    let responseBody = null;
    if (response.text) {
      responseBody = await response.text().catch(() => null);
      if (responseBody) {
        // Try to parse as JSON for structured error
        let parsed = null;
        try {
          parsed = JSON.parse(responseBody);
        } catch {
          // Not valid JSON, ignore
        }
        if (parsed?.error?.message) {
          errorDetails = `${response.status}: ${parsed.error.message}`;
        } else if (parsed?.message) {
          errorDetails = `${response.status}: ${parsed.message}`;
        } else if (responseBody.length < 500) {
          errorDetails = `${response.status}: ${responseBody}`;
        }
      }
    }

    metadata.error = errorDetails;
    metadata.errorDetails = errorDetails;
    const { category, suggestion } = categorizeError(errorDetails, response.status || -1);
    metadata.errorCategory = category;
    metadata.suggestedFix = suggestion;

    // Emit error event for autofix system
    emitProviderError(metadata, errorDetails, responseBody);

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
    return runId;
  }

  // Handle streaming response
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const processStream = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Not valid JSON, skip this chunk
          continue;
        }
        if (parsed?.choices?.[0]?.delta?.content) {
          const text = parsed.choices[0].delta.content;
          output += text;
          onData?.(text);
        }
      }
    }

    await writeFile(outputPath, output);
    activeRuns.delete(runId);

    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.exitCode = 0;
    metadata.success = true;
    metadata.outputSize = Buffer.byteLength(output);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Record usage for API run (estimate ~4 chars per token)
    const estimatedTokens = Math.ceil(output.length / 4);
    recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens).catch(err => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });

    onComplete?.(metadata);
  };

  processStream().catch(async (err) => {
    activeRuns.delete(runId);
    const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    metadata.error = err.message;
    metadata.errorDetails = err.message;
    const { category, suggestion } = categorizeError(err.message, -1);
    metadata.errorCategory = category;
    metadata.suggestedFix = suggestion;

    // Emit error event for autofix system
    emitProviderError(metadata, err.message, output);

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  });

  return runId;
}

export async function stopRun(runId) {
  // Check if it's a local API run
  const active = activeRuns.get(runId);
  if (active) {
    if (active.kill) {
      // It's a child process
      active.kill('SIGTERM');
    } else if (active.abort) {
      // It's an AbortController
      active.abort();
    }
    activeRuns.delete(runId);
    return true;
  }

  // Check if it's a CLI run in cos-runner
  const inRunner = await isRunActiveInRunner(runId).catch(() => false);
  if (inRunner) {
    await stopRunViaRunner(runId).catch(() => {});
    pendingRunCallbacks.delete(runId);
    return true;
  }

  return false;
}

export async function getRun(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  const metadata = safeJsonParse(await readFile(join(runDir, 'metadata.json'), 'utf-8').catch(() => '{}'));
  return metadata;
}

export async function getRunOutput(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  return readFile(join(runDir, 'output.txt'), 'utf-8');
}

export async function getRunPrompt(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  return readFile(join(runDir, 'prompt.txt'), 'utf-8');
}

export async function listRuns(limit = 50, offset = 0, source = 'all') {
  await ensureRunsDir();

  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  const runIds = entries
    .filter(e => e.isDirectory())
    .map(e => e.name);

  // Load all metadata and sort by start time
  const runs = [];
  for (const runId of runIds) {
    const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
      if (metadata.id) runs.push(metadata);
    }
  }

  // Filter by source if specified
  let filteredRuns = runs;
  if (source !== 'all') {
    filteredRuns = runs.filter(run => {
      const runSource = run.source || 'devtools'; // Legacy runs without source are from devtools
      return runSource === source;
    });
  }

  filteredRuns.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  return {
    total: filteredRuns.length,
    runs: filteredRuns.slice(offset, offset + limit)
  };
}

export async function deleteRun(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return false;
  }

  await rm(runDir, { recursive: true });
  return true;
}

export async function deleteFailedRuns() {
  await ensureRunsDir();

  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);

  let deletedCount = 0;
  for (const runId of runIds) {
    const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
      if (metadata.success === false) {
        await rm(join(RUNS_DIR, runId), { recursive: true });
        deletedCount++;
      }
    }
  }

  return deletedCount;
}

export async function isRunActive(runId) {
  // Check local API runs first
  if (activeRuns.has(runId)) {
    return true;
  }
  // Check if it's a CLI run in cos-runner
  if (pendingRunCallbacks.has(runId)) {
    return true;
  }
  // Double-check with cos-runner (in case of reconnect)
  return isRunActiveInRunner(runId).catch(() => false);
}

/**
 * Sync active runs from cos-runner on reconnection
 * This handles runs that may have completed while we were disconnected
 */
async function syncActiveRuns() {
  // Check all pending runs to see if they're still active in the runner
  const pendingRunIds = Array.from(pendingRunCallbacks.keys());
  if (pendingRunIds.length === 0) {
    return;
  }

  console.log(`🔄 Syncing ${pendingRunIds.length} pending runs with cos-runner...`);

  // Get list of active runs from the runner
  const activeInRunner = await getActiveRunsFromRunner().catch(() => []);
  const activeRunIds = new Set(activeInRunner.map(r => r.id));

  // Check for runs that have completed while we were disconnected
  for (const runId of pendingRunIds) {
    if (!activeRunIds.has(runId)) {
      // This run is no longer active in the runner - it may have completed
      // Check if we have output written to disk (cos-runner writes output.txt on completion)
      const outputPath = join(RUNS_DIR, runId, 'output.txt');
      const metadataPath = join(RUNS_DIR, runId, 'metadata.json');

      if (existsSync(outputPath) && existsSync(metadataPath)) {
        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));

        // If endTime is set, the run completed - we missed the event
        if (metadata.endTime) {
          console.log(`📥 Recovered completed run ${runId} (completed while disconnected)`);
          const callbacks = pendingRunCallbacks.get(runId);
          if (callbacks?.onComplete) {
            callbacks.onComplete(metadata);
          }
          pendingRunCallbacks.delete(runId);
        } else {
          // Run output exists but no endTime - run is likely stuck or orphaned
          // Mark it as failed
          console.log(`⚠️ Run ${runId} appears orphaned - marking as failed`);
          metadata.endTime = new Date().toISOString();
          metadata.success = false;
          metadata.error = 'Run was orphaned (process ended without proper completion)';
          metadata.errorCategory = 'orphaned';
          metadata.suggestedFix = 'The run process ended unexpectedly. Try again.';
          await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

          const callbacks = pendingRunCallbacks.get(runId);
          if (callbacks?.onComplete) {
            callbacks.onComplete(metadata);
          }
          pendingRunCallbacks.delete(runId);
        }
      }
    }
  }
}
