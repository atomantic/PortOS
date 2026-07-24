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
 * @param {object} [options] - { timeZone } — render in a specific IANA timezone
 *   (e.g. the server's configured user timezone) instead of the browser's
 * @returns {string} Formatted clock time
 */
export function formatClockTime(date, { timeZone } = {}) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', ...(timeZone ? { timeZone } : {}) });
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
  const time = new Date(dateStr).getTime();
  if (!Number.isFinite(time)) return fallback; // Invalid Date → fallback, not "NaNy ago"
  const seconds = Math.floor((Date.now() - time) / 1000);
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
 * Format a future timestamp as a relative "in X" string, mirroring timeAgo's
 * bucket thresholds. Returns `fallback` for null/missing or past dates (use
 * timeAgo for past-relative display). Example outputs: "in 5s", "in 3m",
 * "in 2h", "in 4d".
 * @param {string|Date|null} dateStr - ISO timestamp or Date object
 * @param {string} fallback - Text to show for null/missing/past dates (default: 'now')
 * @returns {string} Future-relative time string
 */
export function timeUntil(dateStr, fallback = 'now') {
  if (!dateStr) return fallback;
  const time = new Date(dateStr).getTime();
  if (!Number.isFinite(time)) return fallback;
  const seconds = Math.floor((time - Date.now()) / 1000);
  if (seconds <= 0) return fallback;
  if (seconds < 60) return `in ${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `in ${days}d`;
  if (days < 365) return `in ${Math.floor(days / 30)}mo`;
  return `in ${Math.floor(days / 365)}y`;
}

/**
 * Format bytes as a human-readable string
 * @param {number} bytes - Size in bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB", "4.2 TB")
 */
/**
 * Compact decimal count: 950 → "950", 1200 → "1.2K", 3400000 → "3.4M".
 * @param {number} n - Count to abbreviate
 * @returns {string} Abbreviated count
 */
export function formatCompactCount(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

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
 * Format a model context window (in tokens) compactly, e.g. 32768 → "32K ctx",
 * 131072 → "128K ctx", 1048576 → "1M ctx". Returns null for missing/invalid
 * values so callers can omit the label entirely.
 * @param {number|null|undefined} tokens
 * @returns {string|null}
 */
export function formatContextLength(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) {
    const m = n / (1024 * 1024);
    return `${parseFloat(m.toFixed(m % 1 ? 1 : 0))}M ctx`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)}K ctx`;
  return `${n} ctx`;
}

/**
 * Count whitespace-separated words in a string. Mirrors the canonical
 * server-side `countWords` in `server/lib/textUtils.js` (the client cannot
 * import from `server/`) so client + server word counts always agree.
 */
export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const m = text.trim().match(/\S+/g);
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
 * like a stitched video's runtime or a piano-roll ruler tick. Returns `'—'`
 * for missing/invalid/negative input; a genuine zero renders as `"0:00"` (not
 * `'—'`) so callers can distinguish "unknown" from "zero seconds".
 */
export function formatDurationSec(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
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
 * Format a duration in milliseconds as a human-readable string. Buckets down
 * from days so multi-day uptimes read as "2d 3h" rather than an unbounded
 * hours count ("51h 0m").
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "45s", "3m 12s", "2h 5m", "2d 3h")
 */
export function formatDurationMs(ms) {
  if (ms == null) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
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
 * Format a date string as a short weekday + month + day string
 * (e.g., "Sat, Mar 5"). Used for activity-heatmap tooltips where compact
 * output with a leading weekday abbreviation is important.
 * The input is treated as a calendar date (anchored at local noon to avoid
 * day-boundary drift), not as a precise timestamp.
 * @param {string} dateStr - Date-only string ("YYYY-MM-DD"); a full ISO
 *   timestamp is NOT supported (the noon-anchor suffix would make it invalid)
 * @returns {string} Formatted date (e.g., "Sat, Mar 5")
 */
export function formatDateWeekday(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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

/**
 * Derive a human-friendly default record name from a gallery-image filename:
 * drop the path + extension, turn `-`/`_` separators into spaces, title-case,
 * and cap at 120 chars (the server-side name limit). Shared by the "image → 3D
 * model" pages (Three.js Models and image-to-3D) so their defaults don't drift.
 * @param {string} filename
 * @param {string} [fallback='Untitled 3D model'] - used when the filename is empty
 * @returns {string}
 */
export function nameFromImageFilename(filename, fallback = 'Untitled 3D model') {
  const base = String(filename || '').split('/').pop().replace(/\.[^.]+$/, '');
  const name = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim().slice(0, 120);
  return name || fallback;
}

/**
 * Format a cooldown countdown in milliseconds as "M:SS" (e.g., "1:05", "0:09").
 * @param {number} ms - Remaining milliseconds (negative values clamp to 0:00)
 * @returns {string} Minutes:seconds countdown string
 */
export function formatCooldown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Parse a human size string ("4.7 GB", "512 MB") to GB.
 * @param {string|null|undefined} sizeStr - Human-readable size string
 * @returns {number|null} Size in GB, or null when unparseable
 */
export function parseSizeGb(sizeStr) {
  const match = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(String(sizeStr || ''));
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (!Number.isFinite(val)) return null;
  return val * ({ TB: 1024, GB: 1, MB: 1 / 1024, KB: 1 / (1024 * 1024) }[match[2].toUpperCase()]);
}

/**
 * Rough RAM/VRAM needed to run a local model: weights + ~20% overhead
 * (KV cache/runtime), rounded up to whole GB with a 1 GB floor.
 * Prefers exact bytes when known, falling back to a human size string.
 * @param {number|null|undefined} sizeBytes - Exact model size in bytes
 * @param {string|null|undefined} sizeStr - Human size string fallback ("4.7 GB")
 * @returns {number|null} Whole GB recommendation, or null when size is unknown
 */
export function recommendedRamGb(sizeBytes, sizeStr) {
  const gb = Number.isFinite(sizeBytes) ? sizeBytes / 1024 ** 3 : parseSizeGb(sizeStr);
  if (!gb || gb <= 0) return null;
  return Math.max(1, Math.ceil(gb * 1.2));
}
