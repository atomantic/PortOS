/** Recognize quota banners, extract reset times and normalize rate-limit headers. */
import { ERROR_CATEGORIES } from './categories.js';

// Vendor-banner signatures shared with the CoS agent failure analysis
// (services/agent/agentErrorAnalysis.js imports them, since this directory
// cannot import out). Declared once so a banner fix lands in both tables.
export const RATE_LIMIT_SIGNATURE = /API Error: 429|rate.?limit|too many requests/i;

// `upgrade your subscription to increase your limits` is Antigravity's
// quota banner (see AGY_QUOTA_BANNER). Claude Code reports its rolling
// subscription exhaustion as a `You've hit your <kind> limit` banner, which
// is a usage limit too even though it does not contain the older
// `usage limit` wording. The existing usage-limit category is also used by
// the immediate-fallback signals; the CLI path needs this post-hoc match to
// bench the provider and reach a fallback rather than falling through to
// UNKNOWN. Kept to vendor/billing phrasing — a bare "quota reached" is a
// phrase story text can legitimately contain, and this scan reads the
// model's entire screen.
//
// `hit your [<modifier> ]<kind> limit` is ONE alternative covering the whole
// banner family regardless of separator. The kind slot is a closed
// vocabulary (session, usage, weekly, monthly, daily, hourly, spend, N-hour)
// with one optional leading modifier (a model name, `monthly spend`): an
// open `<word> limit` slot matched `hit your tool call limit` in tool logs
// and file contents, which would bench a healthy provider. A new CLI kind
// needs one word added here. At least one kind word is REQUIRED: every real banner names the kind
// (`session`, `usage`, `weekly`, `5-hour`, `monthly spend`, `Opus usage`),
// while a bare `hit your limit` is reachable by ordinary prose — "he had
// hit your limit of patience" matched when the kind was optional.
// The earlier `your session limit resets?` required `limit` to be adjacent
// to `resets`, which only holds for the LONG combined banner
// (`... monthly spend limit · ... · your session limit resets 7:15am (UTC)`).
// Claude Code's standalone short form puts a `·` between them —
// `You've hit your session limit · resets 12:40am (UTC)` — so it fell
// through to UNKNOWN, which benched nothing and escalated a spent
// subscription to a tier-4 investigation task instead of a fallback. The
// `5-hour`/`weekly`/`Opus` kinds the CLI also emits were missing for the
// same reason. Anchored on the second-person `hit your … limit` so the
// bound wildcard cannot be reached by prose about a limit.
// The vendor-banner half: wording a provider CLI prints and prose does not.
// Kept separate because the agent table promotes ONLY this half to a provider
// signal (a bench) — a bare `usage limit` also appears in tests and docs an
// agent prints, so it may classify a failure but must not bench a provider.
export const USAGE_LIMIT_BANNER_SIGNATURE = /(?:hit your (?:[\w-]+ )?(?:session|usage|weekly|monthly|daily|hourly|spend|\d+-hour) limit\b|Upgrade to Pro|upgrade your subscription to increase your limits|(?:^|\n)\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$))/i;
export const USAGE_LIMIT_SIGNATURE = new RegExp(`${USAGE_LIMIT_BANNER_SIGNATURE.source}|usage limit`, 'i');

const WAIT_TIME_PATTERNS = [
  // A reset CLOCK time, not a duration: `resets 12:40am (UTC)`. The minutes are
  // optional (`resets 3pm`) and so is the parenthesized zone — Claude Code emits
  // the bare form too (`resets 6:00 PM`), and requiring both meant the most
  // common wording, `H:MM<meridiem>`, extracted no wait time at all because
  // `\d{1,2}` stopped at the `:`.
  //
  // A meridiem or an `H:MM` is REQUIRED, so the hour cannot be a bare integer:
  // with the zone parens optional, a lone `\d{1,2}` would claim the number out
  // of a DURATION phrased off `resets` (`resets 5 minutes from now` → `5`),
  // which the general duration scan below reads correctly as `5 minutes`.
  // `resets in 3h51m14s` has no digit after `resets` and falls through either way.
  /resets?\s+(\d{1,2}(?::\d{2})?[ \t]*(?:am|pm)\b|\d{1,2}:\d{2})[ \t]*(?:\(([^)]+)\))?/i,
  /try again in\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /wait\s+((?:\d+\s*(?:day|hour|minute|second)s?\s*)+)/i,
  /in\s+(\d+)\s*(day|hour|minute|second)s?/i,
  /(\d+\s*day(?:s)?)?[,\s]*(\d+\s*hour(?:s)?)?[,\s]*(\d+\s*min(?:ute)?(?:s)?)?/i
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

