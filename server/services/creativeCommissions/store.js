/**
 * Creative Commission store + service (#2657, Phase 1 — Autonomous Creation Engine).
 *
 * A CreativeCommission is a standing, recurring creative brief that fires on a
 * schedule and drives the Creative Director's directive pipeline unattended.
 *
 * Storage: `db-primary` (docs/STORAGE.md). Real installs store one row per
 * commission in the `creative_commissions` PostgreSQL table (the full sanitized
 * record in `data` JSONB — see ./db.js). A file backend (collectionStore at
 * `data/creative-commissions/`) is retained ONLY as the dev/test escape hatch
 * (`MEMORY_BACKEND=file` or `NODE_ENV=test`), exactly like universeBuilder — so
 * the unit tests keep exercising a real store without a database. This facade
 * owns the sanitizer + merge semantics uniformly (applied on the service side,
 * not inside a backend) so the two backends can't drift, serializes the
 * scheduler-vs-request read-modify-write on a shared per-id write queue
 * (`createRecordWriteQueue`, identical to universeBuilder), and delegates only
 * plain leaf I/O to the selected backend.
 *
 * The COMMISSION stays MACHINE-LOCAL and NOT federated — the same rationale as
 * `seriesAutopilotScheduler`'s settings-based schedules: a schedule that
 * federated across sync peers would double-run on every machine. The DB row
 * carries no sync cursor/tombstone (deletes are hard deletes, mirroring tribe).
 *
 * FEEDBACK, by contrast, IS federated as of #2686 (split-record federation): the
 * taste reactions live in their own `commissionFeedback` record kind (see
 * ./feedbackStore.js) so a 👍/👎 rated on machine A conditions the SAME
 * commission's next run on machine B, while the `schedule` (+ future home-peer
 * pointer) stays local. The commission's `feedback[]` field is now a READ-THROUGH
 * VIEW hydrated from the federated store on read (listCommissions/getCommission);
 * `submitCommissionFeedback` writes the federated store, not this row. Legacy
 * inline reactions (Phase 2 storage) are split into the federated store lazily on
 * read and by `backfillAllCommissionFeedback()` at boot. `feedbackWindow` stays
 * on the machine-local record (a per-machine directive-tuning knob).
 *
 * Mutations emit `commission:changed` on `commissionEvents` so the scheduler
 * re-arms crons off the DATA changing (any writer), not off the three REST
 * handlers that happen to change it today — mirroring seriesAutopilot's
 * `settings:updated` seam and keeping the HTTP route decoupled from the
 * scheduler graph.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend } from '../../lib/pgFileFacade.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { isValidCron } from '../eventScheduler.js';
import { commissionToCron } from './directive.js';
import {
  recordFeedback,
  listFeedbackForCommission,
  listFeedbackByCommissionIds,
  backfillInlineFeedback,
} from './feedbackStore.js';

// Emits `commission:changed` on any create/update/delete (not on run-record
// appends, which don't affect scheduling). The scheduler subscribes to re-sync.
export const commissionEvents = new EventEmitter();

export const TYPE = 'creative-commissions';
export const COMMISSIONS_SCHEMA_VERSION = 1;
export const MAX_PERSISTED_RUNS = 50;
// Feedback is kept inline on the commission record (not a separate federated
// store) — Phase 1's store shape reserved `feedback[]` precisely so Phase 2 adds
// the rate surface without a schema change. Capped like runs so a long-lived
// nightly commission can't grow the row unbounded; the directive builder only
// ever reads the last `feedbackWindow` reactions anyway.
export const MAX_PERSISTED_FEEDBACK = 100;

// Service-layer error codes (mapped to HTTP status by the route via
// createServiceErrorMapper), mirroring the universeBuilder convention.
export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const makeErr = (message, code) => Object.assign(new Error(message), { code });

const isStr = (v) => typeof v === 'string';

/**
 * Normalize a single feedback reaction (#2657, Phase 2). A reaction MUST carry a
 * meaningful rating — 'up'/'down' or a non-zero number (numeric ratings are
 * preserved verbatim so `renderFeedbackDigest`'s >0/<0 test still works). Returns
 * null for anything without a usable rating so a malformed/id-less entry can't
 * pollute the digest. Applied inside `sanitizeCommission` on every read/write, so
 * both backends return an identical, already-sanitized `feedback[]`.
 */
