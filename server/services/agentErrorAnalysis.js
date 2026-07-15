/**
 * Agent Error Analysis
 *
 * Pattern-based failure analysis, investigation task creation, and
 * failed-task status resolution for CoS agents.
 */

import { emitLog } from './cosEvents.js';
import { addTask, updateTask, getAllTasks } from './cos.js';
import { cosEvents } from './cosEvents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { redactOutput } from '../lib/commandSecurity.js';
import { isTruthyMeta } from './agentState.js';

// Max retries before blocking a task
export const MAX_TASK_RETRIES = 3;

// Longest redacted failure snippet folded into a human-facing investigation body.
const SNIPPET_MAX_CHARS = 240;

// Machine-identity / network / PII fragments stripped before a captured failure
// snippet (or any interpolated free text) lands in a human-facing — and possibly
// federated — investigation task body. See the "Sensitive Data & Privacy" section
// in CLAUDE.md: the *shape* of the failure is what a human needs, never the live
// hostnames, paths, addresses, or secrets pulled off the running instance.
const SNIPPET_REDACTIONS = [
  // Home-dir paths that embed an OS username → strip the user segment only.
  // Handles both POSIX (`/Users/alice`) and Windows (`C:\Users\alice`) checkouts.
  [/[\\/](Users|home)[\\/][^\\/\s"']+/gi, '/$1/<user>'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // Tailscale MagicDNS / mDNS hostnames — consume ALL leading labels so a
  // multi-label name like `machine.tailnet.ts.net` doesn't leak `machine`.
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local)\b/gi, '<host>'],
  // IPv4 addresses (LAN / Tailscale / public alike).
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>'],
  // Bearer tokens and common secret-key formats.
  [/\bbearer\s+[\w.\-/+=]{12,}/gi, 'bearer <token>'],
  [/\bsk-[A-Za-z0-9\-_]{16,}/g, '<token>'],
];

/**
 * Redact machine identity, network info, PII, and secrets from free text before
 * it is embedded in an investigation-task body. Also normalizes whitespace and
 * caps length so a captured multi-line snippet stays a single readable line.
 * Pure — safe to unit-test directly.
 */
export function redactFailureSnippet(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let out = redactOutput(text); // JSON secret key/value pairs
  for (const [re, replacement] of SNIPPET_REDACTIONS) out = out.replace(re, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > SNIPPET_MAX_CHARS ? `${out.slice(0, SNIPPET_MAX_CHARS)}…` : out;
}

// Extract the single output line containing `index` — the matched failure line
// makes the most useful snippet without dragging in surrounding noise.
function snippetAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1; // -1 → 0 (first line)
  const nl = text.indexOf('\n', index);
  const end = nl === -1 ? text.length : nl;
  return text.slice(start, end).trim();
}

/**
 * Error patterns that warrant investigation tasks.
 * Patterns are checked in order — first match wins.
 * Categories help the learning system identify failure trends.
 *
 * Provenance (#2642): a pattern may carry a structured `origin`
 * (`'provider'` | `'runner'`) declaring that a match comes from a genuine
 * provider/runner signal (an `API Error: NNN` line, a Node error code, a
 * provider-specific error token) rather than the loose regex sweep over agent
 * output. When the same regex mixes a structured alternative with a loose
 * keyword alternative (e.g. `API Error: 429` vs a bare `rate limit`), a
 * `structuredMarker` sub-pattern gates the promotion: the structured `origin`
 * is only honored when the marker is present in the matched text; otherwise the
 * match is treated as `'output-scan'` (see `resolvePatternOrigin`). Patterns
 * with no `origin` are always `'output-scan'`. Task-learning's environmental
 * exclusion (metrics.js) diverts only non-`output-scan` failures, so a failing
 * test whose tail prints "rate limit" is NOT misread as an infra outage.
 */
