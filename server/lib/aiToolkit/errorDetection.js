/** Expose provider error categories, recovery classifiers and streaming detectors. */

import { ERROR_CATEGORIES } from './internal/errorPatterns/categories.js';
import {
  contentRefusalRule,
  localOomRule,
  ollamaToolCallRule,
  modelCapacityRule,
  codexModelAccessRule,
  unknownArchitectureRule,
  unsupportedModelRule,
} from './internal/errorPatterns/provider.js';
import { rateLimitRule, usageLimitRule, extractWaitTime, isRateLimitStatus, normalizeRateLimitHeaders } from './internal/errorPatterns/rateLimits.js';
import { spawnRule, networkRule, timeoutRule } from './internal/errorPatterns/cliProcess.js';
import { authRule, billingRule, isAuthErrorStatus } from './internal/errorPatterns/authBilling.js';

export { ERROR_CATEGORIES, isRunCanceledError, isRuntimeBudgetError } from './internal/errorPatterns/categories.js';
export {
  RATE_LIMIT_SIGNATURE,
  USAGE_LIMIT_BANNER_SIGNATURE,
  USAGE_LIMIT_SIGNATURE,
  extractWaitTime,
  isRateLimitStatus,
  normalizeRateLimitHeaders,
} from './internal/errorPatterns/rateLimits.js';
export {
  isContentRefusalError,
  createContentRefusalDetector,
  detectLocalRuntimeOom,
  createLocalRuntimeOomDetector,
  detectTruncatedResponse,
  createTruncatedResponseDetector,
  detectModelAtCapacity,
  createModelAtCapacityDetector,
} from './internal/errorPatterns/provider.js';
export {
  detectTerminalModelError,
  createTerminalModelErrorDetector,
  detectTerminalRequestTimeout,
  createTerminalRequestTimeoutDetector,
  detectTuiRetryBanner,
  describeTuiRetryStall,
} from './internal/errorPatterns/cliProcess.js';
export {
  detectImmediateFallbackSignal,
  createImmediateFallbackSignalDetector,
  detectClaudeSessionLimitBanner,
  createClaudeSessionLimitBannerDetector,
  CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS,
} from './internal/errorPatterns/fallbackSignals.js';
export { isAuthErrorStatus } from './internal/errorPatterns/authBilling.js';

// First match wins, including when several providers use the same vocabulary.
const ERROR_PATTERNS = [
  contentRefusalRule,
  localOomRule,
  ollamaToolCallRule,
  modelCapacityRule,
  billingRule,
  rateLimitRule,
  usageLimitRule,
  codexModelAccessRule,
  unknownArchitectureRule,
  authRule,
  spawnRule,
  unsupportedModelRule,
  networkRule,
  timeoutRule,
];