export function sanitizeFeedbackEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const isUp = raw.rating === 'up' || (typeof raw.rating === 'number' && raw.rating > 0);
  const isDown = raw.rating === 'down' || (typeof raw.rating === 'number' && raw.rating < 0);
  if (!isUp && !isDown) return null;
  const rating = typeof raw.rating === 'number' ? raw.rating : (isUp ? 'up' : 'down');
  return {
    id: isStr(raw.id) && raw.id ? raw.id : `feedback-${randomUUID()}`,
    runId: isStr(raw.runId) ? raw.runId : null,
    rating,
    note: isStr(raw.note) ? raw.note : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isStr).slice(0, 20) : [],
    at: isStr(raw.at) ? raw.at : new Date().toISOString(),
  };
}

/**
 * Normalize a raw record into the canonical stored shape. Returns null for a
 * non-object / id-less record (so a malformed on-disk / on-row record can't
 * surface). Applied by the service on every read and before every write, so both
 * backends return an identical shape.
 */
export function sanitizeCommission(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const now = new Date().toISOString();
  const brief = raw.brief && typeof raw.brief === 'object' ? raw.brief : {};
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  const generation = raw.generation && typeof raw.generation === 'object' ? raw.generation : {};
  const assignment = raw.assignment && typeof raw.assignment === 'object' && !Array.isArray(raw.assignment)
    ? raw.assignment : {};
  // The LLM pin that processes the commission (CD treatment + plan stages). A
  // model without a provider can't be resolved (the runtime keys on the provider
  // first), so a provider-less pin drops the model too — matching
  // normalizeModelOverrides so a stored assignment can't carry a dangling model.
  const assignmentProviderId = isStr(assignment.providerId) && assignment.providerId.trim()
    ? assignment.providerId.trim() : null;
  const assignmentModel = assignmentProviderId && isStr(assignment.model) && assignment.model.trim()
    ? assignment.model.trim() : null;
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
    // Which AI provider/model processes this commission's CD cognitive stages.
    // `providerId: null` = inherit the install's default AI Assignment.
    assignment: {
      providerId: assignmentProviderId,
      model: assignmentModel,
    },
    // Phase 2: deep-sanitize each reaction (drop ratingless/malformed entries)
    // and cap history. Phase 1 records carry an empty array, so this is a no-op
    // for them and preserves stored, already-id'd feedback idempotently.
    feedback: Array.isArray(raw.feedback)
      ? raw.feedback.map(sanitizeFeedbackEntry).filter(Boolean).slice(-MAX_PERSISTED_FEEDBACK)
      : [],
    feedbackWindow: Number.isInteger(raw.feedbackWindow) ? raw.feedbackWindow : 5,
    runs: Array.isArray(raw.runs) ? raw.runs.slice(-MAX_PERSISTED_RUNS) : [],
    createdAt: isStr(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : (isStr(raw.createdAt) ? raw.createdAt : now),
  };
}

// --- File backend (dev/test escape hatch): wraps collectionStore ---
// No sanitizer on the collectionStore — the facade sanitizes uniformly on the
// service side so file and PG return an identical shape. The type-level index is
// stamped on the first write so the boot verifier reports the real version.
function makeFileBackend(dir) {
  const cs = createCollectionStore({
    dir,
    type: TYPE,
    schemaVersion: COMMISSIONS_SCHEMA_VERSION,
  });
  let stamped = false;
  const ensureTypeIndex = async () => {
    if (stamped) return;
    stamped = true;
    await cs.saveTypeIndex({}).catch(() => { stamped = false; });
  };
  return {
    name: 'file',
    listRaw: () => cs.loadAll(),
    readRaw: (id) => cs.loadOne(id),
    writeRaw: async (id, record) => { await ensureTypeIndex(); await cs.saveOneNow(id, record); return record; },
    deleteRaw: (id) => cs.deleteOneNow(id),
    verify: () => cs.verifySchemaVersion(),
  };
}

// --- PostgreSQL backend: pure leaf I/O from ./db.js ---
// No `verify` — the facade's verifySchemaVersion short-circuits the PG case
// without touching the backend (see below), so PG has no type-index to check.
function makePgBackend(db) {
  return {
    name: 'postgres',
    listRaw: db.listRaw,
    readRaw: db.readRaw,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
  };
}

// Self-sufficient PG bring-up: the boot DB gate fail-fasts a required-but-missing
// DB, but an early scheduler warm can call in BEFORE that gate's ensureSchema()
// runs — so resolvePgBackend health-checks + brings the (idempotent) schema up.
// No file→DB migration: commissions are a brand-new record kind that never
// shipped on the file backend.
const pgBackend = () => resolvePgBackend({
  requirement: 'Creative Commissions require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  loadDb: () => import('./db.js'),
  makePg: makePgBackend,
});

