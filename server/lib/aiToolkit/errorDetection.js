/**
 * Error Detection Utility
 *
 * Detects and categorizes errors from AI provider responses,
 * particularly rate limits and usage limits that require fallback handling.
 */

export const ERROR_CATEGORIES = {
  RATE_LIMIT: 'rate-limit',
  USAGE_LIMIT: 'usage-limit',
  AUTH_ERROR: 'auth-error',
  MODEL_NOT_FOUND: 'model-not-found',
  NETWORK_ERROR: 'network-error',
  TIMEOUT: 'timeout',
  QUOTA_EXCEEDED: 'quota-exceeded',
  // A frontier model declined the prompt on content/safety grounds. NOT a
  // provider fault — the provider is healthy and other prompts still work, so
  // this must not bench the provider or spawn an investigation task. We do try
  // a fallback (a local model often doesn't refuse) and tell the UI what
  // happened. See server/index.js#onRunFailed + autoFixer.handleAIProviderError.
  CONTENT_REFUSAL: 'content-refusal',
  UNKNOWN: 'unknown'
};

// Order matters — more specific patterns first.
const ERROR_PATTERNS = [
  {
    // High-precision markers for a model safety/content refusal. Codex (OpenAI)
    // returns "Invalid prompt: we've limited access to this content for safety
    // reasons. This type of information may be used to benefit or to harm…";
    // Anthropic surfaces a `refusal` stop reason. Matched FIRST so a refusal is
    // never misclassified as an auth/unknown failure that would bench the
    // provider and queue a CoS investigation task.
    pattern: /limited access to this content for safety|may be used to benefit or to harm|content[_ ]policy[_ ]violation|stop_reason["']?\s*:\s*["']?refusal|"type"\s*:\s*"refusal"/i,
    category: ERROR_CATEGORIES.CONTENT_REFUSAL,
    requiresFallback: true,
    actionable: false,
    suggestedFix: 'Model declined the prompt on content/safety grounds — retrying with a fallback model.'
  },
  {
    pattern: /billing|payment|credit|insufficient funds/i,
    category: ERROR_CATEGORIES.QUOTA_EXCEEDED,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check billing status and add credits to the provider account'
  },
  {
    pattern: /API Error: 429|rate.?limit|too many requests/i,
    category: ERROR_CATEGORIES.RATE_LIMIT,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Wait and retry - temporary rate limiting'
  },
  {
    pattern: /(?:hit your usage limit|You've hit your limit|usage limit|Upgrade to Pro|(?:^|\n)\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$))/i,
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.',
    extractWaitTime: true
  },
  {
    pattern: /unauthorized|invalid.?api.?key|authentication|forbidden|401|403/i,
    category: ERROR_CATEGORIES.AUTH_ERROR,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check API key configuration for this provider'
  },
  {
    // "model identifier is invalid" is Bedrock's wording when the runner passes
    // a model id the backend doesn't recognize (e.g. a bare Anthropic id like
    // `claude-opus-5` to a Bedrock-backed Claude Code, which wants
    // `global.anthropic.claude-opus-5`). Categorize it alongside the
    // not-found/invalid-model phrasings so the cooldown + fallback path treats
    // it as the config problem it is.
    pattern: /model.*(not found|does not exist|unavailable)|invalid model|model identifier is invalid/i,
    category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'Check model name and availability in provider settings'
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|network error|connection refused|timeout|ETIMEDOUT/i,
    category: ERROR_CATEGORIES.NETWORK_ERROR,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Check network connectivity and provider endpoint URL'
  },
  {
    pattern: /timed out|timeout exceeded|SIGTERM/i,
    category: ERROR_CATEGORIES.TIMEOUT,
    requiresFallback: false,
    actionable: false,
    suggestedFix: 'Consider increasing timeout or reducing prompt complexity'
  }
];

const WAIT_TIME_PATTERNS = [
  /resets?\s+(\d{1,2}(?:am|pm)?)\s*\(([^)]+)\)/i,
  /try again in\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /wait\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /in\s+(\d+)\s*(day|hour|minute|second)s?/i,
  /(\d+\s*day(?:s)?)?[,\s]*(\d+\s*hour(?:s)?)?[,\s]*(\d+\s*min(?:ute)?(?:s)?)?/i
];

const IMMEDIATE_FALLBACK_SIGNALS = [
  {
    pattern: /^\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$)/im,
    category: ERROR_CATEGORIES.USAGE_LIMIT,
    message: 'Provider switched to extra usage',
    suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.'
  }
];

