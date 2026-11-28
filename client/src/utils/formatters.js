/** Shared formatting utilities for the client. */

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
 * Format a Date as a browser-local YYYY-MM-DD calendar key.
 * Unlike `toISOString()`, this preserves the user's local day near UTC boundaries.
 * @param {Date} date
 * @returns {string}
 */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Shift a YYYY-MM-DD calendar key by whole days without local-time/DST drift.
 * @param {string} dateKey
 * @param {number} days
 * @returns {string}
 */
export function shiftISODate(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Coerce a Date / ISO timestamp / epoch ms into a Date. A bare calendar date
 * ("2026-03-05") is anchored at LOCAL midnight; `new Date` parses it as UTC and
 * renders the previous day west of Greenwich.
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
 * Like `formatTimeOfDay` but WITH seconds (e.g., "1:30:45 PM"), for log/queue rows.
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
 * Format a date in the browser's short numeric locale form (e.g., "3/5/2026") for compact cells.
 * @param {string|number|Date|null} value - ISO timestamp, `YYYY-MM-DD`, epoch ms, or Date
 * @param {string} [fallback=''] - Rendered for missing/invalid input
 * @returns {string} Formatted numeric date
 * Never write `new Date(x).toLocaleDateString()` inline; pick the helper for the shape you want, and do not re-define formatters inside components.
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
 * Abbreviated weekday plus time-of-day (e.g., "Mon, 7:00 AM").
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
 * Abbreviated weekday only (e.g., "Mon") for calendar headers and timeline ticks.
 * @param {string|number|Date|null} value
 * @param {object} [options]
 * @param {string} [options.timeZone] - Render the weekday in a specific IANA timezone
 * @returns {string} Abbreviated weekday, or '' for missing/invalid input
 */
export function formatWeekdayShort(value, { timeZone } = {}) {
  return localized('date', value, { weekday: 'short', ...(timeZone ? { timeZone } : {}) }, '');
}

/**
 * Weekday-led date with a short month (e.g., "Monday, Mar 5"); distinct from `formatDateFull` (long month, always with year).
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
 * @param {boolean} [options.milliseconds=false] - Add milliseconds ("02:30:45.120 PM"); implies seconds
 * @param {boolean} [options.hour12] - Force 12h/24h; omit to follow the locale
 * @returns {string} Formatted clock time, or '' for missing/invalid input
 */
export function formatClockTime(date, { timeZone, seconds = true, milliseconds = false, hour12 } = {}) {
  return localized('time', date, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds || milliseconds ? { second: '2-digit' } : {}),
    ...(milliseconds ? { fractionalSecondDigits: 3 } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(hour12 === undefined ? {} : { hour12 }),
  }, '');
}

const HOUR_MERIDIEM = {
  long: [' AM', ' PM'],
  compact: ['AM', 'PM'],
  tiny: ['a', 'p'],
  lower: ['am', 'pm'],
};

/**
 * Format a bare hour-of-day number (0-23) as a 12-hour clock label; `style` picks separator and case.
 * @param {number|string|null} hour - Hour of day, 0-23 (numeric strings accepted)
 * @param {object} [options]
 * @param {'long'|'compact'|'tiny'|'lower'} [options.style='long'] - `3 PM` / `3PM` / `3p` / `3pm`
 * @param {string} [options.fallback='—'] - Rendered for missing/non-numeric input
 * @returns {string} Formatted hour, or the fallback
 */