// --- Facade: memoized backend selection + per-id write queue + verify ---
// Keyed by data dir so a test harness that swaps PATHS.data per-test still sees
// the right root. commissionStore() is the accessor the boot verifier calls.
// The facade owns the scheduler-vs-request serialization via a shared per-id
// write queue (identical to universeBuilder/storyBuilder) rather than a backend
// row lock — commissions are machine-local and written only by the single main
// server process (the scheduler fire + the REST route), so in-process per-id
// serialization is sufficient and keeps both backends serializing identically.
let _facade = null;
let _facadeDir = null;

function createFacade(dir) {
  const { getBackend, getBackendName } = createPgFileFacade({
    makeFile: () => makeFileBackend(dir),
    makePg: () => pgBackend(),
  });
  // Tail-chained per id: two RMW cycles on the SAME id serialize while different
  // ids fan out. Backend-agnostic, so file and PG serialize the same way.
  const queueRecordWrite = createRecordWriteQueue();
  return {
    dir,
    type: TYPE,
    getBackendName,
    listRaw: async () => (await getBackend()).listRaw(),
    readRaw: async (id) => (await getBackend()).readRaw(id),
    writeRaw: async (id, record) => (await getBackend()).writeRaw(id, record),
    deleteRaw: async (id) => (await getBackend()).deleteRaw(id),
    queueRecordWrite,
    // Under PG, report ok WITHOUT forcing backend selection (the early boot
    // verifier runs before the dbReady gate); under the file escape hatch, read
    // the on-disk type index. The env check matches the selection predicate.
    verifySchemaVersion: async () => {
      if (!isFileBackend()) {
        return { ok: true, type: TYPE, onDisk: null, expected: null,
          message: `collection "${TYPE}" @ postgres (#2657)` };
      }
      return (await getBackend()).verify();
    },
  };
}

