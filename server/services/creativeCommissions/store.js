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
 * read and by `backfillAllCommissionFeedback()` at boot.
 *
 * The commission BRIEF itself also federates (#2686, record kind
 * `creativeCommission`) so the same commission — and thus the attach point for a
 * synced reaction — exists on every peer. The federated brief fields are
 * name / targetAbility / brief / generation / feedbackWindow (feedbackWindow is
 * part of the brief config, so it carries across machines); `schedule`, `runs`,
 * `assignment`, and `enabled` stay MACHINE-LOCAL (stripped from the wire, kept by
 * the receiver on merge, dormant on a fresh insert) so only the machine you
 * scheduled it on ever fires the cron. The federated LWW key is a brief-scoped
 * clock (`briefUpdatedAt`) that advances only on a federated-field edit (or a
 * delete/restore), NOT the general `updatedAt` that machine-local edits and run
 * appends bump — so a schedule change or a recordCommissionRun can never push a
 * stale brief or make a real brief edit lose.
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
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import {
  contentHashForRecord,
  setSyncBaseHash,
  deleteSyncBaseHash,
  flushBaseHashes,
  maybeJournalBeforeOverwrite,
} from '../../lib/conflictJournal.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { commissionToCron } from './directive.js';
import { getAbilityAdapter } from './abilityAdapters.js';
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
  // Resolve the output type up front (#2769). A KNOWN type is sanitized through
  // its ability adapter (fills that type's defaults, keeps ONLY that type's keys —
  // an image `imageCount`, a series `episodeCount`). An UNKNOWN non-empty type (a
  // forward-version record synced verbatim from a newer peer) is PRESERVED, not
  // rewritten to `video`: rewriting would corrupt the newer peer's brief on read
  // and could push the downgrade back via LWW (violating the distribution model's
  // forward-compat rule). The scheduler skips an unknown ability rather than
  // mis-generating it, so unknown = inert-but-preserved. A missing/blank type
  // falls back to the default `video`.
  const resolvedAbility = isStr(raw.targetAbility) && raw.targetAbility ? raw.targetAbility : 'video';
  const abilityAdapter = getAbilityAdapter(resolvedAbility);
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
    // Preserve the resolved output type as-is (#2769) — known types pass through,
    // an unknown forward-version type round-trips untouched (see above).
    targetAbility: resolvedAbility,
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
    // Per-ability generation (#2769): a known type's adapter fills its defaults
    // and keeps only its keys; an unknown (forward-version) type has no adapter, so
    // preserve the raw generation object verbatim — nothing is lost on round-trip
    // and the scheduler won't fire it anyway.
    generation: abilityAdapter ? abilityAdapter.sanitizeGeneration(generation) : { ...generation },
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
    // Brief-scoped LWW clock (#2686). The federation compares THIS, not `updatedAt`
    // — because `updatedAt` is bumped by machine-local edits (a schedule change, a
    // recordCommissionRun append) that must NOT let a stale brief win the LWW or a
    // schedule-only edit push a stale brief. `briefUpdatedAt` advances ONLY when a
    // federated field (name/targetAbility/brief/generation/feedbackWindow) changes.
    // Pre-#2686 records fall back to `updatedAt`.
    briefUpdatedAt: isStr(raw.briefUpdatedAt) ? raw.briefUpdatedAt
      : (isStr(raw.updatedAt) ? raw.updatedAt : (isStr(raw.createdAt) ? raw.createdAt : now)),
    // Soft-delete tombstone trio (#2686). The commission BRIEF federates so it
    // exists on every peer (letting a synced reaction attach to the same
    // commission); a delete must therefore propagate as a tombstone, not a hard
    // delete the LWW merge would never carry. `schedule`/`runs`/`assignment` stay
    // machine-local (stripped from the wire — see syncWire's `creativeCommission`
    // case + preserveLocalCommissionFields), so only the OWNING machine fires the
    // cron (no double-run). Pre-#2686 records carry neither field → live.
    deleted: raw.deleted === true,
    deletedAt: raw.deleted === true && isStr(raw.deletedAt) ? raw.deletedAt : null,
  };
}

// The peer-sync record kind + id shape for the federated commission brief (#2686).
export const CREATIVE_COMMISSION_KIND = 'creativeCommission';
export const COMMISSION_ID_RE = /^commission-[0-9a-z-]+$/i;

/**
 * Normalize a raw commission into the canonical wire/stored shape for a sync
 * round-trip (drop-on-floor for a non-object / bad id). Reuses sanitizeCommission
 * (which now normalizes the soft-delete trio) — the machine-local fields
 * (schedule/runs/assignment) are stripped from the actual WIRE form by syncWire's
 * `creativeCommission` case, and carried forward from the local copy on merge by
 * preserveLocalCommissionFields, so they never transit or reset a peer's schedule.
 */