export const ERROR_PATTERNS = [
  // ===== API & Authentication Errors =====
  {
    pattern: /API Error: 404.*model:\s*(\S+)/i,
    category: 'model-not-found',
    actionable: true,
    origin: 'provider', // fully structured — requires an `API Error: 404 … model:` line
    escalation: 'Set a valid model id for this task (or clear its model override so the CLI falls back to its own configured default), then approve the retry.',
    extract: (match, output, task, model) => ({
      message: `Model "${match[1]}" not found`,
      suggestedFix: `Update model configuration - "${match[1]}" doesn't exist. Check provider settings or task metadata.`,
      affectedModel: match[1],
      configuredModel: model
    })
  },
  {
    pattern: /(?:model:\s*)?["']?([A-Za-z0-9._:-]+)["']?\s+model is not supported|model\s+["']?([A-Za-z0-9._:-]+)["']?.*not supported/i,
    category: 'model-not-supported',
    actionable: true,
    // Intentionally no structured origin (#2642): the matched text is just the
    // "<model> model is not supported" phrase — a test asserting that string is
    // indistinguishable from a genuine provider rejection here, so it stays
    // output-scan. Real provider model rejections still divert via the structured
    // `API Error: 4NN`/`not_found_error` patterns and `detectTerminalModelError`.
    escalation: 'Pick a model the provider account supports (or clear the override to use the CLI default), then approve the retry.',
    extract: (match, output, task, model) => ({
      message: `Model "${match[1] || match[2] || model || 'configured model'}" is not supported`,
      suggestedFix: 'Update the provider model configuration or leave the model blank so the CLI can use its own configured default.',
      affectedModel: match[1] || match[2] || model,
      configuredModel: model
    })
  },
  {
    pattern: /API Error: 401|authentication|unauthorized/i,
    category: 'auth-error',
    actionable: true,
    origin: 'provider',
    structuredMarker: /API Error:\s*401/i, // loose `authentication`/`unauthorized` in output stays output-scan
    extract: () => ({
      message: 'Authentication failed',
      suggestedFix: 'Check API keys and provider configuration'
    })
  },
  {
    pattern: /API Error: 429|rate.?limit|too many requests/i,
    category: 'rate-limit',
    actionable: false, // Transient, retry will handle
    origin: 'provider',
    structuredMarker: /API Error:\s*429/i, // a bare `rate limit` / `too many requests` in output stays output-scan
    extract: () => ({
      message: 'Rate limit exceeded',
      suggestedFix: 'Wait and retry - temporary rate limiting'
    })
  },
  {
    // Catches both "hit your usage limit" and session limits like "hit your limit · resets 6am"
    pattern: /(?:hit your (?:usage )?limit|usage.?limit|quota exceeded|Upgrade to Pro|plan.?limit|daily.?limit|session.?limit|(?:^|\n)\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$))/i,
    category: 'usage-limit',
    actionable: true, // Need to switch provider
    // Promote only the distinctive provider-billing idioms (the matched
    // alternative, i.e. match[0]) to a structured provider signal; generic
    // phrasings like "quota exceeded" / "plan limit" / "daily limit" that a task's
    // own output can print stay output-scan and count as genuine failures (#2642).
    origin: 'provider',
    structuredMarker: /hit your (?:usage )?limit|Upgrade to Pro|Now using extra usage/i,
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
    origin: 'provider',
    structuredMarker: /API Error:\s*403/i, // loose `forbidden` in output stays output-scan
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
    origin: 'provider', // structured provider `not_found_error` API token
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
    escalation: 'Approve splitting the original task into smaller subtasks (or route it to a larger-context model), then retry — the retry already carries compaction hints.',
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
    origin: 'runner',
    structuredMarker: /ECONNREFUSED|ETIMEDOUT/i, // a bare `network error` in output stays output-scan
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
    escalation: 'Confirm the required CLI/tool is installed and on PATH for the agent user (or fix the command), then approve the retry.',
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
    origin: 'provider',
    structuredMarker: /overloaded_error/i, // loose `claude error`/`anthropic failed` in output stays output-scan
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
    escalation: 'Rephrase or narrow the original task description so it is actionable, then approve the retry — the agent declined it as written.',
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
    escalation: 'Reword the task description to avoid the content that tripped the safety filter, then approve the retry.',
    extract: () => ({
      message: 'Content filtered',
      suggestedFix: 'Request was blocked by content safety filter. Rephrase the task description.'
    })
  }
];

