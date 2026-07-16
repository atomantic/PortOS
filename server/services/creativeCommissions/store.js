/**
 * Creative Commission store + service (#2657, Phase 1 — Autonomous Creation Engine).
 *
 * A CreativeCommission is a standing, recurring creative brief that fires on a
 * schedule and drives the Creative Director's directive pipeline unattended.
 *
 * Storage: a `createCollectionStore` collection at `data/creative-commissions/`,
 * one record per commission. Commissions are MACHINE-LOCAL and NOT federated in
 * Phase 1 — the same rationale as `seriesAutopilotScheduler`'s settings-based
 * schedules: a schedule that federated across sync peers would double-run on
 * every machine. Federation (with a per-peer "home" gate) is Phase 2 work.
 *
 * The record shape is stable/forward-looking: `feedback[]` + `feedbackWindow`
 * exist now (Phase 1 leaves feedback empty) so Phase 2 only needs the rate
 * surface, not a schema change.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { isValidCron } from '../eventScheduler.js';
import { commissionToCron } from './directive.js';

export const TYPE = 'creative-commissions';
export const COMMISSIONS_SCHEMA_VERSION = 1;
export const MAX_PERSISTED_RUNS = 50;

// Service-layer error codes (mapped to HTTP status by the route via
// createServiceErrorMapper), mirroring the universeBuilder convention.
export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const makeErr = (message, code) => Object.assign(new Error(message), { code });

const isStr = (v) => typeof v === 'string';

/**
 * Normalize a raw record into the canonical stored shape. Returns null for a
 * non-object / id-less record (collectionStore drops nulls), so a malformed
 * on-disk file can't surface. Passed to every `loadOne`.
 */
