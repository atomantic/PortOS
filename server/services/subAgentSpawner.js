/**
 * Sub-Agent Spawner Service
 *
 * Spawns Claude CLI instances to work on tasks with unrestricted mode
 * and MCP server integration. Includes intelligent model selection
 * and usage tracking.
 */

import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { cosEvents, registerAgent, updateAgent, completeAgent, appendAgentOutput, getConfig, updateTask, addTask, emitLog } from './cos.js';
import { startAppCooldown, markAppReviewCompleted } from './appActivity.js';
import { isRunnerAvailable, spawnAgentViaRunner, terminateAgentViaRunner, killAgentViaRunner, getAgentStatsFromRunner, initCosRunnerConnection, onCosRunnerEvent, getActiveAgentsFromRunner, getRunnerHealth } from './cosRunnerClient.js';
import { getActiveProvider, getProviderById, getAllProviders } from './providers.js';
import { recordSession, recordMessages } from './usage.js';
import { isProviderAvailable, markProviderUsageLimit, markProviderRateLimited, getFallbackProvider, getProviderStatus, initProviderStatus } from './providerStatus.js';
import { buildPrompt } from './promptService.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { getMemorySection } from './memoryRetriever.js';
import { extractAndStoreMemories } from './memoryExtractor.js';
import { getDigitalTwinForPrompt } from './digital-twin.js';
import { suggestModelTier } from './taskLearning.js';
import { readJSONFile } from '../lib/fileUtils.js';
import { createToolExecution, startExecution, updateExecution, completeExecution, errorExecution, getExecution, getStats as getToolStats } from './toolStateMachine.js';
import { resolveThinkingLevel, getModelForLevel, isLocalPreferred } from './thinkingLevels.js';
import { determineLane, acquire, release, hasCapacity, waitForLane } from './executionLanes.js';
import { detectConflicts } from './taskConflict.js';
import { createWorktree, removeWorktree, cleanupOrphanedWorktrees } from './worktreeManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../../');
const AGENTS_DIR = join(__dirname, '../../data/cos/agents');
const RUNS_DIR = join(__dirname, '../../data/runs');

/**
 * Extract task type key for learning lookup
 * Matches the format used in taskLearning.js for consistency
 */
function extractTaskTypeKey(task) {
  if (task?.metadata?.analysisType) {
    return `self-improve:${task.metadata.analysisType}`;
  }
  if (task?.metadata?.reviewType === 'idle') {
    return 'idle-review';
  }
  const desc = (task?.description || '').toLowerCase();
  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*(\w+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
  }
  if (task?.taskType === 'user') return 'user-task';
  return 'unknown';
}

/**
 * Select optimal model for a task based on complexity analysis and historical performance
 * User can override by specifying Model: and/or Provider: in task metadata
 *
 * Enhanced with:
 * - Thinking levels hierarchy (task → agent → provider)
 * - Learning-based model suggestions from historical success rates
 * - Automatic upgrades when task type has <60% success rate
 */
async function selectModelForTask(task, provider, agent = {}) {
  const desc = (task.description || '').toLowerCase();
  const context = task.metadata?.context || '';
  const contextLen = context.length;
  const priority = task.priority || 'MEDIUM';

  // Check for user-specified model preference (highest priority)
  const userModel = task.metadata?.model;
  const userProvider = task.metadata?.provider;

  if (userModel) {
    console.log(`👤 User specified model: ${userModel}`);
    return {
      model: userModel,
      tier: 'user-specified',
      reason: 'user-preference',
      userProvider: userProvider || null
    };
  }

  // Check thinking level hierarchy (task → agent → provider)
  // This resolves the appropriate thinking level based on configuration hierarchy
  const thinkingResult = resolveThinkingLevel(task, agent, provider);
  if (thinkingResult.resolvedFrom !== 'default') {
    const modelFromLevel = getModelForLevel(thinkingResult.level, provider);
    if (modelFromLevel) {
      const isLocal = isLocalPreferred(thinkingResult.level);
      console.log(`🧠 Thinking level: ${thinkingResult.level} → ${modelFromLevel} (from ${thinkingResult.resolvedFrom}${isLocal ? ', local-preferred' : ''})`);
      return {
        model: modelFromLevel,
        tier: thinkingResult.level,
        reason: `thinking-level-${thinkingResult.resolvedFrom}`,
        thinkingLevel: thinkingResult.level,
        localPreferred: isLocal
      };
    }
  }

  // Image/visual analysis → would route to gemini if available
  if (/image|screenshot|visual|photo|picture/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'visual-analysis' };
  }

  // Critical priority → always use opus/heavy
  if (priority === 'CRITICAL') {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'critical-priority' };
  }

  // Complex reasoning tasks → opus/heavy
  if (/architect|refactor|design|complex|optimize|security|audit|review.*code|performance/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'complex-task' };
  }

  // Long context → needs more capable model
  if (contextLen > 500) {
    return { model: provider.heavyModel || provider.mediumModel || provider.defaultModel, tier: 'heavy', reason: 'long-context' };
  }

  // Detect coding/development tasks - these should NEVER use light model
  // Intentionally inclusive: if a task mentions any coding-related term (even in
  // broader context like "bug report template"), we err on the side of using
  // a stronger model since misclassifying a coding task is more costly than
  // over-allocating resources for a documentation task.
  const isCodingTask = /\b(fix|bug|implement|develop|code|refactor|test|feature|function|class|module|api|endpoint|component|service|route|schema|migration|script|build|deploy|debug|error|exception|crash|issue|patch)\b/.test(desc);

  // Simple/quick tasks → haiku/light (ONLY for non-coding tasks)
  // Light model is reserved for documentation, text updates, and formatting only
  if (!isCodingTask && /fix typo|update text|update docs|edit readme|update readme|write docs|documentation only|format text/.test(desc)) {
    return { model: provider.lightModel || provider.defaultModel, tier: 'light', reason: 'documentation-task' };
  }

  // Check historical performance for this task type and potentially upgrade model
  const taskTypeKey = extractTaskTypeKey(task);
  const learningSuggestion = await suggestModelTier(taskTypeKey).catch(() => null);

  if (learningSuggestion && learningSuggestion.suggested === 'heavy') {
    console.log(`📊 Learning-based upgrade: ${taskTypeKey} → heavy (${learningSuggestion.reason})`);
    return {
      model: provider.heavyModel || provider.defaultModel,
      tier: 'heavy',
      reason: 'learning-suggested',
      learningReason: learningSuggestion.reason
    };
  }

  // Standard tasks → use provider's default model
  return { model: provider.defaultModel, tier: 'default', reason: 'standard-task' };
}

/**
 * Create a run entry for usage tracking
 */