function getFailureAnalysisWindow(output) {
  return output
    .split('\n')
    .filter(l => l.trim())
    .slice(-200)
    .join('\n');
}

/**
 * Resolve the provenance origin for a matched ERROR_PATTERN (#2642). Returns the
 * pattern's structured `origin` (`'provider'`/`'runner'`) only when it is
 * declared AND — if a `structuredMarker` sub-pattern is present — that marker
 * appears somewhere in the failure window. A pattern with no structured origin,
 * or a `structuredMarker` that is absent, falls through to `'output-scan'`,
 * marking the classification as coming solely from the loose regex sweep.
 *
 * The marker is tested against the WHOLE analysis window, not just the matched
 * substring: the main pattern's alternation returns the LEFTMOST match, which
 * may be a loose alternative (a bare `rate limit`) even when a genuine
 * `API Error: 429` appears later in the same output — so a real provider signal
 * anywhere in the window still promotes the classification (#2642 review). Pure.
 */
function resolvePatternOrigin(errorDef, analysisOutput) {
  if (!errorDef.origin) return 'output-scan';
  if (errorDef.structuredMarker && !errorDef.structuredMarker.test(analysisOutput || '')) return 'output-scan';
  return errorDef.origin;
}

/**
 * Analyze agent failure output and categorize the error.
 */