export function sanitizeCommissionForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !COMMISSION_ID_RE.test(raw.id)) return null;
  return sanitizeCommission(raw);
}

// The MACHINE-LOCAL fields that never travel on the wire — the receiver keeps its
// OWN values for all of these. `enabled` is machine-local too (#2686): a remotely-
// inserted commission must NOT arm a cron on the receiver, so each machine decides
// whether/when it runs. `feedback` is preserved so a remote brief-win can't wipe a
// commission's un-migrated legacy inline reactions before the boot backfill runs.
const LOCAL_COMMISSION_FIELDS = ['schedule', 'runs', 'assignment', 'enabled', 'feedback'];
// The federated brief fields — a patch touching any of these advances the brief
// LWW clock (`briefUpdatedAt`); a machine-local-only patch does not.
const FEDERATED_COMMISSION_FIELDS = ['name', 'targetAbility', 'brief', 'generation', 'feedbackWindow'];

/** Re-attach the receiver's local-only fields onto a winning remote; bump the UI clock. */
function preserveLocalCommissionFields(remote, local) {
  if (!local) return remote;
  const out = { ...remote };
  for (const f of LOCAL_COMMISSION_FIELDS) out[f] = local[f];
  // The wire form set `updatedAt = briefUpdatedAt`; restore a real UI "last-changed"
  // clock (max of the two) while keeping the federated brief clock as the LWW key.
  out.updatedAt = new Date().toISOString();
  return out;
}

/**
 * LWW merge decision for one incoming commission (mirrors mergeWorkRecord): the
 * remote is sanitized here (drop-on-floor → null); a missing local INSERTS the
 * brief in a DORMANT state (enabled:false, no usable schedule) so it never fires
 * on the receiver until the user opts in; else the newer BRIEF clock wins, and the
 * receiver's machine-local schedule/runs/assignment/enabled/feedback carry forward
 * (they never travel), so a peer's brief edit can't arm or reset this machine.
 */
