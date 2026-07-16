/**
 * Normalize existing POST session & training-log day-strings to the user's local
 * timezone (issue #2681).
 *
 * Background:
 *   `completedToday`/`todayScore` and the POST streaks used to derive "today"
 *   from the server's UTC day (the process runs `TZ=UTC`), and both the scored-
 *   session writer (`submitPostSession`) and the training writer
 *   (`submitTrainingEntry`) stamped each record's `date` with that same UTC day.
 *   Issue #2681 moves BOTH the read side (today derivation) and the write side
 *   (new records) onto the user's *local* day.
 *
 *   That leaves already-stored records dated by the OLD (UTC) day while readers
 *   now interpret every `date` as a local day. For a non-UTC user, a session or
 *   practice completed in the local evening was stamped on the *next* UTC day, so
 *   read as a local day it lands one day late — mislabeling streak history and
 *   even colliding with a genuinely-next-day record. This migration re-derives
 *   each stored `date` from the record's own UTC timestamp (`completedAt` /
 *   `startedAt` for sessions, `timestamp` for training entries — falling back to
 *   a full-ISO `date` when present) in the user's configured timezone, so all
 *   history uses the same local-day semantics the new writers do.
 *
 *   No-op by construction for installs where the local day already equals the UTC
 *   day: an unconfigured timezone resolves to the process tz (UTC under `TZ=UTC`),
 *   and an explicitly-`UTC` setting short-circuits — so nothing is rewritten and
 *   the common case can't be corrupted. Records with no recoverable instant
 *   (a bare date-only string and no timestamp) are left untouched.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const SESSIONS_REL = 'data/meatspace/post-sessions.json';
const TRAINING_REL = 'data/meatspace/post-training-log.json';
const SETTINGS_REL = 'data/settings.json';

// Resolve the install's configured timezone the same way the runtime does:
// a valid `settings.timezone`, else the process timezone (UTC under `TZ=UTC`),
// so an unconfigured install is a guaranteed no-op.
async function resolveTimezone(rootDir) {
  const raw = await readFile(join(rootDir, SETTINGS_REL), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  let tz = null;
  if (raw != null) {
    try {
      tz = JSON.parse(raw)?.timezone ?? null;
    } catch {
      tz = null;
    }
  }
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return tz;
    } catch {
      // Invalid configured tz — fall through to the guaranteed fallback below.
    }
  }
  // Fall back to UTC, NOT the host's system timezone. The runtime server always
  // runs under `TZ=UTC` (ecosystem.config.cjs), so getUserTimezone()'s own
  // fallback for an unconfigured install resolves to UTC — and this migration
  // must match it. `npm run update` can execute this migration OUTSIDE PM2 (where
  // the host tz would otherwise leak in via Intl's system default) and then
  // restart under TZ=UTC; keying off the host tz here would permanently rewrite
  // UTC-dated history that the UTC runtime then reads as local (issue #2681 r3).
  return 'UTC';
}

// `YYYY-MM-DD` for a UTC instant, evaluated in `timezone`. `en-CA` formats
// dates as ISO `YYYY-MM-DD`, matching the runtime `todayInTimezone` output.
function localDayFor(instant, timezone) {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Pick the UTC instant that best represents the session's ORIGINAL day. Prefer
// `startedAt`: an idempotent re-submit (submitPostSession) deliberately preserves
// the original `startedAt` (and `date`) but OVERWRITES `completedAt` — so a retry
// that crosses local midnight would, via `completedAt`, redate the session to the
// retry day and undo that invariant. `startedAt` keeps it on the day it began.
// A full-ISO `date` (contains 'T') is only a fallback for pre-timestamp records.
function sessionInstant(s) {
  if (typeof s?.startedAt === 'string' && s.startedAt.includes('T')) return s.startedAt;
  if (typeof s?.completedAt === 'string' && s.completedAt.includes('T')) return s.completedAt;
  if (typeof s?.date === 'string' && s.date.includes('T')) return s.date;
  return null;
}

// Training entries carry `timestamp` (full UTC ISO); memory-practice entries
// historically stored a full ISO in `date` itself.
function trainingInstant(e) {
  if (typeof e?.timestamp === 'string' && e.timestamp.includes('T')) return e.timestamp;
  if (typeof e?.date === 'string' && e.date.includes('T')) return e.date;
  return null;
}

async function normalizeFile(path, arrayKey, instantOf, timezone) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return { updated: 0, reason: 'no-file' };

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.log(`⚠️ ${path}: invalid JSON, skipping (${err.message})`);
    return { updated: 0, reason: 'invalid-json' };
  }

  const records = Array.isArray(data?.[arrayKey]) ? data[arrayKey] : null;
  if (!records) return { updated: 0, reason: 'no-records' };

  let updated = 0;
  for (const rec of records) {
    const instant = instantOf(rec);
    if (!instant) continue; // no recoverable time — leave the stored date as-is
    const localDay = localDayFor(instant, timezone);
    if (localDay && rec.date !== localDay) {
      // Preserve the exact instant before overwriting `date` with the day key.
      // A legacy memory-practice entry's ONLY instant is the full ISO in `date`
      // (the old writer added no `timestamp`); replacing it with a bare day would
      // irreversibly discard that time. Stash it in `timestamp` when the record
      // carries no other instant field (issue #2681 r4).
      if (!rec.timestamp && !rec.startedAt && !rec.completedAt) {
        rec.timestamp = instant;
      }
      rec.date = localDay;
      updated += 1;
    }
  }

  if (updated > 0) {
    // Re-sort by the normalized day so ordering matches the writers' invariant.
    records.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  return { updated };
}

export default {
  async up({ rootDir }) {
    const timezone = await resolveTimezone(rootDir);
    // If local day == UTC day for this install, every re-derivation is a no-op —
    // skip the file rewrites entirely so a UTC install is never touched.
    if (timezone === 'UTC' || timezone === 'Etc/UTC') {
      console.log('🕓 POST dates: timezone resolves to UTC — no local-day normalization needed');
      return { updated: 0, reason: 'utc-timezone' };
    }

    const sessions = await normalizeFile(
      join(rootDir, SESSIONS_REL), 'sessions', sessionInstant, timezone,
    );
    const training = await normalizeFile(
      join(rootDir, TRAINING_REL), 'entries', trainingInstant, timezone,
    );

    const total = sessions.updated + training.updated;
    if (total > 0) {
      console.log(`📝 POST dates: normalized ${sessions.updated} session(s) + ${training.updated} training entr${training.updated === 1 ? 'y' : 'ies'} to ${timezone} local days`);
    } else {
      console.log(`✅ POST dates: already local-day consistent for ${timezone} — no changes`);
    }
    return { updated: total, timezone };
  },
};