export function formatHourOfDay(hour, { style = 'long', fallback = '—' } = {}) {
  if (hour === null || hour === undefined || hour === '') return fallback;
  const h = Number(hour);
  if (!Number.isFinite(h)) return fallback;
  const [am, pm] = HOUR_MERIDIEM[style] || HOUR_MERIDIEM.long;
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${h < 12 ? am : pm}`;
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
 * Age in whole DAYS ("today", "1 day ago", "412 days ago"); `timeAgo` collapses anything past a month into buckets.
 * @param {string|number|Date|null} value - ISO timestamp, epoch ms, or Date
 * @param {string} fallback - Text for null/missing/unparseable values
 * @returns {string} Day-count label
 */
export function formatAgeDays(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  const time = toDisplayDate(value).getTime();
  if (!Number.isFinite(time)) return fallback;
  const days = Math.floor((Date.now() - time) / 86400000);
  // <= 0 covers a clock skew ahead of the publish date — never "-1 days ago".
  if (days <= 0) return 'today';
  return `${GROUPED_INTEGER.format(days)} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Future timestamp as a relative "in X" string mirroring timeAgo's buckets; `fallback` for null or past dates.
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
 * `formatCompactCount` for a possibly-absent count: em-dash instead of "0", so "no data" and "measured zero" differ.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatCompactCountOrDash(n) {
  return n == null ? '—' : formatCompactCount(n);
}

// Grouping is pinned to en-US: the UI is English-only and `$` is a US mark, so "$4.610,09" reads as a typo.
// Date/time helpers keep the browser locale on purpose.
const GROUPED_INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const USD_CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Thousands-separated count the user reads exactly: 2762 → "2,762" (`formatCompactCount`'s "2.8K" loses precision).
 * @param {number|string|null|undefined} n
 * @param {object} [options]
 * @param {number} [options.maximumFractionDigits=0] - Optional precision for scores and other fractional values
 * @param {string} [options.fallback='—'] - Rendered when the value is missing/unparseable
 * @returns {string} e.g. "2,762"
 */
export function formatCount(n, { fallback = '—', maximumFractionDigits = 0 } = {}) {
  const precision = Number.isInteger(maximumFractionDigits) ? Math.max(0, Math.min(8, maximumFractionDigits)) : 0;
  const value = roundForDisplay(n, precision);
  if (precision && value !== null) return new Intl.NumberFormat('en-US', { maximumFractionDigits: precision }).format(value + 0);
  // `+ 0` folds the -0 that a negative fraction rounds to, which Intl renders as "-0".
  return value === null ? fallback : GROUPED_INTEGER.format(value + 0);
}

/**
 * Round to `decimals` places and drop trailing zeros (170.35000000000002 → 170.4); null for non-finite input.
 * @param {number|string|null|undefined} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundForDisplay(value, decimals) {
  // Number(null|''|'   '|false) are all 0 and would render a missing measurement as "0 lbs"; accept only a number or non-blank numeric string.
  const isNumeric = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '');
  if (!isNumeric) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

/**
 * One-line readout of a mastered render's measured audio (#10249).
 * @param {{integratedLufs:number, truePeakDb:number, masteredFrom?:{integratedLufs:number}}|null|undefined} loudness
 * @returns {string} e.g. "-14.1 LUFS, peak -1.6 dB (was -27.3 LUFS)", or '' when unmeasured
 */
export function formatLoudness(loudness) {
  const lufs = roundForDisplay(loudness?.integratedLufs, 1);
  const peak = roundForDisplay(loudness?.truePeakDb, 1);
  if (lufs == null || peak == null) return '';
  const was = roundForDisplay(loudness.masteredFrom?.integratedLufs, 1);
  return `${lufs} LUFS, peak ${peak} dB${was == null ? '' : ` (was ${was} LUFS)`}`;
}

/**
 * Format a body weight: unit-converted raw floats (170.35000000000002) read as false precision, so round to one decimal by default.
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
 * Format a percentage, rounding away float noise like `formatWeight` (18.400000000000002 → "18.4%").
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
 * Format a USD amount for display: `$12.34`, `$4,610.09`.
 * `signed` keeps the minus OUTSIDE the dollar sign (`-$5.00`); `trimWhole` drops `.00` on a round typed price;
 * amounts past a thousand are grouped; `compact` abbreviates (`$9.4K`) for chart axes.
 *
 * @param {number} value - Dollar amount (nullish renders as $0.00; a non-nullish
 *   value that fails to parse as a finite number — NaN, a broken calc — renders
 *   `fallback` instead, so a computation failure never masquerades as "$0.00")
 * @param {{ signed?: boolean, trimWhole?: boolean, compact?: boolean, fallback?: string, maximumFractionDigits?: number }} [options]
 * @returns {string} e.g. "$12.34", "-$5.00", "$200"
 */
export function formatUsd(value, { signed = false, trimWhole = false, compact = false, fallback = '—', maximumFractionDigits = 2 } = {}) {
  const n = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Under half a cent Intl renders `-$0.00`; snap to a true zero and drop the sign so a vanished saving doesn't read as a loss.
  const raw = signed ? Math.abs(n) : n;
  const precision = Number.isInteger(maximumFractionDigits) ? Math.max(2, Math.min(8, maximumFractionDigits)) : 2;
  const magnitude = Math.abs(raw) < 0.5 * 10 ** -precision ? 0 : raw;
  const body = compact ? USD_COMPACT.format(magnitude) : trimWhole && Number.isInteger(magnitude)
    ? GROUPED_INTEGER.format(magnitude)
    : precision === 2 ? USD_CENTS.format(magnitude) : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: precision }).format(magnitude);
  return `${signed && n < 0 && magnitude !== 0 ? '-' : ''}$${body}`;
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
  // Clamp the unit index so oversized values still get a known suffix, not `undefined`.
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Format a model's decimal-GB (10^9 bytes, as HuggingFace quotes sizes) download footprint as "~29 GB";
 * null for missing/zero/invalid values.
 * @param {number|null|undefined} gb
 * @returns {string|null}
 */
export function formatDownloadGb(gb) {
  return typeof gb === 'number' && Number.isFinite(gb) && gb > 0 ? `~${gb} GB` : null;
}

/**
 * Format a model context window (tokens) compactly, e.g. 32768 → "32K ctx", 1000000 → "1M ctx"; null for missing/invalid.
 *
 * Two unit systems, picked per value: local runtimes report BINARY windows (131072 → "128K"), cloud vendors DECIMAL
 * ones (128000 → "128K"). A value that divides evenly by 1000 is decimal, everything else binary; dividing a
 * decimal window by 1024 would render 128,000 as "125K".
 *
 * `suffix` follows the number; pass `''` when surrounding prose already supplies the noun.
 *
 * @param {number|null|undefined} tokens
 * @param {{ suffix?: string }} [options]
 * @returns {string|null}
 */
export function formatContextLength(tokens, { suffix = ' ctx' } = {}) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  const k = n % 1000 === 0 ? 1000 : 1024;
  if (n >= k * k) {
    const m = n / (k * k);
    return `${parseFloat(m.toFixed(m % 1 ? 1 : 0))}M${suffix}`;
  }
  if (n >= k) return `${Math.round(n / k)}K${suffix}`;
  return `${n}${suffix}`;
}