export function mergeCommissionRecord(local, remoteRaw) {
  const remote = sanitizeCommissionForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) {
    // Dormant insert: enabled:false + the sanitizer's null-time schedule (no cron)
    // so editing only the synced brief on the receiver can't silently arm a daily
    // run. The user explicitly enables + schedules it locally to activate.
    return { next: { ...remote, enabled: false }, inserted: true, remoteWins: true, changed: true };
  }
  const sanitizedLocal = sanitizeCommission(local);
  const remoteWins = compareNewerWins(remote.briefUpdatedAt, sanitizedLocal.briefUpdatedAt);
  const next = remoteWins ? preserveLocalCommissionFields(remote, sanitizedLocal) : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
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
  const live = (r) => r && r.deleted !== true;
  return {
    name: 'file',
    listRaw: async ({ includeDeleted = false } = {}) =>
      (await cs.loadAll()).filter((r) => includeDeleted || live(r)),
    readRaw: async (id, { includeDeleted = false } = {}) => {
      const rec = await cs.loadOne(id);
      if (!rec) return null;
      return includeDeleted || live(rec) ? rec : null;
    },
    listIds: async ({ includeDeleted = false } = {}) =>
      (await cs.loadAll()).filter((r) => includeDeleted || live(r)).map((r) => r.id),
    writeRaw: async (id, record) => { await ensureTypeIndex(); await cs.saveOneNow(id, record); return record; },
    deleteRaw: (id) => cs.deleteOneNow(id),
    pruneTombstoned: async (olderThanMs) => {
      if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
      const stale = (await cs.loadAll()).filter((r) => r?.deleted === true && isStr(r.deletedAt) && Date.parse(r.deletedAt) < olderThanMs);
      for (const r of stale) await cs.deleteOneNow(r.id);
      return { pruned: stale.length, ids: stale.map((r) => r.id) };
    },
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
    listIds: db.listIds,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    pruneTombstoned: db.pruneTombstoned,
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
    listRaw: async (opts) => (await getBackend()).listRaw(opts),
    readRaw: async (id, opts) => (await getBackend()).readRaw(id, opts),
    listIds: async (opts) => (await getBackend()).listIds(opts),
    writeRaw: async (id, record) => (await getBackend()).writeRaw(id, record),
    deleteRaw: async (id) => (await getBackend()).deleteRaw(id),
    pruneTombstoned: async (olderThanMs) => (await getBackend()).pruneTombstoned(olderThanMs),
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
/**
 * Union the federated feedback view with any still-stored legacy INLINE reactions,
 * deduped by runId (the deterministic `cfeedback-<runId>` key) or, for run-less
 * reactions, by id. Federated wins on a collision. This keeps reads complete
 * during the migration window: if `backfillInlineFeedback` migrated only a PREFIX
 * before throwing (inline retained for retry), neither the list page nor the
 * scheduler directive silently omits the un-migrated tail. After a full migration
 * the inline array is empty, so this is just the federated view.
 */
function unionInlineFeedback(federated, inline) {
  if (!Array.isArray(inline) || inline.length === 0) return federated;
  const seenRun = new Set(federated.filter((f) => f.runId).map((f) => f.runId));
  const seenId = new Set(federated.map((f) => f.id));
  const extra = inline.filter((f) => (f?.runId ? !seenRun.has(f.runId) : !seenId.has(f?.id)));
  if (extra.length === 0) return federated;
  return [...federated, ...extra].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

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
  for (const r of recs) r.feedback = unionInlineFeedback(byId.get(r.id) || [], r.feedback);
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
  const inlineLegacy = rec.feedback;
  if (inlineLegacy.length > 0) {
    // Clear the inline array ONLY if the split SUCCEEDED. A mid-batch DB failure
    // in backfillInlineFeedback (after ≥1 reaction was federated) must leave the
    // inline array intact so a later read/boot can retry — clearing on a swallowed
    // throw would permanently drop the un-migrated reactions. Gate on "didn't
    // throw", NOT on the boolean return (which is legitimately false on an
    // idempotent re-run where everything is already federated — clearing is still
    // correct then).
    let split = false;
    try { await backfillInlineFeedback(id, inlineLegacy); split = true; } catch { /* leave inline for retry */ }
    if (split) await clearInlineFeedback(id).catch(() => {});
  }
  const federated = await listFeedbackForCommission(id).catch(() => []);
  // Union with the legacy inline reactions so a PARTIAL migration (backfill wrote
  // a prefix then threw, inline retained for retry) never hides the un-migrated
  // tail from the scheduler directive or the UI. After a full migration the inline
  // array is empty, so this is just the federated view (dedup drops the overlap).
  rec.feedback = unionInlineFeedback(federated, inlineLegacy);
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
  // Federate the commission BRIEF (#2686) so it exists on every peer and a synced
  // reaction can attach to the same commission. The schedule/runs/assignment stay
  // machine-local (stripped from the wire), so the peer holds the brief but never
  // fires the cron.
  autoSubscribeRecordToAllPeers(CREATIVE_COMMISSION_KIND, id).catch(() => {});
  emitRecordUpdated(CREATIVE_COMMISSION_KIND, id);
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
    const nowIso = new Date().toISOString();
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
      updatedAt: nowIso,
      // Advance the federated BRIEF clock ONLY when a federated field changes —
      // a machine-local edit (schedule/assignment) must not poison the LWW key or
      // it could push a stale brief to peers / make a real brief edit lose. When it
      // DOES advance, it equals `updatedAt` (same `nowIso`); a local-only edit
      // leaves it at the prior value (< updatedAt).
      briefUpdatedAt: FEDERATED_COMMISSION_FIELDS.some((k) => k in patch)
        ? nowIso : current.briefUpdatedAt,
    });
    await store.writeRaw(id, next);
    return next;
  });
  if (!merged) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  commissionEvents.emit('commission:changed', { id, action: 'update' });
  // Push the brief change to subscribed peers (the schedule/runs/assignment are
  // stripped from the wire, so only the brief travels).
  emitRecordUpdated(CREATIVE_COMMISSION_KIND, id);
  return merged;
}

