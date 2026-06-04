// Pure helpers for CyberCity's recent-action timeline overlay.
//
// The Intel pane's ACTIVITY tab shows a flat, newest-at-bottom log; the
// TIMELINE tab instead conveys *cadence* — when bursts of activity happened
// versus quiet stretches — by binning recent events into a density sparkbar
// and grouping them into relative-age buckets. Both transforms are pure so
// they can be unit-tested without a DOM (mirrors cityFilter.js).

// Default cap on events the timeline considers, so a runaway log can't blow
// up the render. `now` is injectable into both transforms for deterministic tests.
const MAX_TIMELINE_EVENTS = 40;

// Lower-case so lookups against the lower-cased color maps in CityIntelPane
// stay robust; the cos:log stream only emits info/warn/error/success/debug, so
// unknown values just fall through to the maps' info default (same as the
// sibling ACTIVITY tab).
const normalizeLevel = (level) => (level || 'info').toLowerCase();

const eventTime = (log) => {
  const t = new Date(log?.timestamp ?? NaN).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Bin recent events into evenly-spaced time slots for a density sparkbar.
 * Returns one entry per bin, oldest-first, each `{ count, level }` where
 * `level` is the highest-severity event in that bin (drives the bar color).
 *
 * @param {Array} logs - raw event log entries (`{ timestamp, level }`)
 * @param {object} opts
 * @param {number} opts.now - reference "now" epoch ms (injectable for tests)
 * @param {number} [opts.windowMs] - how far back the bar spans (default 10m)
 * @param {number} [opts.bins] - number of bars (default 24)
 * @returns {Array<{count:number, level:string|null}>}
 */
export function computeActivityDensity(logs, { now, windowMs = 10 * 60 * 1000, bins = 24 } = {}) {
  const slotMs = windowMs / bins;
  const slots = Array.from({ length: bins }, () => ({ count: 0, level: null }));

  const severityRank = { error: 3, warn: 2, success: 1, info: 0, debug: 0 };

  (logs || []).forEach(log => {
    const t = eventTime(log);
    if (t == null) return;
    const ageMs = now - t;
    if (ageMs < 0 || ageMs >= windowMs) return; // outside the visible window
    // Oldest events land in bin 0, newest in the last bin.
    const idx = Math.min(bins - 1, Math.floor((windowMs - ageMs) / slotMs));
    const slot = slots[idx];
    slot.count += 1;
    const lvl = normalizeLevel(log.level);
    if (slot.level == null || (severityRank[lvl] ?? 0) > (severityRank[slot.level] ?? 0)) {
      slot.level = lvl;
    }
  });

  return slots;
}

// Relative-age buckets, newest first. Each event falls into the first bucket
// whose `maxAgeMs` it does not exceed; the final bucket is open-ended.
const BUCKET_DEFS = [
  { id: 'now', label: 'JUST NOW', maxAgeMs: 60 * 1000 },
  { id: 'recent', label: 'LAST 5 MIN', maxAgeMs: 5 * 60 * 1000 },
  { id: 'quarter', label: 'LAST 15 MIN', maxAgeMs: 15 * 60 * 1000 },
  { id: 'older', label: 'EARLIER', maxAgeMs: Infinity },
];

/**
 * Group recent events into relative-age buckets, newest event first within
 * each bucket. Empty buckets are dropped. Each event carries its normalized
 * level and ms-age so the renderer can show "2m ago" without re-parsing.
 *
 * @param {Array} logs - raw event log entries
 * @param {object} opts
 * @param {number} opts.now - reference "now" epoch ms (injectable for tests)
 * @param {number} [opts.max] - cap on total events considered (default 40)
 * @returns {Array<{id:string, label:string, events:Array}>}
 */
export function buildTimelineBuckets(logs, { now, max = MAX_TIMELINE_EVENTS } = {}) {
  const dated = (logs || [])
    .map(log => {
      const t = eventTime(log);
      if (t == null) return null;
      return {
        id: log._localId ?? `${log.timestamp}-${log.message || log.event || ''}`,
        ageMs: now - t,
        timestamp: t,
        level: normalizeLevel(log.level),
        message: log.message || log.event || '',
      };
    })
    .filter(e => e && e.ageMs >= 0)
    .sort((a, b) => b.timestamp - a.timestamp) // newest first
    .slice(0, max);

  const buckets = BUCKET_DEFS.map(def => ({ id: def.id, label: def.label, events: [] }));
  dated.forEach(event => {
    const idx = BUCKET_DEFS.findIndex(def => event.ageMs < def.maxAgeMs);
    buckets[idx === -1 ? buckets.length - 1 : idx].events.push(event);
  });

  return buckets.filter(b => b.events.length > 0);
}