async function createAgentRun(agentId, task, model, provider, workspacePath) {
  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);

  if (!existsSync(RUNS_DIR)) {
    await mkdir(RUNS_DIR, { recursive: true });
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
    workspaceName: task.metadata?.app || 'portos',
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
 * Check if a commit was made with the task ID
 * Returns true if a recent commit contains [task-{taskId}]
 * Returns false if git command fails (not a repo, git not available, etc.)
 */
function checkForTaskCommit(taskId, workspacePath = ROOT_DIR) {
  // Check if it's a git repo first
  const gitDir = join(workspacePath, '.git');
  if (!existsSync(gitDir)) return false;

  const searchPattern = `[task-${taskId}]`;
  const gitLogCmd = `git log --all --oneline --grep="${searchPattern}" -1 2>/dev/null || true`;
  const result = execSync(gitLogCmd, { cwd: workspacePath, encoding: 'utf-8' }).trim();
  return result.length > 0;
}

/**
 * Complete a run entry with final results
 */
async function completeAgentRun(runId, output, exitCode, duration, errorAnalysis = null) {
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
 * Extract error information from output when no pattern matches
 */
function extractErrorFromOutput(output, exitCode) {
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

/**
 * Process post-completion tasks: memory extraction and app cooldown
 * Shared between handleAgentCompletion (runner mode) and spawnDirectly (direct mode)
 */
async function processAgentCompletion(agentId, task, success, outputBuffer) {
  // Extract memories from successful output
  if (success && outputBuffer.length > 100) {
    const memoryResult = await extractAndStoreMemories(agentId, task.id, outputBuffer, task).catch(err => {
      console.log(`⚠️ Memory extraction failed: ${err.message}`);
      return { created: 0, pendingApproval: 0 };
    });
    if (memoryResult.created > 0 || memoryResult.pendingApproval > 0) {
      await updateAgent(agentId, {
        memoryExtraction: {
          created: memoryResult.created,
          pendingApproval: memoryResult.pendingApproval,
          extractedAt: new Date().toISOString()
        }
      });
    }
  }

  // Handle app cooldown
  const appId = task.metadata?.app;
  if (appId) {
    const config = await getConfig();
    const cooldownMs = config.appReviewCooldownMs || 3600000;

    const issuesFound = success ? 1 : 0;
    const issuesFixed = success ? 1 : 0;
    await markAppReviewCompleted(appId, issuesFound, issuesFixed).catch(err => {
      emitLog('warn', `Failed to mark app review completed: ${err.message}`, { appId });
    });

    await startAppCooldown(appId, cooldownMs).catch(err => {
      emitLog('warn', `Failed to start app cooldown: ${err.message}`, { appId });
    });

    emitLog('info', `App ${appId} cooldown started (${Math.round(cooldownMs / 60000)} min)`, { appId, cooldownMs });
  }
}

// Active agent processes (direct spawn mode)
const activeAgents = new Map();

// Track runner-spawned agents (CoS Runner mode)
const runnerAgents = new Map();

// Track agents terminated by user (to prevent re-queuing)
const userTerminatedAgents = new Set();

/**
 * Get list of active agent IDs (for zombie detection)
 * Includes both direct mode and runner mode agents
 */
export function getActiveAgentIds() {
  const directIds = Array.from(activeAgents.keys());
  const runnerIds = Array.from(runnerAgents.keys());
  return [...directIds, ...runnerIds];
}

/**
 * Error patterns that warrant investigation tasks.
 * Patterns are checked in order - first match wins.
 * Categories help the learning system identify failure trends.
 */
const ERROR_PATTERNS = [
  // ===== API & Authentication Errors =====
  {
    pattern: /API Error: 404.*model:\s*(\S+)/i,
    category: 'model-not-found',
    actionable: true,
    extract: (match, output, task, model) => ({
      message: `Model "${match[1]}" not found`,
      suggestedFix: `Update model configuration - "${match[1]}" doesn't exist. Check provider settings or task metadata.`,
      affectedModel: match[1],
      configuredModel: model
    })
  },
  {
    pattern: /API Error: 401|authentication|unauthorized/i,
    category: 'auth-error',
    actionable: true,
    extract: () => ({
      message: 'Authentication failed',
      suggestedFix: 'Check API keys and provider configuration'
    })
  },
  {
    pattern: /API Error: 429|rate.?limit|too many requests/i,
    category: 'rate-limit',
    actionable: false, // Transient, retry will handle
    extract: () => ({
      message: 'Rate limit exceeded',
      suggestedFix: 'Wait and retry - temporary rate limiting'
    })
  },
  {
    pattern: /(?:hit your usage limit|usage limit|quota exceeded|Upgrade to Pro)/i,
    category: 'usage-limit',
    actionable: true, // Need to switch provider
    extract: (match, output) => {
      // Try to extract the wait time from the message
      // e.g., "try again in 1 day 1 hour 33 minutes"
      const timeMatch = output.match(/try again in\s+(.+?)(?:\.|$)/i);
      const waitTime = timeMatch ? timeMatch[1].trim() : null;
      return {
        message: `Usage limit exceeded${waitTime ? ` - retry in ${waitTime}` : ''}`,
        suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.',
        waitTime,
        requiresFallback: true
      };
    }
  },
  {
    pattern: /API Error: 5\d{2}|server error|internal error/i,
    category: 'server-error',
    actionable: false, // Transient
    extract: () => ({
      message: 'API server error',
      suggestedFix: 'Retry later - temporary server issue'
    })
  },
  {
    pattern: /not_found_error.*model/i,
    category: 'model-not-found',
    actionable: true,
    extract: (match, output, task, model) => ({
      message: `Model not found in API response`,
      suggestedFix: `The model "${model}" specified for this task doesn't exist. Update provider or task configuration.`,
      configuredModel: model
    })
  },

  // ===== Context & Token Errors =====
  {
    pattern: /context.?length|max.?tokens|token.?limit|context.?window/i,
    category: 'context-length',
    actionable: true,
    extract: () => ({
      message: 'Context length exceeded',
      suggestedFix: 'Task is too large for the context window. Break into smaller subtasks or use a model with larger context.'
    })
  },
  {
    pattern: /output.?length|max.?output|response.?too.?long/i,
    category: 'output-length',
    actionable: false,
    extract: () => ({
      message: 'Output length exceeded',
      suggestedFix: 'Agent response exceeded output limit. Task may need to be scoped down.'
    })
  },

  // ===== Tool & MCP Errors =====
  {
    pattern: /tool.?(?:call|use|execution).?(?:failed|error)|failed to (?:call|execute|invoke) tool/i,
    category: 'tool-error',
    actionable: false,
    extract: (match, output) => {
      const toolMatch = output.match(/tool[:\s]+["']?(\w+)["']?/i);
      return {
        message: `Tool execution failed${toolMatch ? `: ${toolMatch[1]}` : ''}`,
        suggestedFix: 'Tool call failed. Check if required dependencies/services are running.'
      };
    }
  },
  {
    pattern: /MCP.?(?:server|connection|error)|mcp.?(?:failed|timeout)/i,
    category: 'mcp-error',
    actionable: false,
    extract: () => ({
      message: 'MCP server error',
      suggestedFix: 'MCP server connection failed. Verify MCP servers are configured and accessible.'
    })
  },
  {
    pattern: /permission.?denied|access.?denied|not.?allowed|insufficient.?permissions/i,
    category: 'permission-denied',
    actionable: true,
    extract: () => ({
      message: 'Permission denied',
      suggestedFix: 'Agent lacks permissions for the requested operation. Check file/directory permissions.'
    })
  },

  // ===== Git & Repository Errors =====
  {
    pattern: /git.?(?:conflict|merge.?conflict)|CONFLICT.*both modified|merge.?failed/i,
    category: 'git-conflict',
    actionable: true,
    extract: () => ({
      message: 'Git merge conflict',
      suggestedFix: 'Merge conflict detected. Resolve conflicts manually before retrying.'
    })
  },
  {
    pattern: /fatal:\s*(?:not a git repository|could not|failed to|unable to)/i,
    category: 'git-error',
    actionable: false,
    extract: (match, output) => {
      const detailMatch = output.match(/fatal:\s*(.+?)(?:\n|$)/i);
      return {
        message: `Git error${detailMatch ? `: ${detailMatch[1].substring(0, 60)}` : ''}`,
        suggestedFix: 'Git operation failed. Verify the repository state and try again.'
      };
    }
  },
  {
    pattern: /nothing.?to.?commit|no.?changes|working.?tree.?clean/i,
    category: 'no-changes',
    actionable: false,
    extract: () => ({
      message: 'No changes to commit',
      suggestedFix: 'Agent completed but made no code changes. Task may already be done or description needs clarification.'
    })
  },

  // ===== Build & Test Errors =====
  {
    pattern: /npm.?ERR!|yarn.?error|pnpm.?(?:ERR|error)/i,
    category: 'npm-error',
    actionable: false,
    extract: (match, output) => {
      const errMatch = output.match(/(?:npm|yarn|pnpm).?(?:ERR!|error)[:\s]*(.+?)(?:\n|$)/i);
      return {
        message: `Package manager error${errMatch ? `: ${errMatch[1].substring(0, 50)}` : ''}`,
        suggestedFix: 'Package installation or script failed. Check package.json and dependencies.'
      };
    }
  },
  {
    pattern: /test.?(?:failed|failure)|(?:failed|failing).?tests?|FAIL\s+\w+\.test/i,
    category: 'test-failure',
    actionable: false,
    extract: () => ({
      message: 'Tests failed',
      suggestedFix: 'One or more tests failed. Review test output and fix failing assertions.'
    })
  },
  {
    pattern: /lint.?(?:error|failed)|eslint.?error|prettier.?error/i,
    category: 'lint-error',
    actionable: false,
    extract: () => ({
      message: 'Linting failed',
      suggestedFix: 'Code style/lint errors detected. Fix formatting issues and retry.'
    })
  },
  {
    pattern: /build.?failed|compilation.?(?:failed|error)|typescript.?error|tsc.+error/i,
    category: 'build-error',
    actionable: false,
    extract: () => ({
      message: 'Build failed',
      suggestedFix: 'Build/compilation failed. Fix syntax or type errors and retry.'
    })
  },

  // ===== Process & System Errors =====
  {
    pattern: /ECONNREFUSED|ETIMEDOUT|network error/i,
    category: 'network-error',
    actionable: false,
    extract: () => ({
      message: 'Network connection failed',
      suggestedFix: 'Check network connectivity and service availability.'
    })
  },
  {
    pattern: /ENOENT|file.?not.?found|no.?such.?file/i,
    category: 'file-not-found',
    actionable: false,
    extract: (match, output) => {
      const pathMatch = output.match(/(?:ENOENT|not.?found)[:\s]*['"]?([^'"}\s]+)['"]?/i);
      return {
        message: `File not found${pathMatch ? `: ${pathMatch[1].substring(0, 40)}` : ''}`,
        suggestedFix: 'Expected file/directory does not exist. Verify paths in the task description.'
      };
    }
  },
  {
    pattern: /ENOMEM|out.?of.?memory|heap.?(?:out|limit)|memory.?(?:limit|exceeded)/i,
    category: 'memory-error',
    actionable: true,
    extract: () => ({
      message: 'Out of memory',
      suggestedFix: 'Process ran out of memory. Task may be too large or there is a memory leak.'
    })
  },
  {
    pattern: /timeout|timed.?out|deadline.?exceeded/i,
    category: 'timeout',
    actionable: false,
    extract: () => ({
      message: 'Operation timed out',
      suggestedFix: 'Task took too long to complete. Consider breaking into smaller subtasks.'
    })
  },
  {
    pattern: /(?:killed|terminated).?(?:by.?signal|SIGTERM|SIGKILL)/i,
    category: 'process-killed',
    actionable: false,
    extract: () => ({
      message: 'Process killed',
      suggestedFix: 'Agent process was terminated. May have exceeded resource limits or was killed externally.'
    })
  },
  {
    pattern: /spawn.?(?:error|failed)|EACCES|command.?not.?found/i,
    category: 'spawn-error',
    actionable: true,
    extract: () => ({
      message: 'Command spawn failed',
      suggestedFix: 'Failed to start subprocess. Check that required CLI tools are installed and accessible.'
    })
  },

  // ===== Playwright & Browser Errors =====
  {
    pattern: /playwright|browser.?(?:crashed|closed|disconnected)/i,
    category: 'browser-error',
    actionable: false,
    extract: () => ({
      message: 'Browser automation failed',
      suggestedFix: 'Playwright browser crashed or disconnected. Check if the dev server is running.'
    })
  },
  {
    pattern: /locator.?(?:timeout|not.?found)|element.?not.?(?:found|visible)/i,
    category: 'locator-error',
    actionable: false,
    extract: () => ({
      message: 'UI element not found',
      suggestedFix: 'Could not find expected element on page. UI may have changed or selector is wrong.'
    })
  },

  // ===== Agent-Specific Errors =====
  {
    pattern: /(?:claude|anthropic).?(?:error|failed)|overloaded_error/i,
    category: 'claude-error',
    actionable: false,
    extract: () => ({
      message: 'Claude API error',
      suggestedFix: 'Claude API returned an error. This is usually transient - retry recommended.'
    })
  },
  {
    pattern: /invalid.?(?:json|syntax)|JSON\.parse|SyntaxError/i,
    category: 'parse-error',
    actionable: false,
    extract: () => ({
      message: 'JSON/Syntax parse error',
      suggestedFix: 'Failed to parse response or file. Check for malformed JSON or syntax errors.'
    })
  },
  {
    pattern: /task.?(?:rejected|declined|refused)|cannot.?(?:complete|perform)/i,
    category: 'task-rejected',
    actionable: true,
    extract: () => ({
      message: 'Agent rejected task',
      suggestedFix: 'Agent could not or would not complete the task. Rephrase or simplify the request.'
    })
  },

  // ===== Safety & Content Errors =====
  {
    pattern: /content.?(?:filter|policy)|safety.?(?:filter|block)|harmful.?content/i,
    category: 'content-filtered',
    actionable: true,
    extract: () => ({
      message: 'Content filtered',
      suggestedFix: 'Request was blocked by content safety filter. Rephrase the task description.'
    })
  }
];

/**
 * Analyze agent failure output and categorize the error
 */
function analyzeAgentFailure(output, task, model) {
  for (const errorDef of ERROR_PATTERNS) {
    const match = output.match(errorDef.pattern);
    if (match) {
      const extracted = errorDef.extract(match, output, task, model);
      return {
        category: errorDef.category,
        actionable: errorDef.actionable,
        ...extracted
      };
    }
  }

  // Generic failure - not actionable by default
  return {
    category: 'unknown',
    actionable: false,
    message: 'Agent failed with unknown error',
    suggestedFix: 'Review agent output logs for details'
  };
}

/**
 * Create an investigation task in COS-TASKS.md for failed agent
 */
async function createInvestigationTask(agentId, originalTask, errorAnalysis) {
  const description = `[Auto] Investigate agent failure: ${errorAnalysis.message}

**Failed Agent**: ${agentId}
**Original Task**: ${originalTask.id} - ${(originalTask.description || '').substring(0, 100)}
**Error Category**: ${errorAnalysis.category}
**Suggested Fix**: ${errorAnalysis.suggestedFix}
${errorAnalysis.configuredModel ? `**Configured Model**: ${errorAnalysis.configuredModel}` : ''}
${errorAnalysis.affectedModel ? `**Affected Model**: ${errorAnalysis.affectedModel}` : ''}

Review the error, fix the configuration or code issue, and retry the original task.`;

  const investigationTask = await addTask({
    description,
    priority: 'HIGH',
    context: `Auto-generated from agent ${agentId} failure`,
    approvalRequired: true // Require human approval before auto-fixing
  }, 'internal');

  emitLog('info', `Created investigation task ${investigationTask.id} for failed agent ${agentId}`, {
    agentId,
    taskId: investigationTask.id,
    errorCategory: errorAnalysis.category
  });

  cosEvents.emit('investigation:created', {
    investigationTaskId: investigationTask.id,
    failedAgentId: agentId,
    originalTaskId: originalTask.id,
    errorAnalysis
  });

  return investigationTask;
}

/**
 * Handle task status update after agent failure.
 * Tracks retry count and blocks the task after MAX_TASK_RETRIES,
 * creating an investigation task instead of retrying endlessly.
 *
 * Returns { status, metadata } to apply to the task.
 */
async function resolveFailedTaskUpdate(task, errorAnalysis, agentId) {
  // Actionable errors get blocked immediately with investigation
  if (errorAnalysis?.actionable) {
    emitLog('warn', `🚫 Task ${task.id} blocked: ${errorAnalysis.message} (${errorAnalysis.category})`, {
      taskId: task.id, category: errorAnalysis.category
    });
    await createInvestigationTask(agentId, task, errorAnalysis).catch(err => {
      emitLog('warn', `Failed to create investigation task: ${err.message}`, { agentId });
    });
    return {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        blockedReason: errorAnalysis.message,
        blockedCategory: errorAnalysis.category,
        blockedAt: new Date().toISOString()
      }
    };
  }

  // Non-actionable errors: track retry count and block after max retries
  const failureCount = (task.metadata?.failureCount || 0) + 1;
  const lastErrorCategory = errorAnalysis?.category || 'unknown';

  if (failureCount >= MAX_TASK_RETRIES) {
    emitLog('warn', `🚫 Task ${task.id} blocked after ${failureCount} failures (${lastErrorCategory})`, {
      taskId: task.id, failureCount, category: lastErrorCategory
    });
    const blockedAnalysis = {
      ...(errorAnalysis || {}),
      message: `Task failed ${failureCount} times: ${errorAnalysis?.message || 'unknown error'}`,
      suggestedFix: `Task has failed ${failureCount} consecutive times with ${lastErrorCategory} errors. ${errorAnalysis?.suggestedFix || 'Investigate agent output logs.'}`,
      category: lastErrorCategory
    };
    await createInvestigationTask(agentId, task, blockedAnalysis).catch(err => {
      emitLog('warn', `Failed to create investigation task: ${err.message}`, { agentId });
    });
    return {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        failureCount,
        lastFailureAt: new Date().toISOString(),
        lastErrorCategory,
        blockedReason: `Max retries exceeded (${failureCount}/${MAX_TASK_RETRIES}): ${lastErrorCategory}`,
        blockedCategory: lastErrorCategory,
        blockedAt: new Date().toISOString()
      }
    };
  }

  emitLog('info', `🔄 Task ${task.id} retry ${failureCount}/${MAX_TASK_RETRIES} (${lastErrorCategory})`, {
    taskId: task.id, failureCount, maxRetries: MAX_TASK_RETRIES, category: lastErrorCategory
  });
  return {
    status: 'pending',
    metadata: {
      ...task.metadata,
      failureCount,
      lastFailureAt: new Date().toISOString(),
      lastErrorCategory
    }
  };
}

// Track if using runner mode
let useRunner = false;

/**
 * Initialize the spawner - listen for task:ready events
 */
export async function initSpawner() {
  // Initialize provider status tracking
  await initProviderStatus().catch(err => {
    console.error(`⚠️ Failed to initialize provider status: ${err.message}`);
  });

  // Check if CoS Runner is available
  useRunner = await isRunnerAvailable();

  if (useRunner) {
    console.log('🤖 Sub-agent spawner initialized (using CoS Runner)');
    initCosRunnerConnection();

    // Sync any agents that were running before server restart
    const synced = await syncRunnerAgents().catch(err => {
      console.error(`❌ Failed to sync runner agents: ${err.message}`);
      return 0;
    });
    if (synced > 0) {
      console.log(`🔄 Recovered ${synced} agents from CoS Runner`);
    }

    // Set up event handlers for runner events
    onCosRunnerEvent('agent:output', async (data) => {
      const { agentId, text } = data;
      await appendAgentOutput(agentId, text);

      // Update phase on first output
      const agent = runnerAgents.get(agentId);
      if (agent && !agent.hasStartedWorking) {
        agent.hasStartedWorking = true;
        clearTimeout(agent.initializationTimeout);
        await updateAgent(agentId, { metadata: { phase: 'working' } });
        emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
      }

    });

    onCosRunnerEvent('agent:completed', async (data) => {
      const { agentId, exitCode, success, duration } = data;
      const agent = runnerAgents.get(agentId);
      if (agent) {
        clearTimeout(agent.initializationTimeout);
      }
      await handleAgentCompletion(agentId, exitCode, success, duration);
    });

    // Batch handler for orphaned agents (runner startup cleanup)
    onCosRunnerEvent('agents:orphaned', async (data) => {
      const { agents, count } = data;
      console.log(`🧹 Processing ${count} orphaned agents from runner`);
      for (const orphan of agents) {
        const agent = runnerAgents.get(orphan.agentId);
        if (agent) {
          clearTimeout(agent.initializationTimeout);
        }
        await handleAgentCompletion(orphan.agentId, orphan.exitCode, orphan.success, 0);
      }
    });

    onCosRunnerEvent('agent:error', async (data) => {
      const { agentId, error } = data;
      console.error(`❌ Agent ${agentId} error from runner: ${error}`);
      cosEvents.emit('agent:error', { agentId, error });
      const agent = runnerAgents.get(agentId);
      if (agent) {
        clearTimeout(agent.initializationTimeout);
        await completeAgent(agentId, { success: false, error });
        await completeAgentRun(agent.runId, '', 1, 0, { message: error, category: 'runner-error' });
        runnerAgents.delete(agentId);
      }
    });
  } else {
    console.log('🤖 Sub-agent spawner initialized (direct mode - CoS Runner not available)');
  }

  cosEvents.on('task:ready', async (task) => {
    await spawnAgentForTask(task);
  });

  cosEvents.on('agent:terminate', async (agentId) => {
    await terminateAgent(agentId);
  });
}

/**
 * Sync running agents from the runner (recovery after server restart)
 * This allows us to receive completion events for agents spawned before restart
 */
async function syncRunnerAgents() {
  const agents = await getActiveAgentsFromRunner().catch(err => {
    console.error(`❌ Failed to get active agents from runner: ${err.message}`);
    return [];
  });
  if (agents.length === 0) return 0;

  console.log(`🔄 Syncing ${agents.length} running agents from CoS Runner`);

  // Get all tasks to find task data for each agent
  const { getAllTasks } = await import('./cos.js');
  const allTasksData = await getAllTasks().catch(() => ({ user: {}, cos: {} }));

  // Build a task lookup map from all task sources
  const taskMap = new Map();
  const addTasks = (groupedTasks) => {
    if (!groupedTasks) return;
    for (const tasks of Object.values(groupedTasks)) {
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          taskMap.set(task.id, task);
        }
      }
    }
  };

  addTasks(allTasksData.user?.grouped);
  addTasks(allTasksData.cos?.grouped);

  let syncedCount = 0;
  for (const agent of agents) {
    // Only sync if not already tracked
    if (!runnerAgents.has(agent.id)) {
      // Try to find the task in our lookup map
      const task = taskMap.get(agent.taskId);

      runnerAgents.set(agent.id, {
        taskId: agent.taskId,
        task: task || { id: agent.taskId, description: 'Recovered from runner' },
        runId: null, // Run tracking may be lost on restart
        model: null,
        hasStartedWorking: true,
        startedAt: agent.startedAt
      });
      console.log(`🔄 Recovered agent ${agent.id} (task: ${agent.taskId})`);
      syncedCount++;
    }
  }

  return syncedCount;
}

/**
 * Spawn an agent for a task
 */
export async function spawnAgentForTask(task) {
  const agentId = `agent-${uuidv4().slice(0, 8)}`;

  // Determine execution lane and acquire slot
  const laneName = determineLane(task);
  if (!hasCapacity(laneName)) {
    // Wait for lane availability (max 30 seconds)
    const laneResult = await waitForLane(laneName, agentId, { timeoutMs: 30000, metadata: { taskId: task.id } });
    if (!laneResult.success) {
      emitLog('warning', `Lane ${laneName} unavailable for task ${task.id}, deferring`, { taskId: task.id, lane: laneName });
      cosEvents.emit('agent:deferred', { taskId: task.id, reason: 'lane-capacity', lane: laneName });
      return null;
    }
  } else {
    const laneResult = acquire(laneName, agentId, { taskId: task.id });
    if (!laneResult.success) {
      emitLog('warning', `Failed to acquire lane ${laneName}: ${laneResult.error}`, { taskId: task.id });
      return null;
    }
  }

  // Create tool execution for state tracking
  const toolExecution = createToolExecution('agent-spawn', agentId, {
    taskId: task.id,
    lane: laneName,
    priority: task.priority
  });
  startExecution(toolExecution.id);

  // Helper to cleanup on early exit
  const cleanupOnError = (error) => {
    release(agentId);
    errorExecution(toolExecution.id, { message: error });
    completeExecution(toolExecution.id, { success: false });
  };

  // Get configuration
  const config = await getConfig();
  let provider = await getActiveProvider();

  if (!provider) {
    cleanupOnError('No active AI provider configured');
    cosEvents.emit('agent:error', { taskId: task.id, error: 'No active AI provider configured' });
    return null;
  }

  // Check provider availability (usage limits, rate limits, etc.)
  const providerAvailable = isProviderAvailable(provider.id);
  if (!providerAvailable) {
    const status = getProviderStatus(provider.id);
    emitLog('warning', `Provider ${provider.id} unavailable: ${status.message}`, {
      taskId: task.id,
      providerId: provider.id,
      reason: status.reason
    });

    // Try to get a fallback provider (check task-level, then provider-level, then system default)
    const allProviders = await getAllProviders();
    const taskFallbackId = task.metadata?.fallbackProvider;
    const fallbackResult = await getFallbackProvider(provider.id, allProviders, taskFallbackId);

    if (fallbackResult) {
      emitLog('info', `Using fallback provider: ${fallbackResult.provider.id} (source: ${fallbackResult.source})`, {
        taskId: task.id,
        primaryProvider: provider.id,
        fallbackProvider: fallbackResult.provider.id,
        fallbackSource: fallbackResult.source
      });
      provider = fallbackResult.provider;
    } else {
      // No fallback available - emit error and defer task
      const errorMsg = `Provider ${provider.id} unavailable (${status.message}) and no fallback available`;
      cleanupOnError(errorMsg);
      cosEvents.emit('agent:error', {
        taskId: task.id,
        error: errorMsg,
        providerId: provider.id,
        providerStatus: status
      });
      // Don't spawn - task will retry later when provider recovers
      return null;
    }
  }

  // Check if user specified a different provider in task metadata
  const userProviderId = task.metadata?.provider;
  if (userProviderId && userProviderId !== provider.id) {
    const userProvider = await getProviderById(userProviderId);
    if (userProvider) {
      emitLog('info', `Using user-specified provider: ${userProviderId}`, { taskId: task.id });
      provider = userProvider;
    } else {
      emitLog('warning', `User-specified provider "${userProviderId}" not found, using active provider`, { taskId: task.id });
    }
  }

  // Select optimal model for this task (async to allow learning-based suggestions)
  const modelSelection = await selectModelForTask(task, provider);
  let selectedModel = modelSelection.model;

  // Validate model is compatible with provider
  if (selectedModel && provider.models && provider.models.length > 0) {
    const modelIsValid = provider.models.includes(selectedModel);
    if (!modelIsValid) {
      emitLog('warning', `Model "${selectedModel}" not valid for provider "${provider.id}", falling back to provider default`, {
        taskId: task.id,
        requestedModel: selectedModel,
        providerId: provider.id,
        validModels: provider.models
      });
      // Fall back to the appropriate tier model for this provider
      selectedModel = modelSelection.tier === 'heavy' ? provider.heavyModel :
                      modelSelection.tier === 'light' ? provider.lightModel :
                      modelSelection.tier === 'medium' ? provider.mediumModel :
                      provider.defaultModel;
    }
  }

  const logMessage = modelSelection.learningReason
    ? `Model selection: ${selectedModel} (${modelSelection.reason} - ${modelSelection.learningReason})`
    : `Model selection: ${selectedModel} (${modelSelection.reason})`;
  emitLog('info', logMessage, {
    taskId: task.id,
    model: selectedModel,
    tier: modelSelection.tier,
    reason: modelSelection.reason,
    ...(modelSelection.learningReason && { learningReason: modelSelection.learningReason })
  });

  // Determine workspace path
  let workspacePath = task.metadata?.app
    ? await getAppWorkspace(task.metadata.app)
    : ROOT_DIR;

  // Check for conflicts with active agents and decide on worktree usage
  let worktreeInfo = null;
  const { getAgents } = await import('./cos.js');
  const allAgents = await getAgents();
  const runningAgents = allAgents.filter(a => a.status === 'running');

  const conflictResult = await detectConflicts(task, workspacePath, runningAgents).catch(err => {
    emitLog('warn', `Conflict detection failed: ${err.message}`, { taskId: task.id });
    return { hasConflict: false, recommendation: 'proceed' };
  });

  if (conflictResult.recommendation === 'worktree') {
    emitLog('info', `🌳 Conflict detected for task ${task.id}: ${conflictResult.reason} — creating worktree`, {
      taskId: task.id,
      conflictingAgents: conflictResult.conflictingAgents,
      reason: conflictResult.reason
    });

    worktreeInfo = await createWorktree(agentId, workspacePath, task.id).catch(err => {
      emitLog('warn', `🌳 Worktree creation failed, using shared workspace: ${err.message}`, { taskId: task.id });
      return null;
    });

    if (worktreeInfo) {
      workspacePath = worktreeInfo.worktreePath;
      emitLog('success', `🌳 Agent ${agentId} will work in worktree: ${worktreeInfo.branchName}`, {
        agentId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName
      });
    }
  } else if (conflictResult.recommendation === 'proceed') {
    emitLog('debug', `No conflicts for task ${task.id}, using shared workspace`, { taskId: task.id });
  }

  // Build the agent prompt (includes worktree context if applicable)
  const prompt = await buildAgentPrompt(task, config, workspacePath, worktreeInfo);

  // Create agent directory
  const agentDir = join(AGENTS_DIR, agentId);
  if (!existsSync(agentDir)) {
    await mkdir(agentDir, { recursive: true });
  }

  // Save prompt to file
  await writeFile(join(agentDir, 'prompt.txt'), prompt);

  // Create run entry for usage tracking
  const { runId } = await createAgentRun(agentId, task, selectedModel, provider, workspacePath);

  // Register the agent with model info (include worktree metadata + task metadata for learning)
  await registerAgent(agentId, task.id, {
    workspacePath,
    sourceWorkspace: worktreeInfo ? (task.metadata?.app ? await getAppWorkspace(task.metadata.app) : ROOT_DIR) : null,
    worktreeBranch: worktreeInfo?.branchName || null,
    isWorktree: !!worktreeInfo,
    taskDescription: task.description,
    taskType: task.taskType,
    priority: task.priority,
    providerId: provider.id,
    model: selectedModel,
    modelTier: modelSelection.tier,
    modelReason: modelSelection.reason,
    runId,
    phase: 'initializing',
    useRunner,
    // Forward task metadata fields for learning classification
    taskAnalysisType: task.metadata?.analysisType || null,
    taskReviewType: task.metadata?.reviewType || null,
    taskApp: task.metadata?.app || null,
    selfImprovementType: task.metadata?.selfImprovementType || null,
    missionName: task.metadata?.missionName || null,
    missionId: task.metadata?.missionId || null
  });

  emitLog('info', `Agent ${agentId} initializing...${worktreeInfo ? ' (worktree)' : ''}`, { agentId, taskId: task.id });

  // Mark the task as in_progress to prevent re-spawning
  await updateTask(task.id, { status: 'in_progress' }, task.taskType || 'user');

  // Build CLI-specific spawn configuration
  const cliConfig = buildCliSpawnConfig(provider, selectedModel);

  emitLog('success', `Spawning agent for task ${task.id}`, { agentId, model: selectedModel, mode: useRunner ? 'runner' : 'direct', cli: cliConfig.command, lane: laneName, worktree: !!worktreeInfo });

  // Use CoS Runner if available, otherwise spawn directly
  if (useRunner) {
    return spawnViaRunner(agentId, task, prompt, workspacePath, selectedModel, provider, runId, cliConfig, toolExecution.id, laneName);
  }

  // Direct spawn mode (fallback)
  return spawnDirectly(agentId, task, prompt, workspacePath, selectedModel, provider, runId, cliConfig, agentDir, toolExecution.id, laneName);
}

/**
 * Minimum runner uptime (seconds) before spawning agents.
 * Prevents race condition during rolling restarts where server starts
 * before runner, spawns an agent, then runner restarts and orphans it.
 */
const RUNNER_MIN_UPTIME_SECONDS = 10;

/**
 * Wait for runner to be stable (sufficient uptime) before spawning
 */
async function waitForRunnerStability() {
  const maxWaitMs = 15000;
  const checkIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const health = await getRunnerHealth();
    if (health.available && health.uptime >= RUNNER_MIN_UPTIME_SECONDS) {
      return true;
    }
    if (health.available && health.uptime < RUNNER_MIN_UPTIME_SECONDS) {
      const waitTime = Math.ceil(RUNNER_MIN_UPTIME_SECONDS - health.uptime);
      emitLog('info', `Waiting ${waitTime}s for runner stability (uptime: ${Math.floor(health.uptime)}s)`, { uptime: health.uptime });
    }
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  emitLog('warning', 'Runner stability check timed out, proceeding anyway', {});
  return false;
}

/**
 * Spawn agent via CoS Runner (isolated PM2 process)
 */
async function spawnViaRunner(agentId, task, prompt, workspacePath, model, provider, runId, cliConfig, executionId, laneName) {
  // Wait for runner to be stable to prevent orphaned agents during rolling restarts
  await waitForRunnerStability();

  // Store tracking info for runner-spawned agents
  const agentInfo = {
    taskId: task.id,
    task,
    runId,
    model,
    providerId: provider.id,
    hasStartedWorking: false,
    startedAt: Date.now(),
    initializationTimeout: null,
    executionId,
    laneName
  };
  runnerAgents.set(agentId, agentInfo);

  // If no output after 3 seconds, transition from initializing to working to show progress
  agentInfo.initializationTimeout = setTimeout(async () => {
    const agent = runnerAgents.get(agentId);
    if (agent && !agent.hasStartedWorking) {
      agent.hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
    }
  }, 3000);

  const result = await spawnAgentViaRunner({
    agentId,
    taskId: task.id,
    prompt,
    workspacePath,
    model,
    envVars: provider.envVars,
    cliCommand: cliConfig.command,
    cliArgs: cliConfig.args
  });

  // Store PID in persisted state for zombie detection
  await updateAgent(agentId, { pid: result.pid });

  emitLog('info', `Agent ${agentId} spawned via runner (PID: ${result.pid})`, { agentId, pid: result.pid });
  return agentId;
}

/**
 * Handle agent completion (from runner events)
 */
async function handleAgentCompletion(agentId, exitCode, success, duration) {
  const agent = runnerAgents.get(agentId);
  if (!agent) {
    console.log(`⚠️ Received completion for unknown agent: ${agentId}`);
    return;
  }

  const { task, runId, model, executionId, laneName } = agent;

  // Release execution lane
  if (laneName) {
    release(agentId);
  }

  // Complete tool execution tracking
  if (executionId) {
    if (success) {
      completeExecution(executionId, { success: true, duration });
    } else {
      errorExecution(executionId, { message: `Agent exited with code ${exitCode}`, code: exitCode });
      completeExecution(executionId, { success: false });
    }
  }

  // Read output from agent directory
  const agentDir = join(AGENTS_DIR, agentId);
  const outputFile = join(agentDir, 'output.txt');
  let outputBuffer = '';
  if (existsSync(outputFile)) {
    outputBuffer = await readFile(outputFile, 'utf-8').catch(() => '');
  }

  // Analyze failure if applicable
  const errorAnalysis = success ? null : analyzeAgentFailure(outputBuffer, task, model);

  await completeAgent(agentId, {
    success,
    exitCode,
    duration,
    outputLength: outputBuffer.length,
    errorAnalysis
  });

  // Complete run tracking (skip if no runId - agent was recovered after restart)
  if (runId) {
    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis);
  }

  // Update task status with retry tracking
  if (success) {
    await updateTask(task.id, { status: 'completed' }, task.taskType || 'user');
  } else {
    const failedUpdate = await resolveFailedTaskUpdate(task, errorAnalysis, agentId);
    await updateTask(task.id, failedUpdate, task.taskType || 'user');

    // Handle provider status updates on failure
    if (errorAnalysis) {
      if (errorAnalysis.category === 'usage-limit' && errorAnalysis.requiresFallback) {
        const providerId = agent.providerId || (await getActiveProvider())?.id;
        if (providerId) {
          await markProviderUsageLimit(providerId, errorAnalysis).catch(err => {
            emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId });
          });
        }
      }
      if (errorAnalysis.category === 'rate-limit') {
        const providerId = agent.providerId || (await getActiveProvider())?.id;
        if (providerId) {
          await markProviderRateLimited(providerId).catch(err => {
            emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId });
          });
        }
      }
    }
  }

  // Process memory extraction and app cooldown
  await processAgentCompletion(agentId, task, success, outputBuffer);

  // Clean up worktree if agent was using one
  await cleanupAgentWorktree(agentId, success);

  runnerAgents.delete(agentId);
}

