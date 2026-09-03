export const CRON_PRESETS = [
  { value: '*/15 * * * *', label: 'Every 15 min' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */2 * * *', label: 'Every 2 hours' },
  { value: '0 */4 * * *', label: 'Every 4 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 7 * * *', label: 'Daily at 7 AM' },
  { value: '0 7 * * 1-5', label: 'Weekdays at 7 AM' },
  { value: '0 9,12,15,18 * * *', label: 'Peak hours (9, 12, 3, 6)' },
  { value: '0 0 * * 0', label: 'Weekly Sun midnight' },
  { value: '0 0 1 * *', label: 'Monthly 1st at midnight' }
];

export function isCronExpression(val) {
  return typeof val === 'string' && val.trim().split(/\s+/).length === 5;
}

const DOW_MAP = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };

// Default schedule the pickers seed with (07:00 daily) — kept in one place so
// the time picker's fallback and every call site's seed cron stay in lockstep.
export const DEFAULT_TIME = '07:00';
export const DEFAULT_CRON = '0 7 * * *';

// Weekly default for a Monday-morning cadence (mirrors the server's
// DEFAULT_WEEKLY_CRON), so a task converted from a weekly cadence never lands
// on a weekend.
export const DEFAULT_WEEKLY_CRON = '0 7 * * 1';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Approximate a numeric interval as a 5-field cron expression. Mirrors the
 * server's `cronFromIntervalMs` (server/services/taskScheduleConstants.js) so a
 * numeric cadence picker and the server-side migration derive the SAME
 * expression — keep the two in lockstep.
 */
export function cronFromIntervalMs(intervalMs) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CRON;
  if (ms === WEEK_MS) return DEFAULT_WEEKLY_CRON;
  if (ms >= DAY_MS) return DEFAULT_CRON;
  if (ms >= HOUR_MS) {
    const hours = Math.round(ms / HOUR_MS);
    if (hours <= 1) return '0 * * * *';
    // Only an even divisor of 24 lays out evenly across a day.
    const step = [2, 3, 4, 6, 8, 12].find((h) => h >= hours) || 12;
    return `0 */${step} * * *`;
  }
  const minutes = Math.min(59, Math.max(1, Math.round(ms / MINUTE_MS)));
  return `*/${minutes} * * * *`;
}

// Sunday-first, matching cron's day-of-week numbering (0 = Sunday).
export const WEEKDAYS = [
  { value: 0, short: 'S', label: 'Sun' },
  { value: 1, short: 'M', label: 'Mon' },
  { value: 2, short: 'T', label: 'Tue' },
  { value: 3, short: 'W', label: 'Wed' },
  { value: 4, short: 'T', label: 'Thu' },
  { value: 5, short: 'F', label: 'Fri' },
  { value: 6, short: 'S', label: 'Sat' }
];

// Expand a cron day-of-week field into sorted, unique day numbers (0-6, Sun=0).
// Returns [] for '*' (every day). Returns null for anything this simple parser
// can't represent (steps like `*/2`, out-of-range values, malformed ranges).
function parseDowField(dow) {
  if (dow === '*') return [];
  const out = new Set();
  for (const token of dow.split(',')) {
    if (/^\d+$/.test(token)) {
      const value = Number(token);
      if (value > 7) return null;
      out.add(value % 7); // cron accepts 7 as Sunday; normalize to 0
      continue;
    }
    const range = token.match(/^(\d+)-(\d+)$/);
    if (!range) return null;
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > 7 || end > 7 || start > end) return null;
    for (let day = start; day <= end; day++) out.add(day % 7);
  }
  return [...out].sort((a, b) => a - b);
}