export function analyzeAgentFailure(output, task, model) {
  // Agent produced no meaningful output — likely failed to start
  if (!output || output.trim().length < 50) {
    return {
      category: 'startup-failure',
      actionable: false,
      // Structural runner signal (#2642): inferred from the process producing no
      // usable output, not from a regex sweep — so it stays environmental-eligible.
      origin: 'runner',
      message: 'Agent failed to start or produced no output',
      suggestedFix: 'Agent process exited immediately. Check system resources and provider availability.',
      snippet: (output || '').trim(),
      escalation: null
    };
  }

  const analysisOutput = getFailureAnalysisWindow(output);

  for (const errorDef of ERROR_PATTERNS) {
    const match = analysisOutput.match(errorDef.pattern);
    if (match) {
      const extracted = errorDef.extract(match, analysisOutput, task, model);
      return {
        category: errorDef.category,
        actionable: errorDef.actionable,
        // Provenance (#2642): 'provider'/'runner' only when a structured marker
        // is present in the failure window; a loose keyword match stays 'output-scan'.
        origin: resolvePatternOrigin(errorDef, analysisOutput),
        // Captured for the human-facing investigation body; redacted at embed time.
        snippet: snippetAround(analysisOutput, match.index ?? 0),
        // Optional category-specific "what to approve" prose (may be undefined).
        escalation: errorDef.escalation || null,
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
    // Pure regex/keyword sweep over the output tail (#2642) — never diverted as
    // environmental (and 'unknown' isn't an environmental category anyway).
    origin: 'output-scan',
    message: summary,
    details: contextLines.map(l => l.trim()).join('\n'),
    snippet: contextLines.map(l => l.trim()).join(' '),
    escalation: null,
    suggestedFix: 'Error did not match known patterns. Review the details or agent output logs.'
  };
}

// ===== Investigation-task creation guards (#2615) =====

// An investigation in any of these states means the failure cause is already
// being tracked — a repeat failure with the same fingerprint is the SAME cause,
// not new work. `completed` is the only terminal status in the task vocabulary
// (see taskParser.js STATUS_MAP); everything else — including `challenged`,
// where a task can park for days awaiting user arbitration — stays open, so a
// fresh task is only allowed once the prior cause was actually dealt with.
const OPEN_INVESTIGATION_STATUSES = new Set(['pending', 'in_progress', 'challenged', 'blocked']);

// Rolling circuit breaker across ALL fingerprints, mirroring autoFixer.js's
// tripCircuit: at most INVESTIGATION_CIRCUIT_MAX_CREATIONS investigation tasks
// per rolling window. A systemic failure storm (provider outage, broken spawn
// path) fails MANY distinct tasks at once, each minting a distinct fingerprint —
// the per-fingerprint dedup alone can't stop that fan-out. The window is rolling:
// stamps older than the window are pruned on every check, so the circuit
// auto-closes once creations age out (no manual reset needed).
export const INVESTIGATION_CIRCUIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const INVESTIGATION_CIRCUIT_MAX_CREATIONS = 3;
let investigationCreationStamps = []; // ms timestamps, newest-last

function investigationCircuitOpen(now) {
  investigationCreationStamps = investigationCreationStamps.filter(t => now - t < INVESTIGATION_CIRCUIT_WINDOW_MS);
  return investigationCreationStamps.length >= INVESTIGATION_CIRCUIT_MAX_CREATIONS;
}

// Test hook — the stamp list is module state, so suites reset it between cases.
export function __resetInvestigationCircuit() {
  investigationCreationStamps = [];
}

/**
 * Durable dedup key for investigation tasks: same failure category against the
 * same kind of task in the same app is the same cause. Deliberately NOT keyed
 * on the free-text failure message — for `unknown`-category failures that is a
 * raw agent-output line that varies per run, which is exactly the dedup hole
 * that let near-identical investigations pile up (#2615).
 */
export function buildInvestigationFingerprint(originalTask, analysis) {
  const category = analysis?.category || 'unknown';
  const kind = originalTask?.metadata?.analysisType
    || originalTask?.metadata?.selfImprovementType
    || originalTask?.taskType
    || 'task';
  const app = originalTask?.metadata?.app || 'none';
  return `${category}:${kind}:${app}`;
}

// Stable headline every investigation task ever created starts with — the one
// signal that exists on BOTH new tasks and pre-#2615 tasks (and on tasks synced
// from not-yet-upgraded federated peers, which a local migration couldn't fix).
const INVESTIGATION_HEADLINE_PREFIX = '[Auto] Investigate agent failure';

/**
 * Is this task an investigation task? Prefers the durable metadata marker;
 * falls back to the legacy headline shape so investigations persisted before
 * the marker existed still never spawn meta-investigations.
 */
export function isInvestigationTask(task) {
  if (isTruthyMeta(task?.metadata?.isInvestigation)) return true;
  return typeof task?.description === 'string'
    && task.description.trimStart().startsWith(INVESTIGATION_HEADLINE_PREFIX);
}

// Find an existing investigation task (user or internal queue) still tracking
// this fingerprint in a non-terminal status.
async function findOpenInvestigation(fingerprint) {
  const { user, cos } = await getAllTasks();
  const tasks = [...(user?.tasks || []), ...(cos?.tasks || [])];
  return tasks.find(t =>
    OPEN_INVESTIGATION_STATUSES.has(t.status) &&
    t.metadata?.investigationFingerprint === fingerprint
  ) || null;
}

/**
 * Create an investigation task in COS-TASKS.md for a failed agent.
 *
 * Guarded two ways (#2615): a durable fingerprint dedup (one open investigation
 * per failure cause — returns the existing task when it fires) and a rolling
 * circuit breaker (returns null when open). See maybeCreateInvestigationTask
 * for the meta-cascade guard.
 *
 * Serialized on a module-level promise tail: a failure storm fires several
 * concurrent finalize chains, and without the tail two same-fingerprint creates
 * can both pass the fingerprint scan (and both read a below-cap circuit) before
 * either addTask lands — the exact TOCTOU the guards exist to close. Each
 * caller still sees its own result/rejection; the tail itself never poisons.
 */
let investigationCreateTail = Promise.resolve();

export function createInvestigationTask(agentId, originalTask, errorAnalysis) {
  const run = investigationCreateTail.then(() => doCreateInvestigationTask(agentId, originalTask, errorAnalysis));
  investigationCreateTail = run.catch(() => {});
  return run;
}

async function doCreateInvestigationTask(agentId, originalTask, errorAnalysis) {
  const analysis = errorAnalysis || {};
  const category = analysis.category || 'unknown';
  const rawMessage = analysis.message || 'Agent failed with an unrecognized error';
  const modelAttribution = analysis.affectedModel || analysis.configuredModel || null;

  // Durable-fingerprint dedup: one open investigation per failure cause.
  const fingerprint = buildInvestigationFingerprint(originalTask, analysis);
  const existing = await findOpenInvestigation(fingerprint);
  if (existing) {
    emitLog('info', `⏭️ Skipping duplicate investigation for ${fingerprint}: ${existing.id} is still ${existing.status}`, {
      agentId, taskId: originalTask.id, fingerprint, existingTaskId: existing.id, existingStatus: existing.status
    });
    // Union this failure's task id into the surviving investigation — both in
    // metadata AND appended to the human/agent-facing body — so the record
    // names EVERY task blocked on this cause: resolving it should unblock all
    // of them, not just the first one mentioned in "What unblocks".
    const affected = Array.isArray(existing.metadata?.affectedTasks) ? existing.metadata.affectedTasks : [];
    if (originalTask.id && !affected.includes(originalTask.id)) {
      await updateTask(existing.id, {
        description: `${existing.description}\n- Also blocks task \`${originalTask.id}\` (same cause; agent \`${agentId}\`).`,
        metadata: { affectedTasks: [...affected, originalTask.id] }
      }, 'internal');
    }
    return existing;
  }

  // Rolling circuit breaker: cap creations per window across all fingerprints.
  const now = Date.now();
  if (investigationCircuitOpen(now)) {
    emitLog('warn', `🔌 Investigation circuit OPEN — ${INVESTIGATION_CIRCUIT_MAX_CREATIONS} investigations created within the last hour; suppressing task for ${fingerprint}`, {
      agentId, taskId: originalTask.id, fingerprint
    });
    return null;
  }

  // Every interpolated free-text field is redacted before it lands in the body —
  // this task is human-facing and may sync across federated peers, so no
  // hostnames/paths/IPs/PII/secrets from the live instance may leak in. `message`
  // for the `unknown` category is a raw agent output line, so it needs the same
  // scrub as the snippet — not just the snippet/description fields.
  const message = redactFailureSnippet(rawMessage) || rawMessage;
  const snippet = redactFailureSnippet(analysis.snippet || analysis.details || rawMessage);
  const originalDesc = redactFailureSnippet((originalTask.description || '').substring(0, 160)) || '(no description)';

  // Prefer the pattern's category-specific escalation prose; fall back to the
  // generic suggestedFix so uncustomized categories still read as an action.
  const whatToApprove = analysis.escalation
    || analysis.suggestedFix
    || 'Review the agent output, decide whether to fix the underlying config/code and retry, or close the task.';

  // The fingerprint rides in the headline so addTask's first-line dedup —
  // which sees no `metadata.app` on investigation tasks — tracks fingerprint
  // identity exactly: identical messages from different apps OR different
  // task kinds/categories can never falsely collapse into one task, and
  // same-fingerprint repeats are already caught by the scan above. The app
  // is deliberately NOT passed as `app` to addTask, which would change
  // workspace routing for the investigation agent.
  const description = `${INVESTIGATION_HEADLINE_PREFIX} [${fingerprint}]: ${message}

## What happened
Agent \`${agentId}\` failed while working on task \`${originalTask.id}\` (${originalDesc}).
- **Classification**: ${category} — ${message}
- **Provider/model**: ${modelAttribution || 'not attributed'}
${snippet ? `- **Failure snippet (redacted)**:\n  > ${snippet}` : '- **Failure snippet**: (none captured)'}

## What to approve
${whatToApprove}

## What unblocks
Approving and applying the fix lets the original task \`${originalTask.id}\` be retried; it will resume: ${originalDesc}.`;

  const investigationTask = await addTask({
    description,
    priority: 'HIGH',
    context: `Auto-generated from agent ${agentId} failure`,
    approvalRequired: true, // Require human approval before auto-fixing
    isInvestigation: true, // Meta-cascade guard marker (#2615)
    investigationFingerprint: fingerprint,
    affectedTasks: [originalTask.id] // later same-fingerprint failures union in
  }, 'internal');

  // Count only genuine creations against the circuit — addTask's own
  // description-level dedup returning an existing task is not a new creation.
  if (!investigationTask.duplicate) investigationCreationStamps.push(now);

  emitLog('info', `Created investigation task ${investigationTask.id} for failed agent ${agentId}`, {
    agentId,
    taskId: investigationTask.id,
    errorCategory: category
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
  // Meta-cascade guard (#2615): a failed investigation task must never spawn an
  // investigation of the investigation. isInvestigationTask prefers the durable
  // metadata marker (isTruthyMeta covers the markdown round-trip, where boolean
  // metadata comes back as the string 'true') and falls back to the legacy
  // headline shape for tasks persisted before the marker existed.
  if (isInvestigationTask(task)) {
    emitLog('info', `⏭️ Skipping meta-investigation for ${task.id}: failed task is itself an investigation`, { agentId, taskId: task.id, category: analysis?.category });
    return;
  }
  await createInvestigationTask(agentId, task, analysis).catch(err => {
    emitLog('warn', `Failed to create investigation task: ${err.message}`, { agentId, taskId: task.id, category: analysis?.category });
  });
}

/**
 * Pure decision logic for {@link resolveFailedTaskUpdate} — no I/O, no clock.
 *
 * Decides whether a failed task should be blocked or retried, the metadata
 * fields to merge over `task.metadata` (timestamps excluded — they belong to
 * the async wrapper), and the analysis to hand to an investigation task.
 * Extracted so the branching can be unit-tested directly (see
 * `agentErrorAnalysis.test.js`) instead of through a drift-prone inline copy.
 * Whether an investigation task is actually created stays the sole concern of
 * {@link maybeCreateInvestigationTask}.
 *
 * @returns {{
 *   status: 'blocked'|'pending',
 *   investigationAnalysis: object|null,
 *   metadataUpdates: { failureCount?: number, lastErrorCategory?: string, [k: string]: unknown }
 * }}
 */
export function resolveFailedTaskDecision(task, errorAnalysis) {
  // Actionable errors get blocked immediately. The investigation task (created
  // by the wrapper unless the failure is an API-access error) gets the original
  // analysis verbatim.
  if (errorAnalysis?.actionable) {
    return {
      status: 'blocked',
      investigationAnalysis: errorAnalysis,
      metadataUpdates: {
        blockedReason: errorAnalysis.message,
        blockedCategory: errorAnalysis.category
      }
    };
  }

  // Non-actionable errors: track retry count and block once the task has either
  // failed too many times in a row or spawned too many agents in total.
  const failureCount = (Number(task.metadata?.failureCount) || 0) + 1;
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  const lastErrorCategory = errorAnalysis?.category || 'unknown';

  if (totalSpawns >= MAX_TOTAL_SPAWNS || failureCount >= MAX_TASK_RETRIES) {
    const blockedAnalysis = {
      ...(errorAnalysis || {}),
      message: `Task failed ${failureCount} times: ${errorAnalysis?.message || 'unknown error'}`,
      suggestedFix: `Task has failed ${failureCount} consecutive times with ${lastErrorCategory} errors. ${errorAnalysis?.suggestedFix || 'Investigate agent output logs.'}`,
      category: lastErrorCategory
    };
    return {
      status: 'blocked',
      investigationAnalysis: blockedAnalysis,
      metadataUpdates: {
        failureCount,
        lastErrorCategory,
        blockedReason: `Max retries exceeded (${failureCount}/${MAX_TASK_RETRIES}): ${lastErrorCategory}`,
        blockedCategory: lastErrorCategory
      }
    };
  }

  // Retry: propagate compaction hints for retry prompt injection.
  const compaction = errorAnalysis?.compaction || null;
  return {
    status: 'pending',
    investigationAnalysis: null,
    metadataUpdates: {
      failureCount,
      lastErrorCategory,
      ...(compaction && { compaction })
    }
  };
}

/**
 * Pure decision for the type-LEVEL failure ledger (#2616), distinct from the
 * per-instance retry decision above. Given a finished run's exit-code success,
 * whether the user terminated it, and the programmatic-I/O hook result (if any),
 * decide what signal to feed the per-type consecutive-failure ledger:
 *
 *   - `'skip'`    — don't touch the ledger (user-terminated run).
 *   - `'success'` — reset the type's failure counter.
 *   - `'failure'` — increment it (with `category`).
 *
 * The key case this exists for: a layered-intelligence run that exits 0 but whose
 * `.agent-done` output was unparseable (`hookResult.outcome.reason ===
 * 'unparseable-response'`) — or whose hook threw (`hookResult.threw`) — produced
 * nothing usable, so it's a FAILURE even though the exit code says success. Other
 * benign hook reasons (no-proposal, duplicate, scope-suppressed) leave the
 * exit-code verdict intact. Extracted pure so the branching is unit-tested here.
 *
 * @returns {{ record: 'skip'|'success'|'failure', category: string|null }}
 */
export function resolveTypeFailureSignal({ success, terminatedByUser = false, hookResult = null, errorCategory = null } = {}) {
  if (terminatedByUser) return { record: 'skip', category: null };

  // An already-failed run keeps its real exit-code category; the hook override
  // only UPGRADES an exit-0 (`success`) run to a failure (the exit-0-but-
  // unparseable / thrown-hook case). A hook that throws on top of a run that
  // already failed for e.g. `rate-limit` must not relabel the cause `hook-error`.
  if (!success) return { record: 'failure', category: errorCategory || 'unknown' };

  if (hookResult?.ran) {
    if (hookResult.threw) return { record: 'failure', category: 'hook-error' };
    if (hookResult.outcome?.reason === 'unparseable-response') return { record: 'failure', category: 'unparseable-response' };
  }

  return { record: 'success', category: null };
}

/**
 * Handle task status update after agent failure.
 * Tracks retry count and blocks the task after MAX_TASK_RETRIES,
 * creating an investigation task instead of retrying endlessly.
 *
 * Returns { status, metadata } to apply to the task.
 */
export async function resolveFailedTaskUpdate(task, errorAnalysis, agentId) {
  const decision = resolveFailedTaskDecision(task, errorAnalysis);
  const { failureCount, lastErrorCategory } = decision.metadataUpdates;

  // Actionable errors get blocked immediately (investigation task created unless API access is denied)
  if (errorAnalysis?.actionable) {
    emitLog('warn', `🚫 Task ${task.id} blocked: ${errorAnalysis.message} (${errorAnalysis.category})`, {
      taskId: task.id, category: errorAnalysis.category
    });
    await maybeCreateInvestigationTask(agentId, task, decision.investigationAnalysis);
    return {
      status: decision.status,
      metadata: { ...task.metadata, ...decision.metadataUpdates, blockedAt: new Date().toISOString() }
    };
  }

  if (decision.status === 'blocked') {
    emitLog('warn', `🚫 Task ${task.id} blocked after ${failureCount} failures (${lastErrorCategory})`, {
      taskId: task.id, failureCount, category: lastErrorCategory
    });
    await maybeCreateInvestigationTask(agentId, task, decision.investigationAnalysis);
    const now = new Date().toISOString();
    return {
      status: 'blocked',
      metadata: { ...task.metadata, ...decision.metadataUpdates, lastFailureAt: now, blockedAt: now }
    };
  }

  emitLog('info', `🔄 Task ${task.id} retry ${failureCount}/${MAX_TASK_RETRIES} (${lastErrorCategory})`, {
    taskId: task.id, failureCount, maxRetries: MAX_TASK_RETRIES, category: lastErrorCategory
  });
  return {
    status: 'pending',
    metadata: { ...task.metadata, ...decision.metadataUpdates, lastFailureAt: new Date().toISOString() }
  };
}
