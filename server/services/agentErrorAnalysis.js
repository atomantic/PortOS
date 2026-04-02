/**
 * Agent Error Analysis
 *
 * Pattern-based failure analysis, investigation task creation, and
 * failed-task status resolution for CoS agents.
 */

import { emitLog } from './cosEvents.js';
import { addTask, updateTask } from './cos.js';
import { cosEvents } from './cosEvents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';

// Max retries before blocking a task
export const MAX_TASK_RETRIES = 3;

/**
 * Error patterns that warrant investigation tasks.
 * Patterns are checked in order — first match wins.
 * Categories help the learning system identify failure trends.
 */
export const ERROR_PATTERNS = [
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
    // Catches both "hit your usage limit" and session limits like "hit your limit · resets 6am"
    pattern: /(?:hit your (?:usage )?limit|usage.?limit|quota exceeded|Upgrade to Pro|plan.?limit|daily.?limit|session.?limit)/i,
    category: 'usage-limit',
    actionable: true, // Need to switch provider
    extract: (match, output) => {
      const timeMatch = output.match(/(?:try again in|resets?)\s+(.+?)(?:\.|·|\n|$)/im);
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
    pattern: /API Error: 400|invalid_request_error|bad.?request/i,
    category: 'bad-request',
    actionable: true,
    extract: (match, output) => {
      const msgMatch = output.match(/"message":\s*"([^"]{1,150})"/);
      return {
        message: `Bad request${msgMatch ? `: ${msgMatch[1]}` : ''}`,
        suggestedFix: 'API rejected the request as invalid. Check prompt formatting, tool names, and parameter sizes.'
      };
    }
  },
  {
    pattern: /API Error: 403|forbidden/i,
    category: 'forbidden',
    actionable: true,
    extract: () => ({
      message: 'API access forbidden',
      suggestedFix: 'API key lacks permission for this operation. Check API key permissions and provider configuration.'
    })
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
    extract: (match, output) => ({
      message: 'Context length exceeded',
      suggestedFix: 'Task is too large for the context window. Break into smaller subtasks or use a model with larger context.',
      compaction: {
        needed: true,
        reason: 'context-limit',
        outputSize: Buffer.byteLength(output || ''),
        retryHints: [
          'Summarize intermediate findings concisely instead of reproducing full file contents',
          'Use targeted reads (offset/limit) instead of reading entire files',
          'Avoid listing full directory trees — only reference files you modify',
          'Keep your Task Summary under 30 lines'
        ]
      }
    })
  },
  {
    pattern: /output.?length|max.?output|response.?too.?long/i,
    category: 'output-length',
    actionable: false,
    extract: (match, output) => ({
      message: 'Output length exceeded',
      suggestedFix: 'Agent response exceeded output limit. Task may need to be scoped down.',
      compaction: {
        needed: true,
        reason: 'output-limit',
        outputSize: Buffer.byteLength(output || ''),
        retryHints: [
          'Limit output to changed files and a brief summary only',
          'Do not echo file contents back — just reference file paths and line numbers',
          'Combine related changes into single descriptions'
        ]
      }
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

  // ===== Limit & Billing Errors =====
  {
    pattern: /(?:maximum|max).*(?:turns?|iterations?|steps?)|turn.?limit|max.?turns|stopped after \d+ turns/i,
    category: 'turn-limit',
    actionable: false,
    extract: () => ({
      message: 'Agent reached turn limit',
      suggestedFix: 'Task exceeded the maximum number of agent turns. Break into smaller subtasks or increase turn limit.'
    })
  },
  {
    pattern: /(?:billing|subscription|payment).?(?:error|issue|required|expired|failed)/i,
    category: 'billing-error',
    actionable: true,
    extract: () => ({
      message: 'Billing/subscription issue',
      suggestedFix: 'Provider billing or subscription problem. Check provider account status.'
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
 * Analyze agent failure output and categorize the error.
 */
export function analyzeAgentFailure(output, task, model) {
  // Agent produced no meaningful output — likely failed to start
  if (!output || output.trim().length < 50) {
    return {
      category: 'startup-failure',
      actionable: false,
      message: 'Agent failed to start or produced no output',
      suggestedFix: 'Agent process exited immediately. Check system resources and provider availability.'
    };
  }

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

  // No pattern matched — extract meaningful context from the output
  const lines = output.split('\n').filter(l => l.trim());
  const lastLines = lines.slice(-20);

  const errorKeywords = /\b(error|fail|exception|fatal|panic|abort|crash|denied|refused|invalid|cannot|could not|unable to)\b/i;
  const errorLines = lastLines.filter(l => errorKeywords.test(l)).slice(0, 5);

  const contextLines = errorLines.length > 0 ? errorLines : lastLines.slice(-5);
  const summary = contextLines[0]?.trim().substring(0, 120) || 'Agent failed with unrecognized error';

  return {
    category: 'unknown',
    actionable: false,
    message: summary,
    details: contextLines.map(l => l.trim()).join('\n'),
    suggestedFix: 'Error did not match known patterns. Review the details or agent output logs.'
  };
}

/**
 * Create an investigation task in COS-TASKS.md for a failed agent.
 */
export async function createInvestigationTask(agentId, originalTask, errorAnalysis) {
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

// Error categories where LLM API access is blocked or denied — spawning an
// investigation agent would fail for the same reason, so skip it.
export const API_ACCESS_ERROR_CATEGORIES = new Set([
  'auth-error',
  'forbidden',
  'usage-limit',
]);

export async function maybeCreateInvestigationTask(agentId, task, analysis) {
  if (API_ACCESS_ERROR_CATEGORIES.has(analysis?.category)) {
    emitLog('debug', `⏭️ Skipping investigation task for ${task.id}: API access error (${analysis.category})`, { agentId, taskId: task.id, category: analysis.category });
    return;
  }
  await createInvestigationTask(agentId, task, analysis).catch(err => {
    emitLog('warn', `Failed to create investigation task: ${err.message}`, { agentId, taskId: task.id, category: analysis?.category });
  });
}

/**
 * Handle task status update after agent failure.
 * Tracks retry count and blocks the task after MAX_TASK_RETRIES,
 * creating an investigation task instead of retrying endlessly.
 *
 * Returns { status, metadata } to apply to the task.
 */
export async function resolveFailedTaskUpdate(task, errorAnalysis, agentId) {
  // Actionable errors get blocked immediately (investigation task created unless API access is denied)
  if (errorAnalysis?.actionable) {
    emitLog('warn', `🚫 Task ${task.id} blocked: ${errorAnalysis.message} (${errorAnalysis.category})`, {
      taskId: task.id, category: errorAnalysis.category
    });
    await maybeCreateInvestigationTask(agentId, task, errorAnalysis);
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
  const failureCount = (Number(task.metadata?.failureCount) || 0) + 1;
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  const lastErrorCategory = errorAnalysis?.category || 'unknown';

  if (totalSpawns >= MAX_TOTAL_SPAWNS || failureCount >= MAX_TASK_RETRIES) {
    emitLog('warn', `🚫 Task ${task.id} blocked after ${failureCount} failures (${lastErrorCategory})`, {
      taskId: task.id, failureCount, category: lastErrorCategory
    });
    const blockedAnalysis = {
      ...(errorAnalysis || {}),
      message: `Task failed ${failureCount} times: ${errorAnalysis?.message || 'unknown error'}`,
      suggestedFix: `Task has failed ${failureCount} consecutive times with ${lastErrorCategory} errors. ${errorAnalysis?.suggestedFix || 'Investigate agent output logs.'}`,
      category: lastErrorCategory
    };
    await maybeCreateInvestigationTask(agentId, task, blockedAnalysis);
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

  // Propagate compaction hints to task metadata for retry prompt injection
  const compaction = errorAnalysis?.compaction || null;

  return {
    status: 'pending',
    metadata: {
      ...task.metadata,
      failureCount,
      lastFailureAt: new Date().toISOString(),
      lastErrorCategory,
      ...(compaction && { compaction })
    }
  };
}
