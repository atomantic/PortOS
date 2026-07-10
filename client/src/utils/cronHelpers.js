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

export function describeCron(expr) {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const segments = [];
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour)) {
    if (dow === '1-5') segments.push('Weekdays');
    else if (dow === '0,6' || dow === '6,0') segments.push('Weekends');
    else if (dow !== '*') segments.push(dow.split(',').map(d => DOW_MAP[d] || d).join(', '));
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
