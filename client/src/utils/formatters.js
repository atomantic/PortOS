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
  return formatDateNumeric(date);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a Date / ISO timestamp / epoch ms into a Date for display.
 *
 * A bare calendar date ("2026-03-05") is parsed by `new Date(...)` as UTC
 * midnight, which renders as the PREVIOUS day everywhere west of Greenwich.
 * Anchor it at LOCAL midnight instead — exactly what the call sites used to
 * do by hand with `new Date(value + 'T00:00:00')`.
 * @param {string|number|Date|null|undefined} value
 * @returns {Date} A Date (possibly Invalid — callers validate)
 */
function toDisplayDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) return new Date(`${value}T00:00:00`);
  return new Date(value);
}

/**
 * Render `value` through `toLocaleDateString`/`toLocaleTimeString` with the
 * given options, returning `fallback` for missing or unparseable input so a
 * blank record never renders the literal string "Invalid Date".
 * @param {'date'|'time'} kind
 * @param {string|number|Date|null|undefined} value
 * @param {Intl.DateTimeFormatOptions|undefined} options
 * @param {string} fallback
 * @returns {string}
 */
function localized(kind, value, options, fallback) {
  if (value == null || value === '') return fallback;
  const date = toDisplayDate(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return kind === 'date'
    ? date.toLocaleDateString([], options)
    : date.toLocaleTimeString([], options);
}

/**
 * Format a timestamp as a localized time-of-day string (e.g., "1:30 PM")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @param {object} [options]
 * @param {string} [options.timeZone] - Render in a specific IANA timezone
 * @returns {string} Formatted time of day, or '' for missing/invalid input
 */
export function formatTimeOfDay(dateStr, { timeZone } = {}) {
  return localized('time', dateStr, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }, '');
}

/**
 * Format a timestamp as a localized time-of-day string WITH seconds
 * (e.g., "1:30:45 PM") — the shape log/queue rows want, where the second
 * matters for ordering. Pair with `formatTimeOfDay` when seconds are noise
 * and `formatClockTime` when the zero-padded 24h-capable clock shape is wanted.
 * @param {string|number|Date|null} value - ISO timestamp, epoch ms, or Date
 * @param {string} [fallback=''] - Rendered for missing/invalid input
 * @returns {string} Formatted time of day with seconds
 */
export function formatTimeOfDaySeconds(value, fallback = '') {
  return localized('time', value, undefined, fallback);
}

/**
 * Format a date as a localized date string (e.g., "March 5, 2026")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @returns {string|null} Formatted date, or null for missing input
 */
export function formatDate(dateStr) {
  if (!dateStr) return null;
  return localized('date', dateStr, { month: 'long', day: 'numeric', year: 'numeric' }, null);
}

/**
 * Format a date in the browser's short numeric locale form (e.g., "3/5/2026").
 * This is the canonical home for what used to be a bare
 * `new Date(x).toLocaleDateString()` scattered across components — compact
 * list/table cells where a spelled-out month would not fit.
 * @param {string|number|Date|null} value - ISO timestamp, `YYYY-MM-DD`, epoch ms, or Date
 * @param {string} [fallback=''] - Rendered for missing/invalid input
 * @returns {string} Formatted numeric date
 */
export function formatDateNumeric(value, fallback = '') {
  return localized('date', value, undefined, fallback);
}

/**
 * Format a date as month + day only (e.g., "Mar 5"). For dense HUD/badge
 * chrome and week ranges where the year is implied by context.
 * @param {string|number|Date|null} value
 * @param {string} [fallback=''] - Rendered for missing/invalid input
 * @returns {string}
 */
export function formatMonthDay(value, fallback = '') {
  return localized('date', value, { month: 'short', day: 'numeric' }, fallback);
}

/**
 * Format a date as month + year (e.g., "March 2026") — calendar month headers.
 * @param {string|number|Date|null} value
 * @param {string} [fallback=''] - Rendered for missing/invalid input
 * @returns {string}
 */
export function formatMonthYear(value, fallback = '') {
  return localized('date', value, { month: 'long', year: 'numeric' }, fallback);
}

/**
 * Format an abbreviated weekday plus time-of-day (e.g., "Mon, 7:00 AM") — a
 * week-scale schedule timeline, where the day matters but the date does not.
 * @param {string|number|Date|null} value
 * @param {object} [options]
 * @param {string} [options.timeZone] - Render in a specific IANA timezone
 * @returns {string} Formatted weekday + time, or '' for missing/invalid input
 */
