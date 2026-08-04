/**
 * Migration 224 — re-key CoS week ids onto the ISO week-numbering year (#3465).
 *
 * Background:
 *   `getWeekId()` used to pair the ISO week NUMBER with the CALENDAR year
 *   (`${date.getFullYear()}-W${isoWeek}`). Those two disagree at either end of
 *   the year, so a single ISO week could be filed under two ids (Mon
 *   2025-12-29 → `2025-W01`, Thu 2026-01-01 → `2026-W01`) and two different
 *   weeks could collide on one id (the week of 2025-01-01 is `2025-W01` too,
 *   so the late-December digest overwrote the early-January one on disk).
 *
 *   `server/lib/isoWeek.js` now keys on the ISO week-numbering year — the
 *   calendar year of that week's Thursday — so both boundary days above are
 *   `2026-W01` and no id is ever reused. Two on-disk stores encode the old ids
 *   and have to move with it:
 *
 *     - `data/cos/digests/<weekId>.json` — the id IS the filename, plus the
 *       stored `weekId` / `previousWeekId` fields. Left alone, every
 *       boundary-week digest is orphaned (the service looks it up under the new
 *       id, finds nothing, and regenerates over it).
 *     - `data/cos/productivity.json` — `streaks.lastActiveWeek`. Left alone, the
 *       next completed task sees a non-consecutive week and resets the user's
 *       weekly streak.
 *
 * How an old id is resolved:
 *   1. Prefer the record's own date — a digest's `weekStart`, or productivity's
 *      `streaks.lastActiveDate`. If re-deriving the OLD-form id from that date
 *      reproduces the stored id, the date is authoritative and the new id is
 *      simply `getWeekId(date)`. This is what resolves the collision case: the
 *      surviving digest keeps its content and is renamed to whichever week its
 *      `weekStart` actually covers.
 *   2. Otherwise fall back to arithmetic: a week number in 2..51 is nowhere near
 *      a year boundary, so the calendar year and the ISO week-numbering year
 *      agree for every day in it and the id is already correct.
 *   3. Anything else (`W01`, `W52`, `W53` with no usable date) is genuinely
 *      ambiguous — two real weeks map to it. Leave it untouched and log; a stale
 *      `lastActiveWeek` costs one reset streak, which is strictly better than
 *      guessing a digest onto the wrong week.
 *
 * Idempotent: after a run, every id round-trips through rule 1 or 2 to itself,
 * so a second pass writes nothing. Safe on an install with no digests dir and
 * no productivity file at all — both are runtime-generated (neither ships a
 * `data.reference/` seed), so a fresh install simply has nothing to do.
 */

import { readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { getIsoWeekNumber, getWeekId, parseWeekId } from '../../server/lib/isoWeek.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The pre-#3465 id shape: ISO week number stamped with the CALENDAR year. */
export function legacyWeekId(date) {
  return `${date.getFullYear()}-W${String(getIsoWeekNumber(date)).padStart(2, '0')}`;
}

/** Coerce a stored date hint (ISO string / YYYY-MM-DD / Date) to a valid Date, or null. */
export function toDateHint(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  // A bare YYYY-MM-DD parses as UTC midnight, which reads as the PREVIOUS local
  // day west of Greenwich — and the week id is a local-calendar-day concept.
  // Pin it to local noon so the day can't slip across a boundary either way.
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolve an old-form week id to its new form. Pure — exported for the test.
 *
 * @param {string} oldId stored `YYYY-Www`
 * @param {string|Date|null} dateHint a date known to fall in that week
 * @returns {string|null} the new id, or null when it cannot be resolved safely
 */
export function resolveNewWeekId(oldId, dateHint) {
  const parsed = parseWeekId(oldId);
  if (!parsed) return null;
  const date = toDateHint(dateHint);
  // Already in the new form (a re-run, or a record written after the fix) —
  // checked FIRST so a second pass reports "no change" instead of "ambiguous".
  if (date && getWeekId(date) === oldId) return oldId;
  if (date && legacyWeekId(date) === oldId) return getWeekId(date);
  if (parsed.week > 1 && parsed.week < 52) return oldId;
  return null;
}

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * Plan the digest rename set. Pure over already-read records — exported so the
 * test can assert the conflict rules without touching a filesystem.
 *
 * @param {Array<{ file: string, digest: object }>} records
 * @returns {{ writes: Array<{ file: string, digest: object }>, deletes: string[], skipped: string[] }}
 */
export function planDigestRewrite(records) {
  const claims = new Map(); // newFile -> candidate[]
  const skipped = [];

  for (const { file, digest } of records) {
    const oldId = file.replace(/\.json$/, '');
    const newId = resolveNewWeekId(oldId, digest?.weekStart);
    if (!newId) { skipped.push(file); continue; }
    const candidate = { file, digest, oldId, newId, newFile: `${newId}.json` };
    if (!claims.has(candidate.newFile)) claims.set(candidate.newFile, []);
    claims.get(candidate.newFile).push(candidate);
  }

  // Two digests resolving to one name would clobber each other. Distinct weeks
  // cannot collide under the new scheme, so this only fires on hand-edited or
  // duplicated records — keep the most recently generated one and leave the
  // others under their original names rather than deleting a real digest.
  const winners = [];
  for (const [, candidates] of claims) {
    if (candidates.length === 1) { winners.push(candidates[0]); continue; }
    const sorted = [...candidates].sort((a, b) => {
      // The record already sitting at the target name wins over a rename into it.
      const aStays = a.oldId === a.newId;
      const bStays = b.oldId === b.newId;
      if (aStays !== bStays) return aStays ? -1 : 1;
      const at = String(a.digest?.generatedAt ?? '');
      const bt = String(b.digest?.generatedAt ?? '');
      if (at !== bt) return at < bt ? 1 : -1; // newest generatedAt first
      return a.file < b.file ? -1 : 1;
    });
    winners.push(sorted[0]);
    for (const loser of sorted.slice(1)) skipped.push(loser.file);
  }

  const writes = [];
  for (const candidate of winners) {
    const { digest, oldId, newId, newFile } = candidate;
    const next = { ...digest, weekId: newId };
    if (typeof digest?.previousWeekId === 'string') {
      const prevStart = toDateHint(digest.weekStart);
      const resolvedPrev = prevStart
        ? getWeekId(new Date(prevStart.getTime() - WEEK_MS))
        : resolveNewWeekId(digest.previousWeekId, null);
      if (resolvedPrev) next.previousWeekId = resolvedPrev;
    }
    const changed = newId !== oldId
      || digest?.weekId !== next.weekId
      || digest?.previousWeekId !== next.previousWeekId;
    if (changed) writes.push({ file: newFile, digest: next });
  }

  // Every name that survives the pass — winners' new names plus whatever we
  // left alone. Anything else was a rename source and is now redundant.
  const kept = new Set([...winners.map(w => w.newFile), ...skipped]);
  const deletes = records.map(r => r.file).filter(f => !kept.has(f));

  return { writes, deletes, skipped };
}

async function migrateDigests(rootDir) {
  const dir = join(rootDir, 'data', 'cos', 'digests');
  const entries = await readdir(dir).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (entries == null) {
    console.log('📊 migration 224: no CoS digests directory — nothing to rename');
    return { renamed: 0, skipped: 0 };
  }

  // Read EVERY digest before writing anything: a rename target can be another
  // digest's current name, and reading up front means no pass ever reads a file
  // an earlier write already replaced.
  const records = [];
  for (const file of entries.filter(f => f.endsWith('.json')).sort()) {
    const digest = await readJsonOrNull(join(dir, file));
    if (digest && typeof digest === 'object' && !Array.isArray(digest)) records.push({ file, digest });
  }
  if (records.length === 0) {
    console.log('📊 migration 224: no readable digests — nothing to rename');
    return { renamed: 0, skipped: 0 };
  }

  const { writes, deletes, skipped } = planDigestRewrite(records);
  for (const { file, digest } of writes) await atomicWrite(join(dir, file), digest);
  for (const file of deletes) await unlink(join(dir, file)).catch(() => {});

  if (writes.length === 0) {
    console.log(`📊 migration 224: all ${records.length} digest(s) already use ISO week-numbering ids`);
  } else {
    console.log(`📊 migration 224: re-keyed ${writes.length} of ${records.length} digest(s) to ISO week-numbering ids`);
  }
  if (skipped.length > 0) {
    console.warn(`⚠️ migration 224: left ${skipped.length} digest(s) untouched — ambiguous week id with no usable weekStart`);
  }
  return { renamed: writes.length, skipped: skipped.length };
}

async function migrateProductivity(rootDir) {
  const file = join(rootDir, 'data', 'cos', 'productivity.json');
  const data = await readJsonOrNull(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.log('📊 migration 224: no productivity record — no weekly streak to re-key');
    return { changed: false };
  }

  const oldId = data.streaks?.lastActiveWeek;
  if (typeof oldId !== 'string' || oldId === '') return { changed: false };

  const newId = resolveNewWeekId(oldId, data.streaks?.lastActiveDate);
  if (!newId) {
    console.warn(`⚠️ migration 224: left streaks.lastActiveWeek "${oldId}" untouched — ambiguous week id with no usable lastActiveDate (costs at most one reset weekly streak)`);
    return { changed: false };
  }
  if (newId === oldId) return { changed: false };

  data.streaks.lastActiveWeek = newId;
  await atomicWrite(file, data);
  console.log(`📊 migration 224: re-keyed streaks.lastActiveWeek ${oldId} → ${newId}`);
  return { changed: true };
}

export default {
  async up({ rootDir }) {
    const digests = await migrateDigests(rootDir);
    const productivity = await migrateProductivity(rootDir);
    return { ok: true, ...digests, lastActiveWeekChanged: productivity.changed };
  },
};