export async function deleteCommission(id) {
  const store = commissionStore();
  // SOFT-delete (tombstone) now that the commission BRIEF federates (#2686): a
  // hard delete would never propagate (the LWW merge only adds/updates), so an
  // out-of-date peer would resurrect the commission on the next sync. Tombstone
  // instead — the deletion rides the same push path and the peer converges.
  // Serialized on the SAME per-id write queue as update/recordRun/submitFeedback
  // so an in-flight feedback/run write can't interleave and resurrect a live row.
  const existed = await store.queueRecordWrite(id, async () => {
    const currentRaw = await store.readRaw(id);
    if (!currentRaw) return false;
    const current = sanitizeCommission(currentRaw);
    if (current.deleted) return false;
    const now = new Date().toISOString();
    // Bump the BRIEF clock too — the tombstone is a brief-level change that must
    // win the briefUpdatedAt-keyed LWW on peers (otherwise it ties the pre-delete
    // brief and never propagates).
    await store.writeRaw(id, { ...current, deleted: true, deletedAt: now, updatedAt: now, briefUpdatedAt: now });
    return true;
  });
  if (!existed) throw makeErr(`Commission not found: ${id}`, ERR_NOT_FOUND);
  // Re-sync schedules (the scheduler cancels the now-tombstoned commission's cron)
  // and push the tombstone to peers.
  commissionEvents.emit('commission:changed', { id, action: 'delete' });
  emitRecordDeleted(CREATIVE_COMMISSION_KIND, id);
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

// ---------- commission BRIEF federation facades (#2686) ----------
// The peer-sync layer imports these exactly as it imports writersRoom/sync.js.
// The commission record federates (so a synced reaction attaches to the same
// commission on every peer) while schedule/runs/assignment stay machine-local
// (stripped from the wire by syncWire, carried forward on merge).

/** One commission's sanitized record (tombstone surfaced), or null. */
export async function getCommissionForSync(id) {
  const raw = await commissionStore().readRaw(id, { includeDeleted: true });
  return raw ? sanitizeCommissionForSync(raw) : null;
}

/** Every LIVE commission as `{ id, updatedAt }` for full-sync coverage compare.
 *  `updatedAt` is the BRIEF clock (the wire LWW key), so coverage compares like-for-like. */
export async function listCommissionsForSync() {
  const raw = await commissionStore().listRaw();
  return raw.map(sanitizeCommissionForSync).filter(Boolean).map((r) => ({ id: r.id, updatedAt: r.briefUpdatedAt }));
}

/** Every commission id — live only by default, or all (incl. tombstones) for the sweep. */
export async function listCommissionIdsForSync(options = {}) {
  return commissionStore().listIds(options);
}

/**
 * Merge an incoming batch of commission records from a peer (LWW, tombstone-aware).
 * Serialized per-id on the same write queue as the REST writers so a user edit
 * can't clobber the merge. Journals the about-to-be-overwritten local version
 * when the remote wins, seeds the conflict-journal base hash, and re-syncs the
 * scheduler (a merged brief/tombstone can change what's armed). Mirrors
 * writersRoom's `mergeBodylessFromSync`, minus the PG row lock.
 */
export async function mergeCommissionsFromSync(remoteRecords, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteRecords)) return { applied: false, count: 0 };
  const store = commissionStore();
  let changed = 0;
  for (const remote of remoteRecords) {
    const id = remote?.id;
    if (!isStr(id) || !COMMISSION_ID_RE.test(id)) continue;
    const applied = await store.queueRecordWrite(id, async () => {
      const local = await store.readRaw(id, { includeDeleted: true });
      const { next, inserted, remoteWins, changed: didChange } = mergeCommissionRecord(local, remote);
      if (!next) return false;
      if (!inserted && (!remoteWins || !didChange)) return false;
      if (!inserted) {
        await maybeJournalBeforeOverwrite({ kind: CREATIVE_COMMISSION_KIND, id: next.id, local, remote: next, source });
      }
      await store.writeRaw(id, next);
      await setSyncBaseHash(CREATIVE_COMMISSION_KIND, next.id, contentHashForRecord(CREATIVE_COMMISSION_KIND, next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed > 0) commissionEvents.emit('commission:changed', { action: 'merge' });
  return changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
}

/** Hard-remove tombstoned commissions older than the cutoff; evicts each base hash. */
export async function pruneTombstonedCommissions(olderThanMs) {
  const result = await commissionStore().pruneTombstoned(olderThanMs);
  for (const id of result.ids || []) await deleteSyncBaseHash(CREATIVE_COMMISSION_KIND, id).catch(() => {});
  return result;
}

/**
 * Restore a tombstoned/edited commission from a conflict-journal snapshot. Merges
 * the RESTORABLE brief fields, un-tombstones, bumps updatedAt so the restore wins
 * the next LWW and re-pushes. Returns null for a missing record (→ ERR_TARGET_GONE).
 */
export async function restoreCommission(id, patch) {
  const store = commissionStore();
  const result = await store.queueRecordWrite(id, async () => {
    const currentRaw = await store.readRaw(id, { includeDeleted: true });
    if (!currentRaw) return null;
    const current = sanitizeCommission(currentRaw);
    const next = sanitizeCommission({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      id, createdAt: current.createdAt,
      // Never let a snapshot restore resurrect the machine-local fields — keep ours.
      schedule: current.schedule, runs: current.runs, assignment: current.assignment,
      enabled: current.enabled,
      // Advance the brief clock so the restore wins the next LWW and re-pushes.
      deleted: false, deletedAt: null, updatedAt: new Date().toISOString(), briefUpdatedAt: new Date().toISOString(),
    });
    await store.writeRaw(id, next);
    return next;
  });
  if (!result) return null;
  commissionEvents.emit('commission:changed', { id, action: 'restore' });
  emitRecordUpdated(CREATIVE_COMMISSION_KIND, id);
  return result;
}
