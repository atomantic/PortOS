// Ambient-context voice tools: current time, calendar (today / next), and
// weather. Three intent groups live here (`calendar`, `weather`; time_now is
// always-on and left out of TOOL_GROUPS). All time formatting is scoped to the
// user's timezone because the server runs TZ=UTC.

import { getEvents as getCalendarEvents } from '../../calendarSync.js';
import { fetchWithTimeout } from '../../../lib/fetchWithTimeout.js';
import { getUserTimezone, todayInTimezone, getLocalParts, getUtcOffsetMs } from '../../../lib/timezone.js';
import { getSettings } from '../../settings.js';
import { clampLimit } from './shared.js';

// Calendar reads — "what's on my calendar", "what do I have today",
// "next meeting", "what's next", "upcoming", "any appointments". Tight-ish
// so plain "open calendar" still routes to ui_navigate, not calendar_today.
export const CALENDAR_INTENT_RE = /\b(calendar|agenda|meeting|appointment|event)s?\b|\bwhat(?:'s| is| do i have)?\b[^.!?\n]{0,30}\b(today|next|coming up|upcoming|scheduled|on my (?:plate|schedule|calendar))\b|\bwhat'?s next\b/i;
// Weather — "what's the weather", "is it raining", "how hot/cold",
// "temperature outside", "forecast".
export const WEATHER_INTENT_RE = /\b(weather|forecast|temperature|raining|snowing|sunny|cloudy|how (?:hot|cold|warm)|degrees? (?:out|outside))\b/i;

// ----- Calendar helpers (calendar_today / calendar_next) -----
// The calendar cache stores ISO `startTime`/`endTime` (UTC or with offset) plus
// `title`, `location`, and `isAllDay` (the cache field name — see
// calendarGoogleSync.js / calendarApiSync.js; the tool's own output uses
// `allDay`). We format times in the user's TZ so a spoken "10 AM" matches the
// wall clock, not the server's UTC.
const formatEventTime = (iso, tz) => {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
};
const summarizeEvent = (e, tz) => {
  const start = formatEventTime(e?.startTime, tz);
  const when = e?.isAllDay ? 'all day' : (start || 'time TBD');
  const loc = e?.location ? ` at ${e.location}` : '';
  return `${e?.title || 'Untitled event'} (${when})${loc}`;
};
// UTC timestamp (ms) of local midnight for the `YYYY-MM-DD` day string in `tz`.
// The server runs TZ=UTC, so we subtract the TZ offset from the naive UTC parse
// of the day string. Evaluate the offset AT the target day's midnight (not at
// `now`) so a DST transition elsewhere in the day can't shift the result by an
// hour. The naive parse lands within ~14h of local midnight — close enough that
// re-evaluating the offset at that candidate instant converges to the correct
// offset across a DST boundary.
export const anchorLocalMidnightUtc = (dayStr, tz) => {
  const naiveUtc = Date.parse(`${dayStr}T00:00:00Z`);
  const firstOffset = getUtcOffsetMs(new Date(naiveUtc), tz);
  const candidate = naiveUtc - firstOffset;
  const refinedOffset = getUtcOffsetMs(new Date(candidate), tz);
  return naiveUtc - refinedOffset;
};

// ----- Weather helpers (weather_now) -----
// WMO weather interpretation codes → short spoken text. Open-Meteo returns the
// integer `weather_code`; this small table avoids pulling in a weather lib.
const WEATHER_CODES = {
  0: 'clear sky',
  1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};
const describeWeatherCode = (code) => WEATHER_CODES[code] ?? 'unknown conditions';
// Fallback location when the user hasn't set one and didn't pass lat/lon.
// San Francisco — a sensible documented default; the tool description tells
// the LLM to pass lat/lon when the user names a place.
const DEFAULT_LAT = 37.7749;
const DEFAULT_LON = -122.4194;

export const AMBIENT_TOOLS = [
  {
    name: 'time_now',
    description:
      'Report the current local date, time, and day of week. Use when the user asks "what time is it?", "what day is today?", "what\'s the date?". LLMs don\'t know the current time on their own — always call this tool rather than guessing.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      // Server runs TZ=UTC, so formatting must be scoped to the user's TZ.
      const tz = await getUserTimezone();
      const now = new Date();
      const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(now);
      const parts = getLocalParts(now, tz);
      return {
        ok: true,
        iso: now.toISOString(),
        timezone: tz,
        date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
        dayOfWeek: fmt({ weekday: 'long' }),
        time: fmt({ hour: 'numeric', minute: '2-digit' }),
        summary: `${fmt({ weekday: 'long' })}, ${fmt({ month: 'long', day: 'numeric', year: 'numeric' })} at ${fmt({ hour: 'numeric', minute: '2-digit' })}.`,
      };
    },
  },

  {
    name: 'calendar_today',
    description:
      "Report today's calendar events. Use when the user asks \"what's on my calendar today?\", \"what do I have today?\", \"any meetings today?\". Reads from the user's synced calendar accounts (Google etc.). Returns up to 10 events with title, time, and location.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max events to return (default 10, max 20).' },
      },
    },
    execute: async ({ limit = 10 } = {}) => {
      const max = clampLimit(limit, 10, 20);
      const tz = await getUserTimezone();
      const today = todayInTimezone(tz); // YYYY-MM-DD in the user's TZ
      // The server runs TZ=UTC and event startTimes carry an offset/Z, so the
      // [startDate, endDate] bounds must be the user's LOCAL day expressed in
      // UTC — otherwise a late-evening PT event lands on the next UTC day and
      // gets dropped. Anchor midnight-local by subtracting the TZ offset, but
      // evaluate that offset at the TARGET day's midnight (not at `now`): on a
      // DST-transition day the offset at `now` can differ from the offset at
      // midnight by an hour, shifting the window and dropping/duplicating
      // boundary events. Two passes converge (the first guess lands within
      // ~14h of local midnight; the second re-evaluates at that instant).
      const localMidnightUtc = anchorLocalMidnightUtc(today, tz);
      const startDate = new Date(localMidnightUtc).toISOString();
      const endDate = new Date(localMidnightUtc + 86399999).toISOString();
      const { events = [] } = await getCalendarEvents({ startDate, endDate, limit: max });
      const items = events.map((e) => ({
        title: e.title,
        startTime: e.startTime,
        time: e.isAllDay ? 'all day' : formatEventTime(e.startTime, tz),
        location: e.location || null,
        allDay: !!e.isAllDay,
      }));
      return {
        ok: true,
        date: today,
        count: items.length,
        events: items,
        summary: items.length
          ? `${items.length} event${items.length === 1 ? '' : 's'} today: ${events.slice(0, max).map((e) => summarizeEvent(e, tz)).join('; ')}.`
          : 'Nothing on your calendar today.',
      };
    },
  },

  {
    name: 'calendar_next',
    description:
      'Report the next upcoming calendar event. Use when the user asks "what\'s next?", "what\'s my next meeting?", "when\'s my next appointment?". Reads from the user\'s synced calendar accounts and returns the soonest event starting from now.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const tz = await getUserTimezone();
      const nowIso = new Date().toISOString();
      // Look ahead 30 days; getEvents returns events sorted ascending by
      // startTime, so the first one at/after now is "next". Pull a small
      // window and filter in-memory rather than relying on exact boundary.
      const horizon = new Date(Date.now() + 30 * 86400000).toISOString();
      const { events = [] } = await getCalendarEvents({
        startDate: nowIso,
        endDate: horizon,
        limit: 50,
      });
      // Match calendarSync.getEvents' range semantics (it keeps events whose
      // endTime >= startDate), so an in-progress meeting and an all-day event
      // that began at local midnight today both still count as "next" — a
      // strict startTime >= now would drop them. Use endTime when present,
      // falling back to startTime for events that carry only a start.
      const nowMs = Date.now();
      const next = events.find((e) => {
        const ref = new Date(e?.endTime || e?.startTime);
        return !Number.isNaN(ref.getTime()) && ref.getTime() >= nowMs;
      });
      if (!next) {
        return { ok: true, found: false, summary: 'Nothing coming up on your calendar in the next 30 days.' };
      }
      const startDate = new Date(next.startTime);
      const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(startDate);
      const timeLabel = next.isAllDay ? 'all day' : (formatEventTime(next.startTime, tz) || 'time TBD');
      const loc = next.location ? ` at ${next.location}` : '';
      return {
        ok: true,
        found: true,
        title: next.title,
        startTime: next.startTime,
        location: next.location || null,
        allDay: !!next.isAllDay,
        summary: `Next up: ${next.title || 'Untitled event'} — ${dayLabel}, ${timeLabel}${loc}.`,
      };
    },
  },

  {
    name: 'weather_now',
    description:
      'Report the current weather (temperature + conditions) for a location. Use when the user asks "what\'s the weather?", "is it raining?", "how hot is it outside?". Pass `lat`/`lon` for a specific place; with no coordinates it uses a saved location if one is configured, otherwise a default location. Uses the free Open-Meteo service (no API key).',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude (-90 to 90). Omit to use the configured/default location.' },
        lon: { type: 'number', description: 'Longitude (-180 to 180). Omit to use the configured/default location.' },
      },
    },
    execute: async ({ lat, lon } = {}) => {
      // Resolve location: explicit params > settings.location > default.
      // numOrNull guards both paths so a null/empty/cleared coordinate falls
      // through to the default — `Number(null)` is 0 (a valid-but-wrong 0,0
      // coordinate), so reusing this helper for the config values is what keeps
      // a cleared `settings.location` from pinning the Gulf of Guinea.
      const numOrNull = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const settings = await getSettings().catch(() => ({}));
      // Treat the configured location as a both-or-neither pair (the save-time
      // schema enforces this, but a hand-edited settings.json could set only
      // one half). A half-set pair falls through to the default for BOTH
      // coordinates rather than mixing one custom value with one default.
      const cfgLat = numOrNull(settings?.location?.lat);
      const cfgLon = numOrNull(settings?.location?.lon);
      const cfgValid = cfgLat !== null && cfgLon !== null;
      const resolvedLat = numOrNull(lat) ?? (cfgValid ? cfgLat : null) ?? DEFAULT_LAT;
      const resolvedLon = numOrNull(lon) ?? (cfgValid ? cfgLon : null) ?? DEFAULT_LON;
      if (resolvedLat < -90 || resolvedLat > 90 || resolvedLon < -180 || resolvedLon > 180) {
        return { ok: false, summary: 'Latitude must be -90..90 and longitude -180..180.' };
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${resolvedLat}&longitude=${resolvedLon}`
        + '&current=temperature_2m,weather_code&temperature_unit=fahrenheit';
      const res = await fetchWithTimeout(url, {}, 10000).catch((err) => ({ ok: false, error: err?.message }));
      if (!res || !res.ok) {
        return { ok: false, summary: `Couldn't reach the weather service${res?.error ? ` (${res.error})` : ''}.` };
      }
      const data = await res.json().catch(() => null);
      const current = data?.current;
      if (!current || typeof current.temperature_2m !== 'number') {
        return { ok: false, summary: 'The weather service returned no current conditions.' };
      }
      const temp = Math.round(current.temperature_2m);
      const conditions = describeWeatherCode(current.weather_code);
      return {
        ok: true,
        lat: resolvedLat,
        lon: resolvedLon,
        temperatureF: temp,
        weatherCode: current.weather_code,
        conditions,
        summary: `It's ${temp}°F and ${conditions} right now.`,
      };
    },
  },
];
