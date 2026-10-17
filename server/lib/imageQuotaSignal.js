/**
 * Detect a provider quota exhaustion that states its own reset time, so the
 * render queue can wait for that instant instead of burning every queued job
 * against the same wall.
 *
 * The signal this reads is narration, not a structured field. Antigravity
 * relays `generate_image`'s failure through whatever prose the driving agent
 * chose that turn, so the same outage was recorded three different ways in one
 * afternoon ("The `generate_image` tool failed due to a rate-limit / quota
 * exhaustion error: - **Error:** `429 RESOURCE_EXHAUSTED: …`", a `>` blockquote
 * form, and a bare fenced form). Only two things were stable across all of
 * them: an exhaustion marker, and Google's Go-style duration
 * (`Your quota will reset after 2h26m1s.`).
 *
 * So the contract is deliberately conservative — BOTH an exhaustion marker and
 * a parseable duration must be present. A render prompt is attacker-adjacent
 * input here: the failure text embeds the agent's own words about a comic page,
 * and a page of dialogue could easily contain "quota" or "429" on its own.
 * Requiring the pair, and bounding the result, keeps a story about a rationing
 * office from parking the queue for a day.
 */

/** Longest deferral worth honoring; past this, failing is more honest. */
export const MAX_QUOTA_DEFERRAL_MS = 24 * 60 * 60 * 1000;

/** Below this a "reset" is noise — the queue would re-dispatch instantly. */
const MIN_QUOTA_DEFERRAL_MS = 1000;

// An explicit exhaustion marker. `429` alone is NOT enough: it is a plausible
// number in prose. Each alternative names the condition.
const EXHAUSTION_MARKERS = [
  /RESOURCE_EXHAUSTED/,
  /\bexhausted your capacity\b/i,
  /\bquota (?:reached|exceeded|exhausted)\b/i,
  /\b429\b[^\n]{0,40}\btoo many requests\b/i,
  /\brate[- ]?limit(?:ed|ing)?\b[^\n]{0,60}\bquota\b/i,
];

// Go-style duration as Google renders it: `2h26m1s`, `45m10s`, `30s`, `1h`.
// Anchored to reset wording so an unrelated duration in the prose (a comic
// panel's "3h20m later") cannot be mistaken for a quota instant.
const RESET_PHRASES = [
  /\bquota will reset (?:after|in)\s+([0-9hms]+)/i,
  /\bresets?\s+(?:after|in)\s+([0-9hms]+)/i,
];

const DURATION_PART = /(\d+)\s*([hms])/gi;

/**
 * Parse a Go-style compound duration into milliseconds.
 * Returns null when the string carries no recognizable unit.
 */
export function parseGoDuration(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Reject anything beyond digits and h/m/s so a bare number or a stray token
  // cannot be read as a duration.
  if (!/^(?:\d+\s*[hms])+$/i.test(text.trim())) return null;
  let total = 0;
  let matched = false;
  for (const [, value, unit] of text.matchAll(DURATION_PART)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    matched = true;
    if (unit.toLowerCase() === 'h') total += n * 3_600_000;
    else if (unit.toLowerCase() === 'm') total += n * 60_000;
    else total += n * 1000;
  }
  return matched ? total : null;
}

/**
 * Read a deferral out of a failed render's error text.
 *
 * @param {string} text — the failure message the backend recorded.
 * @param {{now?: number}} [options]
 * @returns {{resumeAt: number, resetsInMs: number}|null} null when the text is
 *   not a quota exhaustion, or states no usable reset. Null means "fail
 *   normally" — never "retry at some guessed time".
 */
export function parseQuotaDeferral(text, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || !text) return null;
  if (!EXHAUSTION_MARKERS.some((pattern) => pattern.test(text))) return null;
  for (const phrase of RESET_PHRASES) {
    const match = phrase.exec(text);
    if (!match) continue;
    const resetsInMs = parseGoDuration(match[1]);
    if (resetsInMs == null) continue;
    if (resetsInMs < MIN_QUOTA_DEFERRAL_MS || resetsInMs > MAX_QUOTA_DEFERRAL_MS) continue;
    return { resumeAt: now + resetsInMs, resetsInMs };
  }
  return null;
}

/** Compact "2h26m" for a status line; seconds only when that is all there is. */
export function formatDeferral(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}