/** Context length with NO unit suffix (`4096` → `"4K"`) for prose that already says "tokens of context". */
export function formatContextTokens(tokens) {
  return formatContextLength(tokens, { suffix: '' });
}

/**
 * How fast a measured model generated: `"58.5 tok/s"`, `"~58.5 tok/s"` for a frame-counted estimate, or
 * `"240 chars/s"` when no token counts were reported; null when neither was measured, or when only a
 * `reasoningHidden` chars/s exists.
 * The `~` is not decoration: PortOS has no tokenizer, so frame-derived counts must not look tokenizer-produced.
 *
 * @param {{meanTokensPerSecond?: number|null, meanCharsPerSecond?: number|null, tokensEstimated?: boolean|null, reasoningHidden?: boolean|null}} perf
 */
export function throughputLabel(perf) {
  const tokens = perf?.meanTokensPerSecond;
  if (typeof tokens === 'number' && Number.isFinite(tokens)) {
    return `${perf?.tokensEstimated ? '~' : ''}${tokens} tok/s`;
  }
  // A thinking model's chars/s counts only its one-character visible answer (`reasoningHidden`), not speed.
  if (perf?.reasoningHidden === true) return null;
  const chars = perf?.meanCharsPerSecond;
  return typeof chars === 'number' && Number.isFinite(chars) ? `${chars} chars/s` : null;
}

