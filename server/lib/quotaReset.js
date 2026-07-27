/**
 * Normalize the reset times emitted by the provider quota adapters. A missing
 * or ambiguous reset is deliberately represented as null: a scheduled quota
 * burn must park rather than guess that a provider is about to reset.
 */

const HOUR_MS = 60 * 60 * 1000;

function hasExplicitZone(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function zoneOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (!match) return null;
  return (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000 * (match[1] === '+' ? 1 : -1);
}

function parseInZone(value, timeZone) {
  const parsed = Date.parse(`${value} UTC`);
  if (!Number.isFinite(parsed)) return null;
  const offset = zoneOffsetMs(parsed, timeZone);
  return offset === null ? null : parsed - offset;
}

/**
 * @returns {{ epochMs: number|null, source: 'iso'|'parsed'|'unknown' }}
 */
export function normalizeResetAt(limit, { now = Date.now(), timeZone } = {}) {
  const value = typeof limit?.resetsAt === 'string' ? limit.resetsAt.trim() : '';
  if (!value) return { epochMs: null, source: 'unknown' };

  if (hasExplicitZone(value)) {
    const epochMs = Date.parse(value);
    return Number.isFinite(epochMs) ? { epochMs, source: 'iso' } : { epochMs: null, source: 'unknown' };
  }

  const zone = limit?.timezone || timeZone;
  let epochMs = zone ? parseInZone(value, zone) : Date.parse(value);
  if (!Number.isFinite(epochMs)) return { epochMs: null, source: 'unknown' };

  // Grok omits a year. Treat an already-passed date as the next occurrence,
  // avoiding the accidental "reset now" interpretation at year boundaries.
  if (!/\b\d{4}\b/.test(value) && epochMs < now - HOUR_MS) {
    const date = new Date(epochMs);
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    epochMs = date.getTime();
  }
  return { epochMs, source: 'parsed' };
}

export function hoursUntilReset(limit, opts = {}) {
  const { epochMs } = normalizeResetAt(limit, opts);
  return epochMs === null ? null : (epochMs - (opts.now ?? Date.now())) / HOUR_MS;
}