export function isRateLimitStatus(statusCode) {
  return statusCode === 429;
}

const RATE_LIMIT_HEADER_NAMES = {
  retryAfter: ['retry-after'],
  reset: ['ratelimit-reset', 'rate-limit-reset', 'x-ratelimit-reset', 'x-rate-limit-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'],
  remaining: ['ratelimit-remaining', 'rate-limit-remaining', 'x-ratelimit-remaining', 'x-rate-limit-remaining', 'x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining'],
  limit: ['ratelimit-limit', 'rate-limit-limit', 'x-ratelimit-limit', 'x-rate-limit-limit', 'x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit'],
};
const MAX_RATE_LIMIT_HEADER_LENGTH = 128;
const MAX_RATE_LIMIT_HEADER_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RATE_LIMIT_COUNT = 1_000_000_000;

const readAllowedHeader = (headers, names) => {
  for (const name of names) {
    const value = typeof headers?.get === 'function'
      ? headers.get(name)
      : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
    if (value != null) {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return null;
};

const parseRateLimitCount = (value) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_RATE_LIMIT_COUNT ? parsed : null;
};

const parseRetryAfter = (value, now) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const delay = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS ? delay : null;
  }
  const at = Date.parse(value);
  const delay = at - now;
  return Number.isFinite(at) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS ? delay : null;
};

const parseResetAt = (value, now) => {
  if (!value || value.length > MAX_RATE_LIMIT_HEADER_LENGTH) return null;
  let at;
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i.test(value)) {
    const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const delay = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gi)]
      .reduce((total, match) => total + (Number(match[1]) * units[match[2].toLowerCase()]), 0);
    at = now + delay;
  } else if (/^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (numeric >= 1e12) at = numeric;
    else if (numeric >= 1e9) at = numeric * 1000;
    else at = now + (numeric * 1000);
  } else {
    at = Date.parse(value);
  }
  const delay = at - now;
  return Number.isFinite(at) && delay >= 0 && delay <= MAX_RATE_LIMIT_HEADER_DELAY_MS
    ? new Date(at).toISOString()
    : null;
};

/**
 * Normalize the small, explicit set of upstream rate-limit headers PortOS may
 * persist. Raw names/values never leave this boundary.
 */
export function normalizeRateLimitHeaders(headers, { now = Date.now() } = {}) {
  if (!headers) return null;
  const retryAfterMs = parseRetryAfter(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.retryAfter), now);
  const resetAt = parseResetAt(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.reset), now);
  const remaining = parseRateLimitCount(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.remaining));
  const limit = parseRateLimitCount(readAllowedHeader(headers, RATE_LIMIT_HEADER_NAMES.limit));
  if (retryAfterMs == null && resetAt == null && remaining == null && limit == null) return null;
  return {
    observedAt: new Date(now).toISOString(),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(remaining != null ? { remaining } : {}),
    ...(limit != null ? { limit } : {}),
  };
}

export const rateLimitRule = {
  pattern: RATE_LIMIT_SIGNATURE,
  category: ERROR_CATEGORIES.RATE_LIMIT,
  requiresFallback: false,
  actionable: false,
  suggestedFix: 'Wait and retry - temporary rate limiting'
};

export const usageLimitRule = {
  pattern: USAGE_LIMIT_SIGNATURE,
  category: ERROR_CATEGORIES.USAGE_LIMIT,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.',
  extractWaitTime: true
};