/**
 * Format seconds as MM:SS (75 → "01:15"), or H:MM:SS from an hour up. Negative and non-finite clamp to 0.
 */
export function formatCountdown(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
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
 * Format seconds as M:SS (75 → "1:15"). Returns `'—'` for missing/invalid/negative input; a genuine zero is "0:00".
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
export function formatTimecode(seconds, digits = 2) {
  if (!Number.isFinite(seconds) || seconds < 0) return `0:00.${'0'.repeat(digits)}`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(digits).padStart(3 + digits, '0')}`;
}

/**
 * Format a date with a short month label (e.g., "Mar 5, 2026"); `'—'` for missing/invalid input.
 */
export function formatDateShort(value) {
  return localized('date', value, { year: 'numeric', month: 'short', day: 'numeric' }, '—');
}

// Per-call LLM timeout bounds: client-side mirror of MIN_TIMEOUT / MAX_TIMEOUT in server/lib/aiToolkit/constants.js (the client
// can't import across the server boundary). Keep both in lockstep or one validator accepts what the other rejects.
export const TIMEOUT_INPUT_MIN_MS = 1000;
export const TIMEOUT_INPUT_MAX_MS = 43_200_000;
export const TIMEOUT_INPUT_STEP_MS = 1000;

/**
 * Parse a raw string from a timeout (ms) input. Returns `null` for blank input (caller clears the override) and for
 * anything outside the integer [TIMEOUT_INPUT_MIN_MS, TIMEOUT_INPUT_MAX_MS] range, so the client never emits PUTs the
 * server's Zod schema would 400.
 *
 * Digit-only strings (`^\d+$`) only: stricter than `Number(v)` ("1e3", "1000.5"); mirrored in `stageConfigUpdateSchema`'s
 * preprocess in server/lib/pipelineValidation.js, so loosen both in lockstep.
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
 * Format a duration in milliseconds; buckets down from days ("2d 3h") rather than an unbounded hour count.
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
 * Format a calendar event's date+time with a distinct all-day rendering: timed events show a short weekday plus time
 * ("Sat, Apr 1, 1:30 PM"), all-day events a full weekday and year. Missing/unparseable input renders ''.
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
 * Derive a default record name from a gallery-image filename: drop path + extension, `-`/`_` to spaces, title-case, cap at
 * 120 chars (the server-side name limit).
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
 * Truncate from the MIDDLE so the distinguishing tail of a long string stays readable (CSS `line-clamp` eats the end);
 * for lists of strings sharing a long prefix.
 * @param {string} value - Source string (non-strings coerce; nullish → '')
 * @param {number} [max=48] - Maximum length of the RESULT in CODE POINTS, ellipsis included.
 *   A non-finite cap returns the string whole rather than discarding it.
 * @returns {string} `value` when it already fits, else `head…tail`
 */
export function middleTruncate(value, max = 48) {
  const str = value == null ? '' : String(value);
  // A non-numeric cap can't truncate anything; `Math.max(0, NaN)` is NaN and a slice would return ''.
  if (!Number.isFinite(max)) return str;
  const cap = Math.floor(max);
  // Slice on CODE POINTS: cutting a surrogate pair emits a lone surrogate that renders as the replacement glyph.
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

/**
 * Short display name for a Claude model id: drops the `claude-` prefix and a
 * trailing 8-digit date stamp only, so `claude-sonnet-5-5` stays "sonnet-5-5"
 * (a bare `-\d+` strip would collapse it to "sonnet-5").
 */
export function shortClaudeModelName(model) {
  return String(model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