export function formatWeekdayTime(value, { timeZone } = {}) {
  if (value == null || value === '') return '';
  const date = toDisplayDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/**
 * Format a date as an abbreviated weekday only (e.g., "Mon") — calendar
 * column headers and timeline axis ticks.
 * @param {string|number|Date|null} value
 * @param {object} [options]
 * @param {string} [options.timeZone] - Render the weekday in a specific IANA timezone
 * @returns {string} Abbreviated weekday, or '' for missing/invalid input
 */
export function formatWeekdayShort(value, { timeZone } = {}) {
  return localized('date', value, { weekday: 'short', ...(timeZone ? { timeZone } : {}) }, '');
}

/**
 * Format a weekday-led date with a short month (e.g., "Monday, Mar 5", or
 * "Mon, Mar 5, 2026" with `{ weekday: 'short', year: true }`). Distinct from
 * `formatDateFull` (long month, always with year).
 * @param {string|number|Date|null} value
 * @param {object} [options]
 * @param {'long'|'short'} [options.weekday='long'] - Weekday width
 * @param {boolean} [options.year=false] - Append the year
 * @param {string} [options.fallback=''] - Rendered for missing/invalid input
 * @returns {string}
 */
export function formatWeekdayDate(value, { weekday = 'long', year = false, fallback = '' } = {}) {
  return localized('date', value, { weekday, month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) }, fallback);
}

/**
 * Format a date with full detail including weekday (e.g., "Saturday, March 5, 2026")
 * @param {string|number|Date|null} value - Date object, ISO timestamp, or `YYYY-MM-DD`
 * @returns {string} Formatted date string, or '' for missing/invalid input
 */
export function formatDateFull(value) {
  return localized('date', value, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, '');
}

/**
 * Format a Date as a clock time string with seconds (e.g., "02:30:45 PM")
 * @param {string|number|Date|null} date - Date object, ISO timestamp, or epoch ms
 * @param {object} [options]
 * @param {string} [options.timeZone] - Render in a specific IANA timezone
 *   (e.g. the server's configured user timezone) instead of the browser's
 * @param {boolean} [options.seconds=true] - Include seconds ("02:30:45 PM" vs "02:30 PM")
 * @param {boolean} [options.hour12] - Force 12h/24h; omit to follow the locale
 * @returns {string} Formatted clock time, or '' for missing/invalid input
 */
export function formatClockTime(date, { timeZone, seconds = true, hour12 } = {}) {
  return localized('time', date, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(hour12 === undefined ? {} : { hour12 }),
  }, '');
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
 * Age of a published thing in whole DAYS — "today", "1 day old", "412 days old".
 *
 * Distinct from `timeAgo`, which collapses anything past a month into "3mo ago"
 * / "2y ago". Model-download lists want the day count itself: it is the number
 * that says how current a checkpoint is, and a bucket label hides the difference
 * between a 40-day-old release and a 400-day-old one.
 * @param {string|number|Date|null} value - ISO timestamp, epoch ms, or Date
 * @param {string} fallback - Text for null/missing/unparseable values
 * @returns {string} Day-count label
 */
export function formatAgeDays(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return fallback;
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 0) return 'today'; // A clock skew ahead of the publish date is not "-1 days old".
  if (days === 0) return 'today';
  return `${days.toLocaleString()} day${days === 1 ? '' : 's'} old`;
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

/**
 * Round a number to `decimals` places and drop trailing zeros
 * (170.35000000000002 → 170.4, 170.0 → 170). Returns null for
 * non-finite input so callers can render their own fallback.
 * @param {number|string|null|undefined} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundForDisplay(value, decimals) {
  // `Number(null)`, `Number('')`, `Number('   ')` and `Number(false)` are all 0,
  // which would render a missing measurement as a real "0 lbs" — accept only a
  // number or a non-blank numeric string before coercing.
  const isNumeric = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '');
  if (!isNumeric) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

/**
 * Format a body weight for display. Unit-converted weights arrive as raw
 * binary floats (e.g. 170.35000000000002), which read as false precision and
 * blow out a tile's line — round to one decimal by default and suffix the unit.
 * @param {number|string|null|undefined} value - Weight in `unit`
 * @param {object} [options]
 * @param {string} [options.unit='lbs'] - Unit suffix
 * @param {number} [options.decimals=1] - Decimal places to keep
 * @param {string} [options.fallback='—'] - Rendered when the value is missing/invalid
 * @returns {string} e.g. "170.4 lbs"
 */