/** Get the memoized commission store facade (the boot verifier calls this). */
export function commissionStore() {
  const dir = join(PATHS.data, TYPE);
  if (_facade && _facadeDir === dir) return _facade;
  _facade = createFacade(dir);
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only. */
export function _resetCommissionStore() {
  _facade = null;
  _facadeDir = null;
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

/**
 * Persist `feedback: []` on the machine-local commission after its legacy inline
 * reactions have been split into the federated store — WITHOUT bumping
 * `updatedAt` (the storage migration doesn't change scheduling, so it must not
 * re-arm crons or win an LWW it has no business in). Serialized on the per-id
 * queue like every other RMW here.
 */
async function clearInlineFeedback(id) {
  const store = commissionStore();
  await store.queueRecordWrite(id, async () => {
    const currentRaw = await store.readRaw(id);
    if (!currentRaw) return;
    const current = sanitizeCommission(currentRaw);
    if (current.feedback.length === 0) return;
    await store.writeRaw(id, { ...current, feedback: [] });
  });
}

export async function listCommissions() {
  const raw = await commissionStore().listRaw();
  const recs = raw.map(sanitizeCommission).filter(Boolean);
  // Hydrate the federated feedback view (read-through) in ONE pass — feedback is
  // no longer stored inline on the machine-local commission (#2686). Read-only:
  // any un-migrated legacy inline feedback is split lazily by getCommission /
  // backfillAllCommissionFeedback, not on this hot list path.
  const byId = await listFeedbackByCommissionIds(recs.map((r) => r.id)).catch(() => new Map());
  // Prefer the federated view; fall back to the record's own (sanitized) inline
  // feedback only when NO federated reaction exists for it yet — the transient
  // pre-migration window before getCommission / backfillAllCommissionFeedback has
  // split its legacy inline reactions. `byId.has` (not `|| []`) distinguishes
  // "federated store has this commission's reactions" (authoritative, even if the
  // array is non-empty) from "not yet migrated" (show the legacy inline so the
  // list page doesn't transiently under-report), without ever double-counting
  // (post-migration the inline array is empty).
  for (const r of recs) r.feedback = byId.has(r.id) ? byId.get(r.id) : r.feedback;
  return recs;
}

export async function getCommission(id) {
  const raw = await commissionStore().readRaw(id);
  const rec = raw ? sanitizeCommission(raw) : null;
  if (!rec) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  // Lazily migrate any legacy inline feedback (Phase 2 storage) into the
  // federated store, then clear it — so the scheduler's pre-fire read and the
  // route GET always see the federated feedback even before the boot backfill
  // runs. Idempotent (deterministic ids, never-clobber upsert).
  if (rec.feedback.length > 0) {
    // Clear the inline array ONLY if the split SUCCEEDED. A mid-batch DB failure
    // in backfillInlineFeedback (after ≥1 reaction was federated) must leave the
    // inline array intact so a later read/boot can retry — clearing on a swallowed
    // throw would permanently drop the un-migrated reactions. Gate on "didn't
    // throw", NOT on the boolean return (which is legitimately false on an
    // idempotent re-run where everything is already federated — clearing is still
    // correct then).
    let split = false;
    try { await backfillInlineFeedback(id, rec.feedback); split = true; } catch { /* leave inline for retry */ }
    if (split) await clearInlineFeedback(id).catch(() => {});
  }
  rec.feedback = await listFeedbackForCommission(id).catch(() => []);
  return rec;
}

export async function createCommission(input) {
  assertValidSchedule(input.schedule);
  const now = new Date().toISOString();
  const id = `commission-${randomUUID()}`;
  // sanitizeCommission defaults runs/feedback to [] and the create schema carries
  // neither key, so no explicit empties are needed here.
  const record = sanitizeCommission({ ...input, id, createdAt: now, updatedAt: now });
  await commissionStore().writeRaw(id, record);
  commissionEvents.emit('commission:changed', { id, action: 'create' });
  return record;
}

export async function updateCommission(id, patch) {
  if (patch.schedule) assertValidSchedule(patch.schedule);
  const store = commissionStore();
  // Serialize the load→merge→save on the per-id write queue so a concurrent
  // scheduler fire (recordCommissionRun, also queued) can't have its run-history
  // append clobbered by a stale pre-read here — the scheduler-vs-request race
  // CLAUDE.md requires serializing at the record level.
  const merged = await store.queueRecordWrite(id, async () => {
    const currentRaw = await store.readRaw(id);
    if (!currentRaw) return null;
    const current = sanitizeCommission(currentRaw);
    const next = sanitizeCommission({
      ...current,
      ...patch,
      // Deep-merge the nested objects so a partial brief/generation patch doesn't
      // wipe unspecified fields. The update-path brief/generation schemas carry
      // no defaults (unlike the create schemas), so an omitted key stays omitted
      // and is preserved here rather than overwritten with a defaulted empty.
      // `constraints` is merged one level deeper too, so `{ universeId }` in a
      // patch doesn't drop a stored `seriesId`.
      brief: patch.brief ? {
        ...current.brief,
        ...patch.brief,
        constraints: patch.brief.constraints
          ? { ...current.brief.constraints, ...patch.brief.constraints }
          : current.brief.constraints,
      } : current.brief,
      schedule: patch.schedule ? { ...current.schedule, ...patch.schedule } : current.schedule,
      generation: patch.generation ? { ...current.generation, ...patch.generation } : current.generation,
      // Whole-object replace (not a deep merge): the client always sends the full
      // { providerId, model } pin, and a clear sends both null. Merging would keep
      // a stale `model` when the provider is cleared. sanitizeCommission then drops
      // a provider-less model, so the stored pin can never dangle.
      assignment: patch.assignment ? patch.assignment : current.assignment,
      id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await store.writeRaw(id, next);
    return next;
  });
  if (!merged) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  commissionEvents.emit('commission:changed', { id, action: 'update' });
  return merged;
}

export async function deleteCommission(id) {
  const store = commissionStore();
  // Serialize the read+delete on the SAME per-id write queue as
  // update/recordRun/submitFeedback. Otherwise an in-flight feedback write (its
  // own queued read→writeRaw) could interleave with a delete that runs outside
  // the queue: feedback reads the row, delete hard-deletes it, feedback's
  // writeRaw then upserts the stale record and resurrects the commission. With
  // delete on the tail, a feedback write queued after it finds no row and 404s.
  const existed = await store.queueRecordWrite(id, async () => {
    const current = await store.readRaw(id);
    if (!current) return false;
    await store.deleteRaw(id);
    return true;
  });
  if (!existed) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  commissionEvents.emit('commission:changed', { id, action: 'delete' });
  return { id, deleted: true };
}

/**
 * Append a run entry to a commission (fire history). Runs are capped to the last
 * MAX_PERSISTED_RUNS. Serialized per-record on the write queue. Best-effort:
 * called from the scheduler's fire handler (outside the request lifecycle) — the
 * caller wraps errors. Returns the appended run, or null if the commission is gone.
 */
export async function recordCommissionRun(id, runEntry) {
  const store = commissionStore();
  return store.queueRecordWrite(id, async () => {
    const currentRaw = await store.readRaw(id);
    if (!currentRaw) return null;
    const current = sanitizeCommission(currentRaw);
    const run = {
      id: runEntry.id || `run-${randomUUID()}`,
      ranAt: runEntry.ranAt || new Date().toISOString(),
      status: runEntry.status || 'started',
      // 'manual' = a user-initiated "Run Now" fire; anything else is a scheduled
      // cron tick. Pre-trigger runs (persisted without the field) read as
      // scheduled, which is what they were.
      trigger: runEntry.trigger === 'manual' ? 'manual' : 'schedule',
      projectId: runEntry.projectId || null,
      promptUsed: isStr(runEntry.promptUsed) ? runEntry.promptUsed : null,
      reason: isStr(runEntry.reason) ? runEntry.reason : null,
      error: isStr(runEntry.error) ? runEntry.error : null,
    };
    const runs = [...(current.runs || []), run].slice(-MAX_PERSISTED_RUNS);
    await store.writeRaw(id, { ...current, runs, updatedAt: new Date().toISOString() });
    return run;
  });
}

/**
 * Record a user reaction to a commission run (#2657, Phase 2 — the taste
 * feedback loop). Appends a sanitized `CommissionFeedback` entry onto the
 * commission's inline `feedback[]`, keyed to the run being rated. The next
 * scheduled fire's `buildCommissionDirective` folds the last `feedbackWindow`
 * reactions into the directive, so a 👍/👎 + note demonstrably steers the next
 * run (the epic's core acceptance criterion).
 *
 * Serialized per-record on the SAME write queue as recordCommissionRun/
 * updateCommission, so a rating submitted while the scheduler is appending a run
 * can't clobber it (load→merge→save merges against the freshest persisted row).
 * Throws ERR_NOT_FOUND (→404) for an unknown commission and ERR_VALIDATION
 * (→400) when the referenced run isn't on the commission or the rating is
 * unusable. Returns the full updated commission so the UI updates reactively.
 *
 * Does NOT emit `commission:changed`: feedback never alters the schedule
 * signature, so a scheduler re-sync would be a pure no-op (mirrors
 * recordCommissionRun, which also stays silent).
 */
export async function submitCommissionFeedback(id, input) {
  // getCommission validates existence (→404), hydrates the federated feedback
  // view, and lazily splits any legacy inline reactions into the federated store.
  const commission = await getCommission(id);
  // The UI always rates a specific run; reject a runId that isn't on the record
  // so feedback can't dangle against a non-existent run.
  if (input?.runId && !commission.runs.some((r) => r.id === input.runId)) {
    throw makeErr(`Run not found on commission: ${input.runId}`, ERR_VALIDATION);
  }
  // Write to the FEDERATED feedback store (#2686): one record per reaction,
  // deterministic id per run so a re-rating LWW-updates in place (one reaction
  // per run) and the change propagates to every sync peer — the machine-local
  // commission no longer carries feedback inline.
  const rec = await recordFeedback({
    commissionId: id,
    runId: input?.runId ?? null,
    rating: input?.rating,
    note: input?.note,
    tags: input?.tags,
  });
  if (!rec) throw makeErr('Invalid feedback: a non-zero rating (up/down) is required', ERR_VALIDATION);
  commission.feedback = await listFeedbackForCommission(id).catch(() => []);
  return commission;
}

/**
 * Boot-time backfill (#2686 split-record migration): move every commission's
 * legacy INLINE feedback into the federated store and clear the inline array.
 * Idempotent — after the first pass commissions carry `feedback: []`, so a
 * re-run is a no-op. Invoked from server boot after the DB is ready (the
 * scripts/migrations runner executes before the pool is up, so the data move
 * can't live there — see migration 194's registration stub).
 */
export async function backfillAllCommissionFeedback() {
  const raw = await commissionStore().listRaw();
  let migrated = 0;
  for (const r of raw) {
    const rec = sanitizeCommission(r);
    if (!rec || rec.feedback.length === 0) continue;
    // Same non-atomic guard as getCommission: clear the inline array only after
    // the split succeeded, so a transient failure mid-batch leaves the un-migrated
    // reactions in place for the next boot/read instead of silently dropping them.
    try { await backfillInlineFeedback(rec.id, rec.feedback); } catch { continue; }
    await clearInlineFeedback(rec.id).catch(() => {});
    migrated += 1;
  }
  if (migrated > 0) console.log(`🎯 Commission feedback: split ${migrated} commission(s)' inline reactions into the federated store (#2686)`);
  return { migrated };
}