/**
 * Clean up a worktree for a completed agent.
 * Reads worktree metadata from the agent's registered state and removes the worktree.
 * On success, merges the worktree branch back to the source branch.
 */
async function cleanupAgentWorktree(agentId, success) {
  const { getAgent: getAgentState } = await import('./cos.js');
  const agentState = await getAgentState(agentId).catch(() => null);
  if (!agentState?.metadata?.isWorktree) return;

  const { sourceWorkspace, worktreeBranch } = agentState.metadata;
  if (!sourceWorkspace || !worktreeBranch) return;

  emitLog('info', `🌳 Cleaning up worktree for agent ${agentId} (merge: ${success})`, {
    agentId, branchName: worktreeBranch, merge: success
  });

  await removeWorktree(agentId, sourceWorkspace, worktreeBranch, { merge: success }).catch(err => {
    emitLog('warn', `🌳 Worktree cleanup failed for ${agentId}: ${err.message}`, { agentId });
  });
}

/**
 * Spawn agent directly (fallback when runner not available)
 */
async function spawnDirectly(agentId, task, prompt, workspacePath, model, provider, runId, cliConfig, agentDir, executionId, laneName) {
  const fullCommand = `${cliConfig.command} ${cliConfig.args.join(' ')} <<< "${(task.description || '').substring(0, 100)}..."`;

  // Ensure workspacePath is valid
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : ROOT_DIR;

  const claudeProcess = spawn(cliConfig.command, cliConfig.args, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...provider.envVars
    }
  });

  registerSpawnedAgent(claudeProcess.pid, {
    fullCommand,
    agentId,
    taskId: task.id,
    model,
    workspacePath,
    prompt: (task.description || '').substring(0, 500)
  });

  claudeProcess.stdin.write(prompt);
  claudeProcess.stdin.end();

  activeAgents.set(agentId, {
    process: claudeProcess,
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid: claudeProcess.pid,
    providerId: provider.id,
    executionId,
    laneName
  });

  // Store PID in persisted state for zombie detection
  await updateAgent(agentId, { pid: claudeProcess.pid });

  let outputBuffer = '';
  let hasStartedWorking = false;
  const outputFile = join(agentDir, 'output.txt');

  // If no output after 3 seconds, transition from initializing to working to show progress
  const initializationTimeout = setTimeout(async () => {
    if (!hasStartedWorking && activeAgents.has(agentId)) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working (after initialization delay)...`, { agentId, phase: 'working' });
    }
  }, 3000);

  claudeProcess.stdout.on('data', async (data) => {
    const text = data.toString();
    outputBuffer += text;

    if (!hasStartedWorking) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
    }

    await writeFile(outputFile, outputBuffer).catch(() => {});
    await appendAgentOutput(agentId, text);
  });

  claudeProcess.stderr.on('data', async (data) => {
    const text = data.toString();
    outputBuffer += `[stderr] ${text}`;
    await writeFile(outputFile, outputBuffer).catch(() => {});
    await appendAgentOutput(agentId, `[stderr] ${text}`);
  });

  claudeProcess.on('error', async (err) => {
    clearTimeout(initializationTimeout);
    console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);

    // Release execution lane
    if (laneName) {
      release(agentId);
    }

    // Complete tool execution tracking with error
    if (executionId) {
      errorExecution(executionId, { message: err.message, category: 'spawn-error' });
      completeExecution(executionId, { success: false });
    }

    cosEvents.emit('agent:error', { agentId, error: err.message });
    await completeAgent(agentId, { success: false, error: err.message });
    await completeAgentRun(runId, outputBuffer, 1, 0, { message: err.message, category: 'spawn-error' });
    unregisterSpawnedAgent(claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  claudeProcess.on('close', async (code) => {
    clearTimeout(initializationTimeout);
    const success = code === 0;
    const agentData = activeAgents.get(agentId);
    const duration = Date.now() - (agentData?.startedAt || Date.now());

    // Release execution lane
    if (agentData?.laneName) {
      release(agentId);
    }

    // Complete tool execution tracking
    if (agentData?.executionId) {
      if (success) {
        completeExecution(agentData.executionId, { success: true, duration });
      } else {
        errorExecution(agentData.executionId, { message: `Agent exited with code ${code}`, code });
        completeExecution(agentData.executionId, { success: false });
      }
    }

    await writeFile(outputFile, outputBuffer).catch(() => {});

    const errorAnalysis = success ? null : analyzeAgentFailure(outputBuffer, task, model);

    await completeAgent(agentId, {
      success,
      exitCode: code,
      duration,
      outputLength: outputBuffer.length,
      errorAnalysis
    });

    await completeAgentRun(agentData?.runId || runId, outputBuffer, code, duration, errorAnalysis);

    // Update task status with retry tracking
    // Skip if user-terminated — task already blocked by terminateAgent/killAgent
    if (userTerminatedAgents.has(agentId)) {
      userTerminatedAgents.delete(agentId);
      await updateTask(task.id, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: 'Terminated by user',
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    } else if (success) {
      await updateTask(task.id, { status: 'completed' }, task.taskType || 'user');
    } else {
      const failedUpdate = await resolveFailedTaskUpdate(task, errorAnalysis, agentId);
      await updateTask(task.id, failedUpdate, task.taskType || 'user');

      // Handle provider status updates on failure
      if (errorAnalysis) {
        if (errorAnalysis.category === 'usage-limit' && errorAnalysis.requiresFallback) {
          const providerId = agentData?.providerId || provider.id;
          if (providerId) {
            await markProviderUsageLimit(providerId, errorAnalysis).catch(err => {
              emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId });
            });
          }
        }
        if (errorAnalysis.category === 'rate-limit') {
          const providerId = agentData?.providerId || provider.id;
          if (providerId) {
            await markProviderRateLimited(providerId).catch(err => {
              emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId });
            });
          }
        }
      }
    }

    // Process memory extraction and app cooldown
    await processAgentCompletion(agentId, task, success, outputBuffer);

    // Clean up worktree if agent was using one
    await cleanupAgentWorktree(agentId, success);

    unregisterSpawnedAgent(agentData?.pid || claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  return agentId;
}

/**
 * Build spawn command and arguments for a CLI provider
 * Returns { command, args, stdinMode } based on provider type
 */
function buildCliSpawnConfig(provider, model) {
  const providerId = provider?.id || 'claude-code';

  // Codex CLI uses different invocation pattern
  if (providerId === 'codex') {
    const args = ['exec'];
    if (model) {
      args.push('--model', model);
    }
    return {
      command: provider?.command || 'codex',
      args,
      stdinMode: 'prompt' // codex exec reads prompt from stdin
    };
  }

  // Gemini CLI — uses --yolo for auto-approval, -p for non-interactive stdin mode
  if (providerId === 'gemini-cli') {
    const args = ['--yolo', ...(provider?.args || [])];
    if (model) {
      args.push('--model', model);
    }
    return {
      command: provider?.command || 'gemini',
      args,
      stdinMode: 'prompt'
    };
  }

  // Default: Claude Code CLI
  const args = [
    '--dangerously-skip-permissions', // Unrestricted mode
    '--print',                          // Print output and exit
  ];
  if (model) {
    args.push('--model', model);
  }

  return {
    command: process.env.CLAUDE_PATH || 'claude',
    args,
    stdinMode: 'prompt'
  };
}

/**
 * Build spawn arguments for Claude CLI
 * @deprecated Use buildCliSpawnConfig instead
 */
function buildSpawnArgs(config, model) {
  // Note: MCP server config via --mcp-config requires a file path, not inline JSON
  // For now, we skip MCP config and rely on the user's default settings
  // Prompt will be passed via stdin to avoid shell escaping issues
  const args = [
    '--dangerously-skip-permissions', // Unrestricted mode
    '--print',                          // Print output and exit
  ];

  // Add model selection if specified
  if (model) {
    args.push('--model', model);
  }

  return args;
}

/**
 * Read CLAUDE.md files for agent context
 * Reads both global (~/.claude/CLAUDE.md) and project-specific (./CLAUDE.md)
 */
async function getClaudeMdContext(workspaceDir) {
  const contexts = [];

  // Try to read global CLAUDE.md from ~/.claude/CLAUDE.md
  try {
    const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
    if (existsSync(globalPath)) {
      const content = await readFile(globalPath, 'utf-8');
      if (content.trim()) {
        contexts.push({
          type: 'Global Instructions',
          path: globalPath,
          content: content.trim()
        });
      }
    }
  } catch (err) {
    // Silently ignore if global CLAUDE.md doesn't exist or can't be read
  }

  // Try to read project-specific CLAUDE.md from workspace directory
  try {
    const projectPath = join(workspaceDir, 'CLAUDE.md');
    if (existsSync(projectPath)) {
      const content = await readFile(projectPath, 'utf-8');
      if (content.trim()) {
        contexts.push({
          type: 'Project Instructions',
          path: projectPath,
          content: content.trim()
        });
      }
    }
  } catch (err) {
    // Silently ignore if project CLAUDE.md doesn't exist or can't be read
  }

  // Format as markdown section
  if (contexts.length === 0) {
    return null;
  }

  let section = '## CLAUDE.md Instructions\n\n';
  section += 'The following instructions must be followed when working on this task:\n\n';

  for (const ctx of contexts) {
    section += `### ${ctx.type}\n`;
    section += `Source: \`${ctx.path}\`\n\n`;
    section += ctx.content + '\n\n';
  }

  return section;
}

