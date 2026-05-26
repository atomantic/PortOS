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
  UNKNOWN: 'unknown'
};

// Order matters — more specific patterns first.
const ERROR_PATTERNS = [
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
    pattern: /model.*(not found|does not exist|unavailable)|invalid model/i,
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
