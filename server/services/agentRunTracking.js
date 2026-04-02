/**
 * Agent Run Tracking
 *
 * Handles creation, completion, and run-level usage recording for CoS agent runs.
 */

import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { recordSession, recordMessages } from './usage.js';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';

const RUNS_DIR = PATHS.runs;

/**
 * Create a run entry for usage tracking.
 */
export async function createAgentRun(agentId, task, model, provider, workspacePath, appName) {
  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);

  if (!existsSync(RUNS_DIR)) {
    await ensureDir(RUNS_DIR);
  }
  await mkdir(runDir);

  const metadata = {
    id: runId,
    type: 'ai',
    source: 'cos-agent',
    agentId,
    taskId: task.id,
    providerId: provider.id,
    providerName: provider.name,
    model: model || provider.defaultModel,
    workspacePath,
    workspaceName: appName || 'portos',
    prompt: (task.description || '').substring(0, 500),
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    exitCode: null,
    success: null,
    error: null,
    outputSize: 0
  };

  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'prompt.txt'), task.description || '');
  await writeFile(join(runDir, 'output.txt'), '');

  // Record usage session for CoS agent
  recordSession(provider.id, provider.name, model || provider.defaultModel).catch(err => {
    console.error(`❌ Failed to record usage session: ${err.message}`);
  });

  return { runId, runDir };
}

/**
 * Check if a commit was made with the task ID.
 * Returns true if a recent commit contains [task-{taskId}].
 * Returns false if git command fails (not a repo, git not available, etc.)
 */
export function checkForTaskCommit(taskId, workspacePath) {
  // Check if it's a git repo first
  const gitDir = join(workspacePath, '.git');
  if (!existsSync(gitDir)) return false;

  try {
    const searchPattern = `[task-${taskId}]`;
    const result = execSync(`git log --all --oneline --grep="${searchPattern}" -1`, {
      cwd: workspacePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    }).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Complete a run entry with final results.
 */
export async function completeAgentRun(runId, output, exitCode, duration, errorAnalysis = null) {
  if (!runId) return; // Skip if no runId (e.g., agent recovered after restart)

  const runDir = join(RUNS_DIR, runId);
  const metaPath = join(runDir, 'metadata.json');

  const metadata = await readJSONFile(metaPath, null);
  if (!metadata) return;

  metadata.endTime = new Date().toISOString();
  metadata.duration = duration;
  metadata.exitCode = exitCode;

  // Post-execution validation: check for task commit even if exit code is non-zero
  let success = exitCode === 0;
  if (!success && metadata.taskId && metadata.workspacePath) {
    const commitFound = checkForTaskCommit(metadata.taskId, metadata.workspacePath);
    if (commitFound) {
      console.log(`⚠️ Agent ${metadata.agentId} reported failure (exit ${exitCode}) but work completed - commit found for task ${metadata.taskId}`);
      success = true;
    }
  }

  metadata.success = success;
  metadata.outputSize = Buffer.byteLength(output || '');

  // Store error details - extract from output if no analysis provided
  if (exitCode !== 0) {
    const errorInfo = errorAnalysis || extractErrorFromOutput(output, exitCode);
    metadata.error = errorInfo.message || `Process exited with code ${exitCode}`;
    metadata.errorDetails = errorInfo.details || metadata.error;
    metadata.errorCategory = errorInfo.category || 'unknown';
    metadata.suggestedFix = errorInfo.suggestedFix || null;
    if (errorInfo.compaction) {
      metadata.compaction = errorInfo.compaction;
    }
  }

  await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'output.txt'), output || '');

  // Record usage for successful CoS agent runs (estimate ~4 chars per token)
  if (exitCode === 0 && metadata.providerId && metadata.model) {
    const estimatedTokens = Math.ceil((output || '').length / 4);
    recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens).catch(err => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });
  }
}

/**
 * Extract error information from output when no pattern matches.
 */
export function extractErrorFromOutput(output, exitCode) {
  if (!output || output.trim().length === 0) {
    // Map common exit codes to readable messages
    const exitCodeMessages = {
      1: 'General error',
      2: 'Misuse of shell command',
      126: 'Command invoked cannot execute (permission or not executable)',
      127: 'Command not found',
      128: 'Invalid exit argument',
      130: 'Script terminated by Ctrl+C',
      137: 'Process killed (SIGKILL)',
      143: 'Process terminated (SIGTERM - likely timeout)',
      255: 'Exit status out of range'
    };
    const codeMsg = exitCodeMessages[exitCode] || `Unknown error`;
    return {
      message: `${codeMsg} (exit code ${exitCode})`,
      details: `Process exited with code ${exitCode}. No output was captured.`,
      category: exitCode === 143 ? 'timeout' : 'unknown'
    };
  }

  const lines = output.split('\n').filter(l => l.trim());
  const lastLines = lines.slice(-20);

  // Look for common error patterns
  const errorPatterns = [
    { pattern: /API Error:\s*(\d+)/i, category: 'api-error' },
    { pattern: /error[:\s]+(.+)/i, category: 'error' },
    { pattern: /failed[:\s]+(.+)/i, category: 'failure' },
    { pattern: /exception[:\s]+(.+)/i, category: 'exception' },
    { pattern: /fatal[:\s]+(.+)/i, category: 'fatal' },
    { pattern: /not found/i, category: 'not-found' },
    { pattern: /permission denied/i, category: 'permission' },
    { pattern: /connection refused/i, category: 'connection' },
    { pattern: /timeout/i, category: 'timeout' },
    { pattern: /rate limit/i, category: 'rate-limit' },
    { pattern: /invalid.*key/i, category: 'auth' },
    { pattern: /unauthorized/i, category: 'auth' },
    { pattern: /authentication failed/i, category: 'auth' }
  ];

  const matchedErrors = [];
  let category = 'unknown';
  for (const line of lastLines) {
    for (const { pattern, category: cat } of errorPatterns) {
      if (pattern.test(line)) {
        matchedErrors.push(line.trim());
        if (category === 'unknown') category = cat;
        break;
      }
    }
  }

  // Use matched errors or fallback to last lines
  const errorLines = matchedErrors.length > 0
    ? matchedErrors.slice(0, 5)
    : lastLines.slice(-5);

  return {
    message: errorLines[0] || `Process exited with code ${exitCode}`,
    details: errorLines.join('\n') || `Process exited with code ${exitCode}`,
    category
  };
}
