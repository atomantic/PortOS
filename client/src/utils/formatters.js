/**
 * Shared formatting utilities for the client
 * These functions are used across multiple pages and components
 */

/**
 * Format a timestamp as a relative time string
 * @param {string|Date} timestamp - ISO timestamp or Date object
 * @returns {string} Formatted relative time (e.g., "Just now", "5m ago", "2h ago")
 */
export function formatTime(timestamp) {
  if (timestamp == null || timestamp === '') return 'Unknown';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'Invalid date';
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

/**
 * Format a timestamp as a localized time-of-day string (e.g., "1:30 PM")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @returns {string} Formatted time of day
 */
export function formatTimeOfDay(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format a date as a localized date string (e.g., "March 5, 2026")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @returns {string|null} Formatted date, or null for missing input
 */
export function formatDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format a date with full detail including weekday (e.g., "Saturday, March 5, 2026")
 * @param {Date} date - Date object
 * @returns {string} Formatted date string
 */
export function formatDateFull(date) {
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format a Date as a clock time string with seconds (e.g., "02:30:45 PM")
 * @param {Date} date - Date object
 * @returns {string} Formatted clock time
 */
export function formatClockTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Format a duration in milliseconds as a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string|null} Formatted duration (e.g., "500ms", "1.5s", "2.0m")
 */
export function formatRuntime(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format a timestamp as relative time (e.g., "just now", "5m ago", "2d ago")
 * Handles null/missing values with configurable fallback.
 * @param {string|Date|null} dateStr - ISO timestamp, Date object, or null
 * @param {string} fallback - Text to show for null/missing dates (default: 'never')
 * @returns {string} Relative time string
 */
export function timeAgo(dateStr, fallback = 'never') {
  if (!dateStr) return fallback;
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return seconds < 10 ? 'just now' : `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Format bytes as a human-readable string
 * @param {number} bytes - Size in bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB", "4.2 TB")
 */
export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  // Clamp the unit index so values larger than the largest defined unit
  // still render with a known suffix (e.g. multi-PB import archives) rather
  // than `undefined`.
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Count whitespace-separated words in a string. Matches the server-side
 * countWords in writers-room storage so client + server agree.
 */
export function countWords(text) {
  if (!text) return 0;
  const m = String(text).trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Format a number of seconds as MM:SS (e.g. 75 → "01:15"). Used for sprint
 * timers and other countdowns. Negative values clamp to 0.
 */
export function formatCountdown(seconds) {
  const safe = Math.max(0, Math.round(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a timestamp as a localized date+time string (e.g., "Apr 1, 2026, 1:30 PM")
 * @param {string|Date|null} value - ISO timestamp or Date object
 * @returns {string} Formatted date and time, or 'Unknown time' for invalid input
 */
const _dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return _dateTimeFormatter.format(date);
}

/**
 * Format a number of seconds as M:SS (e.g. 75 → "1:15"). For coarse durations
 * like a stitched video's runtime. Returns `'—'` for missing/invalid input.
 */
export function formatDurationSec(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a number of seconds as M:SS.ss for video-editor timecodes
 * (e.g. 95.42 → "1:35.42"). Negative or non-finite inputs render as "0:00.00".
 */
export function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Format a date with a short month label (e.g., "Mar 5, 2026"). Returns
 * `'—'` for missing/invalid input — pair with `formatDate` (long month, null
 * fallback) depending on the surrounding UI.
 */
export function formatDateShort(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Per-call LLM timeout bounds. Client-side mirror of the canonical
// MIN_TIMEOUT / MAX_TIMEOUT in server/lib/aiToolkit/constants.js — the
// client can't import across the server boundary (Vite vs Node, plus the
// aiToolkit directory is kept self-contained per CLAUDE.md). The server
// validators (validation.js, stageRunner.js) and aiToolkit's own
// provider/run schemas all import from constants.js; this file is the
// only known mirror. Bumping these here without the server constants —
// or vice versa — would let a value through one validator that the
// other rejects.
export const TIMEOUT_INPUT_MIN_MS = 1000;
export const TIMEOUT_INPUT_MAX_MS = 1800000;
export const TIMEOUT_INPUT_STEP_MS = 1000;

/**
 * Parse a raw string from a timeout (ms) input into a stored value.
 * Returns `null` for blank input (caller treats as "clear override") and
 * for anything outside the validated [TIMEOUT_INPUT_MIN_MS,
 * TIMEOUT_INPUT_MAX_MS] integer range — the caller is then responsible for
 * snapping the input back to the persisted value. Clamping here keeps the
 * client from emitting PUTs the server's Zod schema would 400 (e.g. a
 * stray `1` that "looks positive" but is below the 1s floor).
 *
 * Accepts only digit-only strings (`^\d+$`), then parses via `Number(...)`
 * + `Number.isInteger`. The digit-only gate is stricter than `Number(v)`
 * alone — `Number("1e3")` is 1000 and `Number("1000.5")` is 1000.5 — and
 * is mirrored in `stageConfigUpdateSchema`'s preprocess in
 * server/lib/validation.js so client/server reject the same shapes. If
 * you loosen this rule, loosen the server preprocess in lockstep.
 */
export function parseTimeoutMs(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Require an explicit digit-only string so "1e3" / "1.5" / "0x10" can't
  // sneak past Number()'s permissive coercion.
  if (!/^\d+$/.test(trimmed)) return null;
  const ms = Number(trimmed);
  if (!Number.isInteger(ms) || ms < TIMEOUT_INPUT_MIN_MS || ms > TIMEOUT_INPUT_MAX_MS) return null;
  return ms;
}

/**
 * Format a duration in milliseconds as a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "45s", "3m 12s", "2h 5m")
 */
export function formatDurationMs(ms) {
  if (ms == null) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Format a duration in minutes as a human-readable string
 * @param {number|null|undefined} minutes - Duration in minutes; nullish → ''
 * @param {object} [options]
 * @param {boolean} [options.approximate=false] - Prefix the result with `~`
 *   to signal an estimate (e.g., "~1h 30m") for predicted/averaged durations.
 * @returns {string} Formatted duration (e.g., "30m", "1h 30m", "2h", "~2h")
 */
export function formatDurationMin(minutes, options = {}) {
  if (minutes == null) return '';
  const { approximate = false } = options ?? {};
  const prefix = approximate ? '~' : '';
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${prefix}${h}h ${m}m` : `${prefix}${h}h`;
  }
  return `${prefix}${minutes}m`;
}

/**
 * Format a calendar event's date+time, with a distinct all-day rendering.
 * Tuned for the event-detail panel: timed events show a short weekday plus
 * time (e.g. "Sat, Apr 1, 1:30 PM"); all-day events show a full weekday and
 * year (e.g. "Saturday, April 1, 2026"). Kept separate from `formatDateTime`
 * because the weekday-led shape is event-specific.
 * Behavior-identical to the local formatter it replaced: any input is passed
 * straight to `new Date(...)`, so malformed/empty values render the same
 * `Invalid Date` / epoch string the original did. The two call sites always
 * pass a real event time, so this degenerate path is never exercised — kept
 * faithful so the migration introduces zero visual change.
 * @param {string|Date|null} dateStr - ISO timestamp or Date object
 * @param {object} [options]
 * @param {boolean} [options.allDay=false] - Render date-only (all-day event).
 * @returns {string} Formatted event date/time
 */
export function formatEventDateTime(dateStr, options = {}) {
  const { allDay = false } = options ?? {};
  const date = new Date(dateStr);
  // All-day events render exactly like `formatDateFull` (full weekday + year).
  if (allDay) return formatDateFull(date);
  return date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Get app name from app ID by looking up in apps array
 * @param {string|null} appId - The app ID to look up
 * @param {Array<{id: string, name: string}>} apps - Array of app objects
 * @param {string} fallback - Fallback value if app not found
 * @returns {string|null} App name or fallback
 */
export function getAppName(appId, apps, fallback = null) {
  if (!appId) return fallback;
  const app = apps?.find(a => a.id === appId);
  return app?.name || fallback;
}