export function sanitizeCommission(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const now = new Date().toISOString();
  const brief = raw.brief && typeof raw.brief === 'object' ? raw.brief : {};
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  const generation = raw.generation && typeof raw.generation === 'object' ? raw.generation : {};
  return {
    id: raw.id,
    name: isStr(raw.name) ? raw.name : 'Untitled Commission',
    enabled: raw.enabled !== false,
    targetAbility: isStr(raw.targetAbility) ? raw.targetAbility : 'video',
    brief: {
      intent: isStr(brief.intent) ? brief.intent : '',
      genre: isStr(brief.genre) ? brief.genre : null,
      category: isStr(brief.category) ? brief.category : null,
      styleSpec: isStr(brief.styleSpec) ? brief.styleSpec : '',
      constraints: brief.constraints && typeof brief.constraints === 'object' ? brief.constraints : {},
      seedRefs: Array.isArray(brief.seedRefs) ? brief.seedRefs : [],
    },
    schedule: {
      kind: isStr(schedule.kind) ? schedule.kind : 'DAILY',
      atLocalTime: isStr(schedule.atLocalTime) ? schedule.atLocalTime : null,
      weekday: Number.isInteger(schedule.weekday) ? schedule.weekday : null,
      weekdaysOnly: schedule.weekdaysOnly === true,
      cron: isStr(schedule.cron) ? schedule.cron : null,
      timezone: isStr(schedule.timezone) ? schedule.timezone : null,
    },
    generation: {
      model: isStr(generation.model) ? generation.model : null,
      quality: isStr(generation.quality) ? generation.quality : 'standard',
      aspectRatio: isStr(generation.aspectRatio) ? generation.aspectRatio : '16:9',
      targetDurationSeconds: Number.isInteger(generation.targetDurationSeconds) ? generation.targetDurationSeconds : 10,
    },
    // Phase 2 populates these; kept stable now.
    feedback: Array.isArray(raw.feedback) ? raw.feedback : [],
    feedbackWindow: Number.isInteger(raw.feedbackWindow) ? raw.feedbackWindow : 5,
    runs: Array.isArray(raw.runs) ? raw.runs.slice(-MAX_PERSISTED_RUNS) : [],
    createdAt: isStr(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : (isStr(raw.createdAt) ? raw.createdAt : now),
  };
}

let _store = null;
/** Lazily construct the singleton commission store (avoids touching PATHS at import). */
export function commissionStore() {
  if (!_store) {
    _store = createCollectionStore({
      dir: join(PATHS.data, TYPE),
      type: TYPE,
      schemaVersion: COMMISSIONS_SCHEMA_VERSION,
      sanitizeRecord: sanitizeCommission,
    });
  }
  return _store;
}

// `saveOne` writes only the per-record file, never the type-level index.json
// (which stamps schemaVersion). Stamp it once per process on first write so the
// boot verifier reports the real version and a future bump can detect v1 data.
const _stamped = new WeakSet();
async function ensureTypeIndex(store) {
  if (_stamped.has(store)) return;
  _stamped.add(store);
  await store.saveTypeIndex({}).catch(() => { _stamped.delete(store); });
}

/**
 * Assert a schedule composes into a cron the scheduler will honor. Throws
 * ERR_VALIDATION otherwise (surfaced as HTTP 400). Kept here — not in the Zod
 * schema — so validation.js stays a leaf free of the eventScheduler import.
 */
export function assertValidSchedule(schedule) {
  const cron = commissionToCron(schedule);
  if (!cron || !isValidCron(cron)) {
    throw makeErr('Invalid schedule: could not derive a valid cron expression', ERR_VALIDATION);
  }
  return cron;
}

export async function listCommissions() {
  return commissionStore().loadAll();
}

export async function getCommission(id) {
  const rec = await commissionStore().loadOne(id);
  if (!rec) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  return rec;
}

export async function createCommission(input) {
  assertValidSchedule(input.schedule);
  const store = commissionStore();
  const now = new Date().toISOString();
  const id = `commission-${randomUUID()}`;
  const record = sanitizeCommission({ ...input, id, createdAt: now, updatedAt: now, runs: [], feedback: [] });
  await ensureTypeIndex(store);
  await store.saveOne(id, record);
  return record;
}

export async function updateCommission(id, patch) {
  const store = commissionStore();
  const current = await store.loadOne(id);
  if (!current) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  const nextSchedule = patch.schedule ?? current.schedule;
  if (patch.schedule) assertValidSchedule(nextSchedule);
  const merged = sanitizeCommission({
    ...current,
    ...patch,
    // Deep-merge the nested objects so a partial brief/generation patch doesn't
    // wipe unspecified fields.
    brief: patch.brief ? { ...current.brief, ...patch.brief } : current.brief,
    schedule: patch.schedule ? { ...current.schedule, ...patch.schedule } : current.schedule,
    generation: patch.generation ? { ...current.generation, ...patch.generation } : current.generation,
    id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  });
  await store.saveOne(id, merged);
  return merged;
}

export async function deleteCommission(id) {
  const store = commissionStore();
  const current = await store.loadOne(id);
  if (!current) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  await store.deleteOne(id);
  return { id, deleted: true };
}

/**
 * Append a run entry to a commission (fire history). Runs are capped to the last
 * MAX_PERSISTED_RUNS. Serialized per-id by the collectionStore write queue.
 * Best-effort: called from the scheduler's fire handler (outside the request
 * lifecycle) — the caller wraps errors.
 */
export async function recordCommissionRun(id, runEntry) {
  const store = commissionStore();
  return store.queueRecordWrite(id, async () => {
    const current = await store.loadOne(id);
    if (!current) return null;
    const run = {
      id: runEntry.id || `run-${randomUUID()}`,
      ranAt: runEntry.ranAt || new Date().toISOString(),
      status: runEntry.status || 'started',
      projectId: runEntry.projectId || null,
      promptUsed: isStr(runEntry.promptUsed) ? runEntry.promptUsed : null,
      reason: isStr(runEntry.reason) ? runEntry.reason : null,
      error: isStr(runEntry.error) ? runEntry.error : null,
    };
    const runs = [...(current.runs || []), run].slice(-MAX_PERSISTED_RUNS);
    await store.saveOneNow(id, { ...current, runs, updatedAt: new Date().toISOString() });
    return run;
  });
}
