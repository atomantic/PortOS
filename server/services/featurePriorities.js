/**
 * Feature priority resolver: learns per-area usage from focused page visits, stores pins in settings and resolves a P0-P3 tier per feature area.
 *
 * Usage signal: the client reports a visit after 10 focused, visible seconds on a route (`useFeatureUsageBeacon`); the route maps to an area through `areaForNavPath`, and a visit is one upsert on `(area_id, day)`.
 * No API traffic is counted, no LLM is called and nothing runs at boot. Pins live at `settings.featurePriorities.overrides[areaId]`; an absent key means auto.
 *
 * Storage: `db-primary` (`feature_usage_days`), machine-local and never federated, the same class and rationale as `user_action_events` (services/userActions.js). A daily upsert needs no in-memory buckets, timers or shutdown flush;
 * retention (90 days) is enforced inline after each visit. Guarded in sharing/peerSync.test.js. Usage counts and dates are for this install's tier resolution only: they never enter a log line, a prompt, a federation payload or `.quality.json`.
 *
 * Days are the server's LOCAL calendar day. The pure scoring in `lib/featurePriorityScoring.js` ages days against UTC midnights, so the clock handed to it is shifted by the zone offset to make "today" the same date on both sides.
 *
 * PostgreSQL is authoritative; the file backend exists only for the dev/test escape hatch (`NODE_ENV=test` / `MEMORY_BACKEND=file`), built on `createPgFileFacade` so route suites run without a database.
 */

import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { FEATURE_AREAS, areaForNavPath, getFeatureArea, isOptionalFeatureArea } from '../lib/featureAreas.js';
import {
  ACTIVITY_WINDOW_DAYS,
  DORMANT_AFTER_DAYS,
  FEATURE_PRIORITY_TIERS,
  MIN_EVIDENCE_DAYS,
  lastActiveAgeDays,
  learnedTier,
  resolveTier,
  scoreActiveDays,
} from '../lib/featurePriorityScoring.js';
import { isPlainObject } from '../lib/objects.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../lib/pgFileFacade.js';
import { detectFeatureConfiguration, resolveInstanceFeatures } from './instanceFeatures.js';
import { getSettingsWithStatus, updateSettingsWith } from './settings.js';
import { incrementFeatureVisit, listFeatureUsageDays, pruneFeatureUsage } from './featureUsageDb.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows older than this many days are deleted inline after each visit. */
export const FEATURE_USAGE_RETENTION_DAYS = ACTIVITY_WINDOW_DAYS;

// `YYYY-MM-DD` of the server's local calendar day at `now` (ms).
const localDay = (now) => new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

// The same instant shifted so its UTC date is the local date, which is what the UTC-based scoring expects `now` to mean.
const localClock = (now) => now - new Date(now).getTimezoneOffset() * 60_000;

const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// File backend — dev/test escape hatch only.
// ---------------------------------------------------------------------------

const usageFile = () => join(PATHS.data, 'feature-usage-days.json');
const queueWrite = createFileWriteQueue();

async function loadFileRows() {
  const raw = await readJSONFile(usageFile(), { rows: [] }, { allowArray: false, strict: true });
  return Array.isArray(raw?.rows) ? raw.rows : [];
}