export function formatWeight(value, { unit = 'lbs', decimals = 1, fallback = '—' } = {}) {
  const n = roundForDisplay(value, decimals);
  if (n === null) return fallback;
  return unit ? `${n} ${unit}` : `${n}`;
}

/**
 * Format a percentage for display, rounding away float noise the same way
 * `formatWeight` does (18.400000000000002 → "18.4%").
 * @param {number|string|null|undefined} value - Percentage (already 0–100)
 * @param {object} [options]
 * @param {number} [options.decimals=1] - Decimal places to keep
 * @param {string} [options.fallback='—'] - Rendered when the value is missing/invalid
 * @returns {string} e.g. "18.4%"
 */
export function formatPercent(value, { decimals = 1, fallback = '—' } = {}) {
  const n = roundForDisplay(value, decimals);
  if (n === null) return fallback;
  return `${n}%`;
}

/**
 * Format a USD amount for display: `$12.34`.
 *
 * `signed` keeps the minus sign OUTSIDE the dollar sign (`-$5.00`), so a
 * negative saving reads as a loss rather than as a strange currency string.
 * `trimWhole` drops the `.00` on a round figure — for a price the user typed
 * ($200/mo), not for a computed total, where aligned cents are the point.
 *
 * @param {number} value - Dollar amount (nullish renders as $0.00; a non-nullish
 *   value that fails to parse as a finite number — NaN, a broken calc — renders
 *   `fallback` instead, so a computation failure never masquerades as "$0.00")
 * @param {{ signed?: boolean, trimWhole?: boolean, fallback?: string }} [options]
 * @returns {string} e.g. "$12.34", "-$5.00", "$200"
 */