/**
 * Build the prompt for an agent
 * @param {Object} task - Task object
 * @param {Object} config - CoS configuration
 * @param {string} workspaceDir - Working directory (may be a worktree)
 * @param {Object|null} worktreeInfo - Worktree details if using a worktree ({ worktreePath, branchName })
 */
async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null) {
  // Get relevant memories for context injection
  const memorySection = await getMemorySection(task, {
    maxTokens: config.memory?.maxContextTokens || 2000
  }).catch(err => {
    console.log(`⚠️ Memory retrieval failed: ${err.message}`);
    return null;
  });

  // Get CLAUDE.md instructions for context injection
  const claudeMdSection = await getClaudeMdContext(workspaceDir).catch(err => {
    console.log(`⚠️ CLAUDE.md retrieval failed: ${err.message}`);
    return null;
  });

  // Get digital twin context for persona alignment
  const digitalTwinSection = await getDigitalTwinForPrompt({
    maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000
  }).catch(err => {
    console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`);
    return null;
  });

  // Build worktree context section if applicable
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`

**Important**: Commit your changes to this branch. Your commits will be automatically merged back to the main development branch when your task completes. Do NOT manually switch branches or modify the worktree configuration.
` : '';

  // Try to use the prompt template system
  const promptData = await buildPrompt('cos-agent-briefing', {
    task,
    config,
    memorySection,
    claudeMdSection,
    digitalTwinSection,
    worktreeSection,
    soulSection: digitalTwinSection, // Backwards compatibility for prompt templates
    timestamp: new Date().toISOString()
  }).catch(() => null);

  if (promptData?.prompt) {
    return promptData.prompt;
  }

  // Fallback to built-in template
  return `# Chief of Staff Agent Briefing

${claudeMdSection || ''}

${memorySection || ''}

## Task Assignment
You are an autonomous agent working on behalf of the Chief of Staff.

### Task Details
- **ID**: ${task.id}
- **Priority**: ${task.priority}
- **Description**: ${task.description}
${task.metadata?.context ? `- **Context**: ${task.metadata.context}` : ''}
${task.metadata?.app ? `- **Target App**: ${task.metadata.app}` : ''}
${Array.isArray(task.metadata?.screenshots) && task.metadata.screenshots.length > 0 ? `- **Screenshots**: ${task.metadata.screenshots.join(', ')}` : ''}
${worktreeSection}
## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why

## Working Directory
You are working in the project directory. Use the available tools to explore, modify, and test code.

Begin working on the task now.`;
}

/**
 * Get workspace path for an app
 */
async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');

  const data = await readJSONFile(appsFile, null);
  if (!data) {
    return ROOT_DIR;
  }

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    const app = apps.find(a => a.name === appName || a.id === appName);
    return app?.repoPath || ROOT_DIR;
  }

  // Object format - keys are app IDs
  const app = apps[appName] || Object.values(apps).find(a => a.name === appName);
  return app?.repoPath || ROOT_DIR;
}

/**
 * Terminate an agent
 */
export async function terminateAgent(agentId) {
  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    const agentInfo = runnerAgents.get(agentId);
    if (agentInfo?.initializationTimeout) {
      clearTimeout(agentInfo.initializationTimeout);
    }
    const result = await terminateAgentViaRunner(agentId).catch(err => ({
      success: false,
      error: err.message
    }));
    if (result.success) {
      // Mark agent as completed with termination status
      await completeAgent(agentId, { success: false, error: 'Agent terminated by user' });
      // Block task instead of re-queuing — user intentionally stopped this
      const task = agentInfo?.task;
      if (task) {
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: 'Terminated by user',
            blockedCategory: 'user-terminated',
            blockedAt: new Date().toISOString()
          }
        }, task.taskType || 'user');
      }
      runnerAgents.delete(agentId);
    }
    return result;
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

  // Mark agent as completed immediately with termination status
  await completeAgent(agentId, { success: false, error: 'Agent terminated by user' });

  // Kill the process
  agent.process.kill('SIGTERM');

  // Give it a moment, then force kill if needed
  setTimeout(() => {
    if (activeAgents.has(agentId)) {
      agent.process.kill('SIGKILL');
      unregisterSpawnedAgent(agent.pid);
      activeAgents.delete(agentId);
    }
  }, 5000);

  return { success: true, agentId };
}

/**
 * Get list of active agents
 */
export function getActiveAgents() {
  const agents = [];

  // Direct mode agents
  for (const [agentId, agent] of activeAgents) {
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt,
      mode: 'direct'
    });
  }

  // Runner mode agents
  for (const [agentId, agent] of runnerAgents) {
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt,
      mode: 'runner'
    });
  }

  return agents;
}

/**
 * Force kill an agent immediately with SIGKILL (no graceful shutdown)
 */
export async function killAgent(agentId) {
  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    const agentInfo = runnerAgents.get(agentId);
    if (agentInfo?.initializationTimeout) {
      clearTimeout(agentInfo.initializationTimeout);
    }
    const result = await killAgentViaRunner(agentId).catch(err => ({
      success: false,
      error: err.message
    }));
    if (result.success) {
      // Mark agent as completed with kill status
      await completeAgent(agentId, { success: false, error: 'Agent force killed by user (SIGKILL)' });
      // Block task instead of re-queuing — user intentionally killed this
      const task = agentInfo?.task;
      if (task) {
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: 'Force killed by user',
            blockedCategory: 'user-terminated',
            blockedAt: new Date().toISOString()
          }
        }, task.taskType || 'user');
      }
      runnerAgents.delete(agentId);
    }
    return result;
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

  // Mark agent as completed immediately with kill status
  await completeAgent(agentId, { success: false, error: 'Agent force killed by user (SIGKILL)' });

  // Kill the process immediately with SIGKILL
  agent.process.kill('SIGKILL');

  unregisterSpawnedAgent(agent.pid);
  activeAgents.delete(agentId);

  return { success: true, agentId, pid: agent.pid, signal: 'SIGKILL' };
}

/**
 * Get process stats for an agent (CPU, memory usage)
 */
export async function getAgentProcessStats(agentId) {
  // Check if agent is in runner mode - use runner endpoint
  if (runnerAgents.has(agentId) || useRunner) {
    const stats = await getAgentStatsFromRunner(agentId);
    return stats;
  }

  // Direct mode - get stats locally
  const agent = activeAgents.get(agentId);
  if (!agent) {
    return null;
  }

  // Get process stats using ps command
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const result = await execAsync(`ps -p ${agent.pid} -o pid=,pcpu=,rss=,state= 2>/dev/null`).catch(() => ({ stdout: '' }));
  const line = result.stdout.trim();

  if (!line) {
    return { active: false, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'dead' };
  }

  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    return {
      active: true,
      agentId,
      pid: parseInt(parts[0], 10),
      cpu: parseFloat(parts[1]) || 0,
      memoryKb: parseInt(parts[2], 10) || 0,
      memoryMb: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
      state: parts[3] || 'unknown'
    };
  }

  return { active: true, agentId, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
}

/**
 * Kill all active agents
 */
export async function killAllAgents() {
  const directIds = Array.from(activeAgents.keys());
  const runnerIds = Array.from(runnerAgents.keys());

  for (const agentId of directIds) {
    await terminateAgent(agentId);
  }

  for (const agentId of runnerIds) {
    await terminateAgent(agentId);
  }

  return { killed: directIds.length + runnerIds.length };
}

// Max retries before creating investigation task
const MAX_ORPHAN_RETRIES = 3;
const MAX_TASK_RETRIES = 3;

/**
 * Check if a process is running by PID
 */
async function isPidAlive(pid) {
  if (!pid) return false;
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const result = await execAsync(`ps -p ${pid} -o pid= 2>/dev/null`).catch(() => ({ stdout: '' }));
  return result.stdout.trim() !== '';
}

/**
 * Clean up orphaned agents on startup
 * Agents marked as "running" in state but not tracked anywhere are orphaned
 *
 * Must check:
 * 1. Local activeAgents map (direct-spawned)
 * 2. Local runnerAgents map (recently spawned via runner)
 * 3. CoS Runner service (may have agents from before server restart)
 *
 * After cleanup:
 * - Resets associated tasks to pending for auto-retry
 * - Creates investigation task after max retries exceeded
 * - Triggers evaluation to spawn new agents
 */
export async function cleanupOrphanedAgents() {
  const { getAgents, completeAgent: markComplete, evaluateTasks, getTaskById } = await import('./cos.js');
  const agents = await getAgents();
  let cleanedCount = 0;
  const orphanedTaskIds = [];

  // Get list of agents actively running in the CoS Runner
  const runnerActiveIds = new Set();
  const runnerAgentsList = await getActiveAgentsFromRunner().catch(() => []);
  for (const agent of runnerAgentsList) {
    runnerActiveIds.add(agent.id);
  }

  // Also sync runner agents to our local map for event handling
  if (runnerAgentsList.length > 0) {
    const synced = await syncRunnerAgents();
    if (synced > 0) {
      console.log(`🔄 Synced ${synced} agents from CoS Runner`);
    }
  }

  for (const agent of agents) {
    if (agent.status === 'running') {
      // Check if agent is tracked locally or in the runner
      const inLocalDirect = activeAgents.has(agent.id);
      const inLocalRunner = runnerAgents.has(agent.id);
      const inRemoteRunner = runnerActiveIds.has(agent.id);

      if (!inLocalDirect && !inLocalRunner && !inRemoteRunner) {
        // Before marking as orphaned, check if the process is actually still running
        // This prevents false positives when servers restart but agent process survives
        if (agent.pid) {
          const stillAlive = await isPidAlive(agent.pid);
          if (stillAlive) {
            console.log(`🔄 Agent ${agent.id} (PID ${agent.pid}) still running, re-syncing to runner tracking`);
            runnerAgents.set(agent.id, { id: agent.id, pid: agent.pid, taskId: agent.taskId });
            continue;
          }
        }

        console.log(`🧹 Cleaning up orphaned agent ${agent.id} (PID ${agent.pid || 'unknown'} not running)`);
        await markComplete(agent.id, {
          success: false,
          error: 'Agent process terminated unexpectedly',
          orphaned: true
        });
        cleanedCount++;

        // Track the task for retry
        if (agent.taskId) {
          orphanedTaskIds.push({ taskId: agent.taskId, agentId: agent.id });
        }
      }
    }
  }

  // Clean up worktrees for orphaned agents
  for (const { agentId } of orphanedTaskIds) {
    await cleanupAgentWorktree(agentId, false);
  }

  // Also clean up any orphaned worktrees not tracked by any agent
  const activeIds = new Set(getActiveAgentIds());
  await cleanupOrphanedWorktrees(ROOT_DIR, activeIds).catch(err => {
    console.log(`⚠️ Orphaned worktree cleanup failed: ${err.message}`);
  });

  // Handle orphaned tasks - reset for retry or create investigation task
  for (const { taskId, agentId } of orphanedTaskIds) {
    await handleOrphanedTask(taskId, agentId, getTaskById);
  }

  // Trigger evaluation to spawn new agents for retried tasks
  if (cleanedCount > 0) {
    emitLog('info', `Cleaned up ${cleanedCount} orphaned agents, triggering evaluation`, { cleanedCount });
    // Small delay to let state settle before evaluation
    setTimeout(() => {
      evaluateTasks().catch(err => {
        console.error(`❌ Failed to evaluate tasks after orphan cleanup: ${err.message}`);
      });
    }, 1000);
  }

  return cleanedCount;
}

/**
 * Handle an orphaned task - retry or create investigation
 */
async function handleOrphanedTask(taskId, agentId, getTaskById) {
  const task = await getTaskById(taskId).catch(() => null);
  if (!task) {
    emitLog('warn', `Could not find task ${taskId} for orphaned agent ${agentId}`, { taskId, agentId });
    return;
  }

  // Get current retry count from task metadata
  const retryCount = (task.metadata?.orphanRetryCount || 0) + 1;
  const taskType = task.taskType || 'user';

  if (retryCount < MAX_ORPHAN_RETRIES) {
    // Reset task to pending for automatic retry
    emitLog('info', `Resetting orphaned task ${taskId} for retry (attempt ${retryCount}/${MAX_ORPHAN_RETRIES})`, {
      taskId,
      retryCount,
      maxRetries: MAX_ORPHAN_RETRIES
    });

    await updateTask(taskId, {
      status: 'pending',
      metadata: {
        ...task.metadata,
        orphanRetryCount: retryCount,
        lastOrphanedAt: new Date().toISOString(),
        lastOrphanedAgentId: agentId
      }
    }, taskType);
  } else {
    // Max retries exceeded - create auto-approved investigation task
    emitLog('warn', `Task ${taskId} exceeded max orphan retries (${MAX_ORPHAN_RETRIES}), creating investigation task`, {
      taskId,
      retryCount
    });

    // Mark task as blocked
    await updateTask(taskId, {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        orphanRetryCount: retryCount,
        blockedReason: 'Max orphan retries exceeded'
      }
    }, taskType);

    // Create auto-approved investigation task (no approval required for orphan issues)
    const description = `[Auto-Fix] Investigate repeated agent orphaning for task ${taskId}

**Original Task**: ${(task.description || '').substring(0, 200)}
**Retry Attempts**: ${retryCount}
**Last Orphaned Agent**: ${agentId}

This task has failed ${retryCount} times due to agent orphaning. Investigate:
1. Check CoS Runner logs for errors
2. Verify process spawning is working correctly
3. Look for resource constraints (memory, CPU)
4. Check for network/connection issues between services

Once the issue is resolved, reset the original task to pending.`;

    await addTask({
      description,
      priority: 'HIGH',
      context: `Auto-generated from repeated orphan failures for task ${taskId}`,
      approvalRequired: false // Auto-approved for orphan issues
    }, 'internal').catch(err => {
      emitLog('error', `Failed to create investigation task: ${err.message}`, { taskId, error: err.message });
    });
  }
}

// Initialize spawner when module loads (async)
initSpawner().catch(err => {
  console.error(`❌ Failed to initialize spawner: ${err.message}`);
});

// Initialize task learning system
import('./taskLearning.js').then(taskLearning => {
  taskLearning.initTaskLearning();
}).catch(err => {
  console.error(`❌ Failed to initialize task learning: ${err.message}`);
});

// Clean up orphaned agents after a short delay (let other services init first)
setTimeout(cleanupOrphanedAgents, 2000);