export function analyzeError(errorText, exitCode = null, { prompt } = {}) {
  if (!errorText && exitCode === 0) {
    return {
      hasError: false,
      category: null,
      message: null,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  let text = String(errorText || '');
  if (typeof prompt === 'string' && prompt.trim()) {
    // Codex prints `user` followed by the complete input on its diagnostic
    // stream. Match the KNOWN submitted body, not guessed transcript markers:
    // tool schemas and quoted errors in that body are not provider failures.
    // Keep the original transcript on disk and normalize only this scan.
    text = text.replace(/\r\n/g, '\n');
    const echo = `\nuser\n${prompt.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
    text = text.replace(echo, '\n');
  }

  const outputLimit = exitCode && text.match(/^API Error: (Claude's response exceeded the \d+ output token maximum\.[ \t\r\n]+To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable\.)[ \t\r]*$/m);
  if (outputLimit) {
    return {
      hasError: true, category: ERROR_CATEGORIES.OUTPUT_LIMIT, message: outputLimit[1].replace(/\s+/g, ' '),
      waitTime: null, requiresFallback: false, actionable: true,
      suggestedFix: 'Increase the configured output allowance or request a shorter response.',
    };
  }

  for (const errorPattern of ERROR_PATTERNS) {
    if (errorPattern.pattern.test(text)) {
      return {
        hasError: true,
        category: errorPattern.category,
        message: extractErrorMessage(text),
        waitTime: errorPattern.extractWaitTime ? extractWaitTime(text) : null,
        requiresFallback: errorPattern.requiresFallback,
        actionable: errorPattern.actionable,
        suggestedFix: errorPattern.suggestedFix
      };
    }
  }

  if (exitCode !== 0 && exitCode !== null) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.UNKNOWN,
      message: extractErrorMessage(text) || `Process exited with code ${exitCode}`,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  return {
    hasError: false,
    category: null,
    message: null,
    waitTime: null,
    requiresFallback: false,
    actionable: false,
    suggestedFix: null
  };
}

// Undo JSON string escaping in a value lifted out of a raw error BODY. One pass,
// so an escaped backslash can't be re-read as the start of the next escape
// (`C:\\ntemp` stays a path, not a newline). Only the `json: true` patterns
// below use it — a plain `Error: …` line is literal text, and unescaping it
// would rewrite a Windows path.
const JSON_STRING_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
const unescapeJsonString = (value) =>
  value.replace(/\\(.)/g, (_, ch) => JSON_STRING_ESCAPES[ch] ?? ch);

function extractErrorMessage(text) {
  if (!text) return '';

  const patterns = [
    { re: /Error:\s*(.+?)(?:\n|$)/i },
    // A JSON error body routinely ESCAPES quotes inside the value — Ollama
    // reports `{"error":"\"all-minilm:latest\" does not support chat"}`. A
    // `[^"]+` value stops at that first escaped quote and returns a lone
    // backslash as "the message", which is what a log line and an investigation
    // task then carried instead of the actual sentence. Consume escape pairs.
    { re: /error":\s*"((?:[^"\\]|\\.)+)"/i, json: true },
    { re: /message":\s*"((?:[^"\\]|\\.)+)"/i, json: true },
    { re: /failed:\s*(.+?)(?:\n|$)/i }
  ];

  for (const { re, json } of patterns) {
    const match = text.match(re);
    if (match) {
      return (json ? unescapeJsonString(match[1]) : match[1]).trim();
    }
  }

  const lines = text.split('\n').filter(line => line.trim());
  return lines[0]?.substring(0, 200) || text.substring(0, 200);
}

// Ollama can encode an error object as a JSON string inside another error
// object. Follow only error/message fields, not echoed prompts or other body
// fields, and require the actual error message to match.
function isUnsupportedImageError(body) {
  let value = body;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^multimodal data provided, but model does not support multimodal requests\.?$/i.test(text)) return true;
      if (text.length > 65536) return false;
      try { value = JSON.parse(text); } catch { return false; }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      value = value.error ?? value.message;
    } else return false;
  }
  return false;
}

export function analyzeHttpError(response) {
  const { status, statusText, body, headers } = response;
  const rateLimitWindow = normalizeRateLimitHeaders(headers);

  if (status >= 200 && status < 300) {
    return {
      hasError: false,
      category: null,
      message: null,
      waitTime: null,
      requiresFallback: false,
      actionable: false,
      suggestedFix: null
    };
  }

  if (isRateLimitStatus(status)) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.RATE_LIMIT,
      message: `Rate limit exceeded (${status})`,
      waitTime: extractWaitTime(body),
      rateLimitWindow,
      requiresFallback: false,
      actionable: false,
      suggestedFix: 'Wait and retry - temporary rate limiting'
    };
  }

  if (isAuthErrorStatus(status)) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.AUTH_ERROR,
      message: `Authentication failed (${status})`,
      waitTime: null,
      requiresFallback: true,
      actionable: true,
      suggestedFix: 'Check API key configuration for this provider'
    };
  }

  // Ollama may wrap the upstream JSON error inside another JSON string. Match
  // only this specific 400 and emit a fixed message rather than copying an
  // untrusted response body (which may contain prompts or credentials).
  if (status === 400 && isUnsupportedImageError(body)) {
    return {
      hasError: true,
      category: ERROR_CATEGORIES.IMAGE_UNSUPPORTED,
      message: 'The selected model does not support image inputs.',
      waitTime: null,
      requiresFallback: false,
      actionable: true,
      suggestedFix: 'Choose a vision-capable model for this request.'
    };
  }

  if (body) {
    // analyzeError returns `hasError: false` when no known pattern matches;
    // for a non-2xx response that's still a failure — preserve it as an
    // UNKNOWN HTTP error instead of letting the caller treat it as success.
    const bodyAnalysis = analyzeError(body);
    if (bodyAnalysis.hasError) return { ...bodyAnalysis, rateLimitWindow };
  }

  return {
    hasError: true,
    category: ERROR_CATEGORIES.UNKNOWN,
    // Status 0 is PortOS's sentinel for "no HTTP response" (a fetch rejection
    // or a failed provider-readiness hook). Preserve that transport detail;
    // calling it `HTTP 0` discards the only useful diagnosis and HTTP has no
    // status zero in the first place.
    message: statusText || (status === 0 && body ? extractErrorMessage(String(body)) : `HTTP ${status}`),
    waitTime: null,
    requiresFallback: false,
    actionable: false,
    suggestedFix: null
  };
}