function makeFileBackend() {
  return {
    name: 'file',
    recordVisit: (areaId, day, cutoffDay) => queueWrite(async () => {
      const rows = (await loadFileRows()).filter((row) => row.day >= cutoffDay);
      const existing = rows.find((row) => row.areaId === areaId && row.day === day);
      if (existing) existing.visits += 1;
      else rows.push({ areaId, day, visits: 1 });
      await ensureDir(PATHS.data);
      await atomicWrite(usageFile(), { rows });
    }),
    listDays: async (sinceDay) => (await loadFileRows()).filter((row) => row.day >= sinceDay),
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    recordVisit: async (areaId, day, cutoffDay) => {
      await incrementFeatureVisit(db, areaId, day);
      await pruneFeatureUsage(db, cutoffDay);
    },
    listDays: (sinceDay) => listFeatureUsageDays(db, sinceDay),
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: `Feature usage tracking requires PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});

// ---------------------------------------------------------------------------
// Visits.
// ---------------------------------------------------------------------------

/**
 * Count one focused visit to the feature area that owns `path`. A path no area owns (the dashboard, an unknown route) is a no-op.
 * @returns {Promise<{ recorded: boolean }>}
 */
export async function recordVisit(path, { now = Date.now() } = {}) {
  const entry = areaForNavPath(path);
  if (!entry) return { recorded: false };
  const today = localDay(now);
  const backend = await facade.getBackend();
  await backend.recordVisit(entry.id, today, shiftDay(today, -FEATURE_USAGE_RETENTION_DAYS));
  return { recorded: true };
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

// Only a known area carrying a known tier is a pin; anything else in a hand-edited settings file reads as "auto".
const readPins = (settings) => {
  const overrides = settings?.featurePriorities?.overrides;
  if (!isPlainObject(overrides)) return {};
  return Object.fromEntries(Object.entries(overrides)
    .filter(([areaId, tier]) => getFeatureArea(areaId) && FEATURE_PRIORITY_TIERS.includes(tier)));
};

/**
 * Pure resolver: usage rows, pins and instance-feature state in, one resolved entry per area out.
 *
 * `enabledByFeature` maps an instance feature id to its enabled flag; omit it (or an id) when the state is unknown, and the feature-off rule does not fire.
 * `now` is the shifted local clock from `localClock`.
 * @returns {{ areas: object[], evidenceDays: number, minEvidenceDays: number }}
 */
export function buildFeaturePriorities({ usageRows = [], pins = {}, enabledByFeature = {}, now }) {
  const inWindow = usageRows.filter((row) => lastActiveAgeDays([row.day], now) !== null);
  const daysByArea = new Map();
  for (const row of inWindow) {
    if (!(row.visits > 0)) continue;
    if (!daysByArea.has(row.areaId)) daysByArea.set(row.areaId, new Set());
    daysByArea.get(row.areaId).add(row.day);
  }
  // The evidence gate counts distinct days the install was used at all, not per area, so one busy area cannot starve another's learning.
  const evidenceDays = new Set([...daysByArea.values()].flatMap((days) => [...days])).size;

  const areas = FEATURE_AREAS.map((entry) => {
    const days = [...(daysByArea.get(entry.id) ?? [])].sort();
    const lastActive = lastActiveAgeDays(days, now);
    const optional = isOptionalFeatureArea(entry);
    const featureEnabled = optional ? enabledByFeature[entry.instanceFeatureId] : undefined;
    const learned = learnedTier({ score: scoreActiveDays(days, now), lastActiveAgeDays: lastActive, optional, evidenceDays });
    const { tier, source } = resolveTier({ pinned: pins[entry.id], featureEnabled, lastActiveAgeDays: lastActive, learned });
    return {
      areaId: entry.id,
      label: entry.label,
      instanceFeatureId: entry.instanceFeatureId ?? null,
      tier,
      source,
      activeDays30: days.filter((day) => lastActiveAgeDays([day], now) < DORMANT_AFTER_DAYS).length,
      lastActiveDay: days.at(-1) ?? null,
    };
  });
  return { areas, evidenceDays, minEvidenceDays: MIN_EVIDENCE_DAYS };
}

/**
 * Resolve every feature area's tier: pin, then feature-off, then learned usage, then P1.
 *
 * Corrupt settings read as "unknown": no pins, and no feature-off demotion, because a settings file that cannot be read says nothing about which features the operator turned off.
 */
export async function getFeaturePriorities({ now = Date.now() } = {}) {
  const backend = await facade.getBackend();
  const today = localDay(now);
  const [usageRows, { corrupt, settings }, detected] = await Promise.all([
    backend.listDays(shiftDay(today, -(ACTIVITY_WINDOW_DAYS - 1))),
    getSettingsWithStatus(),
    detectFeatureConfiguration(),
  ]);
  const enabledByFeature = corrupt
    ? {}
    : Object.fromEntries(resolveInstanceFeatures(settings, { detected }).map((feature) => [feature.id, feature.enabled]));
  return buildFeaturePriorities({
    usageRows,
    pins: corrupt ? {} : readPins(settings),
    enabledByFeature,
    now: localClock(now),
  });
}

/**
 * Set (`tier` P0-P3) or clear (`tier` null) one area's pin. Clearing drops the key, so the stored shape never carries a "none" sentinel.
 * @returns {Promise<{ areaId: string, tier: string|null }>}
 */
export async function setFeaturePriorityPin(areaId, tier) {
  if (!getFeatureArea(areaId)) {
    throw new ServerError(`Unknown feature area: ${areaId}`, { status: 404, code: 'NOT_FOUND' });
  }
  await updateSettingsWith((current) => {
    const featurePriorities = isPlainObject(current.featurePriorities) ? current.featurePriorities : {};
    const { [areaId]: _previous, ...overrides } = isPlainObject(featurePriorities.overrides) ? featurePriorities.overrides : {};
    return {
      ...current,
      featurePriorities: { ...featurePriorities, overrides: tier === null ? overrides : { ...overrides, [areaId]: tier } },
    };
  }, { actor: 'user' });
  return { areaId, tier };
}