export function formatUsd(value, { signed = false, trimWhole = false, fallback = '—' } = {}) {
  const n = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const magnitude = signed ? Math.abs(n) : n;
  const body = trimWhole && Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(2);
  return `${signed && n < 0 ? '-' : ''}$${body}`;
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
 * Format a model's decimal-GB (10^9 bytes) download footprint as "~29 GB".
 * Returns null for missing/zero/invalid values so callers can omit the label
 * entirely rather than render "~undefined GB". Deliberately decimal, not the
 * binary units `formatBytes` uses: these values come from HuggingFace repo
 * sizes, which are quoted in decimal GB.
 * @param {number|null|undefined} gb
 * @returns {string|null}
 */
export function formatDownloadGb(gb) {
  return typeof gb === 'number' && Number.isFinite(gb) && gb > 0 ? `~${gb} GB` : null;
}

/**
 * Format a model context window (in tokens) compactly, e.g. 32768 → "32K ctx",
 * 131072 → "128K ctx", 1048576 → "1M ctx". Returns null for missing/invalid
 * values so callers can omit the label entirely.
 *
 * `suffix` is what follows the number. The default reads as a standalone badge;
 * pass `''` when the surrounding prose already supplies the noun ("up to 32K
 * tokens of context"), so the two spellings stay one implementation instead of
 * a near-copy per caller.
 *
 * @param {number|null|undefined} tokens
 * @param {{ suffix?: string }} [options]
 * @returns {string|null}
 */
export function formatContextLength(tokens, { suffix = ' ctx' } = {}) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) {
    const m = n / (1024 * 1024);
    return `${parseFloat(m.toFixed(m % 1 ? 1 : 0))}M${suffix}`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)}K${suffix}`;
  return `${n}${suffix}`;
}

/**
 * Context length with NO unit suffix — `4096` → `"4K"` — for prose that
 * already says "tokens of context" around it.
 *
 * Three surfaces in the Models section had each declared this same one-line
 * alias privately; it lives here, beside `formatContextLength`, so a change to
 * the K/M thresholds reaches all of them.
 */
export function formatContextTokens(tokens) {
  return formatContextLength(tokens, { suffix: '' });
}

/**
 * How fast a measured model generated, as one label: `"58.5 tok/s"`,
 * `"~58.5 tok/s"` for a frame-counted estimate, or `"240 chars/s"` when the
 * runtime reported no token counts at all. `null` when neither was measured.
 *
 * Tokens/s leads because it is the figure people compare local models on, and
 * the two are never shown together — one row carrying both units reads as a
 * contradiction. The `~` is not decoration: PortOS has no tokenizer, so a count
 * derived from counting streamed frames must never be presented as one the
 * daemon's tokenizer produced.
 *
 * @param {{meanTokensPerSecond?: number|null, meanCharsPerSecond?: number|null, tokensEstimated?: boolean|null}} perf
 */
export function throughputLabel(perf) {
  const tokens = perf?.meanTokensPerSecond;
  if (typeof tokens === 'number' && Number.isFinite(tokens)) {
    return `${perf?.tokensEstimated ? '~' : ''}${tokens} tok/s`;
  }
  const chars = perf?.meanCharsPerSecond;
  return typeof chars === 'number' && Number.isFinite(chars) ? `${chars} chars/s` : null;
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

export function formatDateTime(value, fallback = 'Unknown time') {
  if (value == null || value === '') return fallback;
  const date = toDisplayDate(value);
  if (Number.isNaN(date.getTime())) return fallback;
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
  return localized('date', value, { year: 'numeric', month: 'short', day: 'numeric' }, '—');
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
export const TIMEOUT_INPUT_MAX_MS = 43_200_000;
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
 * Missing/unparseable input renders '' — the same fallback contract every
 * other helper here follows. (It used to pass the raw `Invalid Date` string
 * through "for migration fidelity"; once the all-day branch started routing
 * through `formatDateFull`'s guard, that left one branch guarded and one not.
 * Both call sites pass a real event time, so nothing visible changes.)
 * @param {string|Date|null} dateStr - ISO timestamp or Date object
 * @param {object} [options]
 * @param {boolean} [options.allDay=false] - Render date-only (all-day event).
 * @returns {string} Formatted event date/time
 */
export function formatEventDateTime(dateStr, options = {}) {
  const { allDay = false } = options ?? {};
  // All-day events render exactly like `formatDateFull` (full weekday + year).
  if (allDay) return formatDateFull(dateStr);
  if (dateStr == null || dateStr === '') return '';
  const date = toDisplayDate(dateStr);
  if (Number.isNaN(date.getTime())) return '';
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
 * Truncate from the MIDDLE so the distinguishing tail of a long string stays
 * readable — the failure mode of CSS `line-clamp`/`text-overflow`, which always
 * eats the end. Use it wherever a list renders many strings that share a long
 * prefix (auto-generated names, dated run labels, deep paths), where clipping
 * the end collapses every row to the same visible text.
 * @param {string} value - Source string (non-strings coerce; nullish → '')
 * @param {number} [max=48] - Maximum length of the RESULT in CODE POINTS, ellipsis included.
 *   A non-finite cap returns the string whole rather than discarding it.
 * @returns {string} `value` when it already fits, else `head…tail`
 */
export function middleTruncate(value, max = 48) {
  const str = value == null ? '' : String(value);
  // A cap that isn't a real number can't middle-truncate anything — return the
  // string untouched. (`Math.max(0, NaN)` is NaN, so a naive slice would
  // silently return '' and swallow the value.)
  if (!Number.isFinite(max)) return str;
  const cap = Math.floor(max);
  // Slice on CODE POINTS, not UTF-16 code units: cutting through a surrogate
  // pair (any emoji / astral character) emits a lone surrogate that renders as
  // the replacement glyph.
  const chars = Array.from(str);
  // A cap that can't fit the ellipsis plus one char on each side has no
  // meaningful middle-truncation; fall back to a plain head slice.
  if (cap < 3) return chars.slice(0, Math.max(0, cap)).join('');
  if (chars.length <= cap) return str;
  const head = Math.ceil((cap - 1) / 2);
  const tail = cap - 1 - head;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
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
function parseSizeGb(sizeStr) {
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

/**
 * Clamp a numeric value `n` into the inclusive range `[min, max]`.
 * @param {number} n - Value to clamp
 * @param {number} min - Lower bound
 * @param {number} max - Upper bound
 * @returns {number} Clamped value
 */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Capitalize the first character of a string, leaving the rest untouched
 * (e.g. "female" → "Female"). Non-strings and empty strings pass through
 * unchanged rather than throwing.
 * @param {string} s
 * @returns {string}
 */
export function capitalize(s) {
  return typeof s === 'string' && s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