// Parse a "simple" cron (fixed minute + hour, any day-of-month/month, an
// enumerable day-of-week set) into { days: number[], time: 'HH:MM' }.
// `days` is empty for an every-day (daily) schedule. Returns null when the
// expression is an interval/stepped/complex cron the day+time picker can't
// round-trip — callers fall back to the raw text field in that case.
export function parseSimpleCron(expr) {
  if (!expr) return null;
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const minute = Number(min);
  const hr = Number(hour);
  if (minute > 59 || hr > 23) return null;
  const days = parseDowField(dow);
  if (!days) return null;
  return { days, time: `${String(hr).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

// Build a cron expression from a day-of-week set + a 'HH:MM' time.
// No days selected → every day (daily at that time). Returns '' for an
// unparseable time so callers can treat it as "not yet set".
export function buildWeeklyCron(days, time) {
  const [hr, minute] = String(time || '').split(':').map(Number);
  if (!Number.isInteger(hr) || !Number.isInteger(minute)) return '';
  const dow = !days || days.length === 0 ? '*' : [...days].sort((a, b) => a - b).join(',');
  return `${minute} ${hr} * * ${dow}`;
}

export const RECURRENCE_FREQUENCIES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly-date', label: 'Day of the month' },
  { value: 'monthly-weekday', label: 'Nth weekday of the month' },
  { value: 'custom', label: 'Custom cron' },
];

export const RECURRENCE_ORDINALS = [
  { value: 'first', label: 'First' },
  { value: 'second', label: 'Second' },
  { value: 'third', label: 'Third' },
  { value: 'fourth', label: 'Fourth' },
  { value: 'last', label: 'Last' },
];

const MONTHLY_DAY_RANGES = {
  first: '1-7',
  second: '8-14',
  third: '15-21',
  fourth: '22-28',
};

const ORDINAL_LABELS = Object.fromEntries(RECURRENCE_ORDINALS.map(({ value, label }) => [value, label]));

const validTime = (time) => {
  const match = String(time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : null;
};

const sortedUniqueDays = (days) => [...new Set((Array.isArray(days) ? days : []).map(Number))]
  .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
  .sort((a, b) => a - b);

/**
 * Parse the part of cron that the recurrence editor can round-trip. More
 * expressive/legacy strings return a custom rule so the advanced editor never
 * replaces a value merely because its friendly controls cannot model it.
 */
export function parseCronToRecurrence(expr) {
  if (!expr) return null;
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', cron: String(expr).trim() };
  const [minute, hour, dom, mon, dow] = parts;
  const time = validTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  if (!time || mon !== '*') return { frequency: 'custom', cron: String(expr).trim() };

  if (dom === '*') {
    const days = parseDowField(dow);
    if (!days) return { frequency: 'custom', cron: String(expr).trim() };
    return days.length === 0
      ? { frequency: 'daily', interval: 1, weekdays: [], time }
      : { frequency: 'weekly', interval: 1, weekdays: days, time };
  }

  if (dow === '*' && /^\d{1,2}$/.test(dom)) {
    const dayOfMonth = Number(dom);
    if (dayOfMonth >= 1 && dayOfMonth <= 31) {
      return { frequency: 'monthly-date', interval: 1, dayOfMonth, time };
    }
  }

  const ordinal = Object.entries(MONTHLY_DAY_RANGES).find(([, range]) => range === dom)?.[0];
  if (ordinal && /^\d$/.test(dow) && Number(dow) <= 7) {
    return { frequency: 'monthly-weekday', interval: 1, ordinal, weekday: Number(dow) % 7, time };
  }

  return { frequency: 'custom', cron: String(expr).trim() };
}

/** Build a compatibility cron string from a recurrence rule. */
export function buildCronFromRecurrence(rule) {
  if (!rule || typeof rule !== 'object') return '';
  if (rule.frequency === 'custom') return String(rule.cron || '').trim();
  const time = validTime(rule.time);
  if (!time) return '';
  const [hour, minute] = time.split(':').map(Number);
  const prefix = `${minute} ${hour}`;
  const interval = Math.max(1, Number(rule.interval) || 1);

  if (rule.frequency === 'daily') {
    const days = sortedUniqueDays(rule.weekdays);
    // A stepped day-of-month field combined with a weekday is not an exact
    // representation of an anchored daily interval. Keep the preview honest.
    if (days.length && interval > 1) return '';
    return `${prefix} ${interval > 1 ? `*/${interval}` : '*'} * ${days.length ? days.join(',') : '*'}`;
  }
  if (rule.frequency === 'weekly') {
    const days = sortedUniqueDays(rule.weekdays);
    return `${prefix} * * ${days.length ? days.join(',') : '*'}`;
  }
  if (rule.frequency === 'monthly-date') {
    const day = Number(rule.dayOfMonth);
    return Number.isInteger(day) && day >= 1 && day <= 31 ? `${prefix} ${day} * *` : '';
  }
  if (rule.frequency === 'monthly-weekday') {
    const range = MONTHLY_DAY_RANGES[rule.ordinal];
    const weekday = Number(rule.weekday);
    if (!range || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return '';
    // `last` is intentionally left to the recurrence scheduler; there is no
    // portable five-field cron spelling for the last weekday of a month.
    return range ? `${prefix} ${range} * ${weekday}` : '';
  }
  return '';
}

/** Human-readable rendering for a rule emitted by CronSchedulePicker. */
export function describeRecurrence(rule) {
  if (!rule) return '';
  if (rule.frequency === 'custom') return rule.cron || '';
  const time = validTime(rule.time) || '—';
  const interval = Math.max(1, Number(rule.interval) || 1);
  if (rule.frequency === 'daily') {
    const weekdaysOnly = sortedUniqueDays(rule.weekdays).join(',') === '1,2,3,4,5';
    if (weekdaysOnly && interval === 1) return `Weekdays at ${time}`;
    const days = sortedUniqueDays(rule.weekdays).map(day => WEEKDAYS[day]?.label || day).join(', ');
    const cadence = interval === 1 ? 'Daily' : `Every ${interval} days`;
    return `${cadence}${days ? ` on ${days}` : ''} at ${time}`;
  }
  if (rule.frequency === 'weekly') {
    const days = sortedUniqueDays(rule.weekdays).map(day => WEEKDAYS[day]?.label || day).join(', ');
    const cadence = interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    return `${cadence}${days ? ` on ${days}` : ''} at ${time}`;
  }
  if (rule.frequency === 'monthly-date') {
    const cadence = interval === 1 ? 'every month' : `every ${interval} months`;
    return `Day ${rule.dayOfMonth || '—'} of ${cadence} at ${time}`;
  }
  if (rule.frequency === 'monthly-weekday') {
    const weekday = WEEKDAYS[Number(rule.weekday)]?.label || 'weekday';
    const cadence = interval === 1 ? 'every month' : `every ${interval} months`;
    return `${ORDINAL_LABELS[rule.ordinal] || 'Nth'} ${weekday} of ${cadence} at ${time}`;
  }
  return '';
}

export function describeCron(expr) {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const segments = [];
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour)) {
    const normalizedDow = dow.split(',').sort().join(',');
    if (dow === '1-5' || normalizedDow === '1,2,3,4,5') segments.push('Weekdays');
    else if (dow === '0,6' || dow === '6,0' || normalizedDow === '0,6' || dow === '0,7' || dow === '7,0') segments.push('Weekends');
    else if (dow !== '*' && normalizedDow !== '0,1,2,3,4,5,6') segments.push(dow.split(',').map(d => DOW_MAP[d] || d).join(', '));
    if (dom !== '*') segments.push(`day ${dom}`);
    if (mon !== '*') segments.push(`month ${mon}`);
    segments.push(`at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
  } else if (min.startsWith('*/')) {
    segments.push(`every ${min.slice(2)} min`);
  } else if (hour.startsWith('*/')) {
    segments.push(`every ${hour.slice(2)} hours at :${min.padStart(2, '0')}`);
  } else {
    return expr;
  }
  return segments.join(' ');
}

// Interval-mode cadences for autonomous jobs — the client mirror of
// `INTERVAL_OPTIONS` in `server/services/autonomousJobs/constants.js`. Values
// must stay in lockstep with `resolveIntervalMs` there, since the server
// recomputes `intervalMs` from whichever value a picker submits. Lives here
// rather than in a component so a second job-scheduling surface doesn't fork
// its own copy of the list.
export const JOB_INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour' },
  { value: 'every-2-hours', label: 'Every 2 Hours' },
  { value: 'every-4-hours', label: 'Every 4 Hours' },
  { value: 'every-8-hours', label: 'Every 8 Hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 Weeks' },
  { value: 'monthly', label: 'Monthly' }
];