// Claude Code renders a non-recoverable *model id* rejection inline as
// `⏺ API Error (<model>): 400 The provided model identifier is invalid…`
// (Bedrock) or `API Error: 404 … not_found_error` (Anthropic) and then sits at an
// unanswered prompt — it does NOT auto-retry the way it does a 429/500. Without an
// early-fail signal the one-shot TUI runner idles out, reports success, and scrapes
// the error screen as a bogus "response" (which then trips downstream guards like
// the manuscript-reformat integrity check).
//
// This is DELIBERATELY NOT in IMMEDIATE_FALLBACK_SIGNALS: that detector is shared
// by the long-running agent spawn paths (agentTuiSpawning / agentCliSpawning) and
// the CLI runner, which stream arbitrary agent output through it. An agent that
// legitimately prints this error line — `cat`-ing a prior run's output.txt, running
// the error-detection tests, or investigating this very failure — commonly puts the
// raw error at a LINE START, where line-anchoring alone wouldn't save it, and a
// healthy run would be killed and misclassified MODEL_NOT_FOUND. So only the one-shot
// TUI runner (tuiPromptRunner) consults this, via `createTerminalModelErrorDetector`:
// it runs a single prompt whose only `API Error` rendering is Claude Code's own, so
// the false-positive surface is negligible. CLI runs detect the same failure via the
// process's non-zero exit code; they don't need an in-stream signal.
//
// Two precision constraints (belt-and-suspenders for the one-shot path):
//   1. Line-anchored (`^…/m`) — the real signal is at a line start (or the
//      512-char buffer's slice boundary, which `^` also matches).
//   2. The 400/404 status must immediately follow the `API Error[(model)]:` prefix
//      — so a retryable `API Error: 429 … 404 not found` (incidental 404) is left
//      alone for Claude Code to auto-retry.
const TERMINAL_MODEL_ERROR_PATTERN = /^\s*(?:⏺\s*)?API Error(?:\s*\([^)]*\))?:\s*(?:400|404)\b[^\n]{0,160}(?:model identifier is invalid|not[_\s]?found)/im;

export function detectTerminalModelError(text) {
  if (!text) return null;
  const match = String(text).match(TERMINAL_MODEL_ERROR_PATTERN);
  if (!match) return null;
  return {
    hasError: true,
    category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
    message: match[0].trim() || 'Provider rejected the configured model id',
    waitTime: null,
    requiresFallback: true,
    actionable: true,
    suggestedFix: 'The provider does not recognize this model id — check the model name/availability for this provider; retrying with a fallback model.'
  };
}

export function createTerminalModelErrorDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectTerminalModelError(buffer);
  };
}

export function extractWaitTime(text) {
  if (!text) return null;

  for (const pattern of WAIT_TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const timeStr = match.slice(1).filter(Boolean).join(' ').trim();
      if (timeStr && timeStr !== ' ') {
        return timeStr;
      }
    }
  }

  const generalMatch = text.match(/(\d+)\s*(day|hour|min|sec)(?:ute)?(?:s)?/gi);
  if (generalMatch) {
    return generalMatch.join(' ');
  }

  return null;
}

export function analyzeError(errorText, exitCode = null) {
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

  const text = String(errorText || '');

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

export function detectImmediateFallbackSignal(text) {
  if (!text) return null;
  const value = String(text);

  for (const signal of IMMEDIATE_FALLBACK_SIGNALS) {
    const match = value.match(signal.pattern);
    if (!match) continue;

    const line = match[0].trim();
    return {
      hasError: true,
      category: signal.category,
      message: line || signal.message,
      waitTime: extractWaitTime(value),
      requiresFallback: true,
      actionable: true,
      suggestedFix: signal.suggestedFix
    };
  }

  return null;
}

export function createImmediateFallbackSignalDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectImmediateFallbackSignal(buffer);
  };
}

function extractErrorMessage(text) {
  if (!text) return '';

  const patterns = [
    /Error:\s*(.+?)(?:\n|$)/i,
    /error":\s*"([^"]+)"/i,
    /message":\s*"([^"]+)"/i,
    /failed:\s*(.+?)(?:\n|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  const lines = text.split('\n').filter(line => line.trim());
  return lines[0]?.substring(0, 200) || text.substring(0, 200);
}

export function isRateLimitStatus(statusCode) {
  return statusCode === 429;
}

export function isAuthErrorStatus(statusCode) {
  return statusCode === 401 || statusCode === 403;
}

export function analyzeHttpError(response) {
  const { status, statusText, body } = response;

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

  if (body) {
    // analyzeError returns `hasError: false` when no known pattern matches;
    // for a non-2xx response that's still a failure — preserve it as an
    // UNKNOWN HTTP error instead of letting the caller treat it as success.
    const bodyAnalysis = analyzeError(body);
    if (bodyAnalysis.hasError) return bodyAnalysis;
  }

  return {
    hasError: true,
    category: ERROR_CATEGORIES.UNKNOWN,
    message: statusText || `HTTP ${status}`,
    waitTime: null,
    requiresFallback: false,
    actionable: false,
    suggestedFix: null
  };
}
