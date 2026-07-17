/**
 * Creative Commission feedback store — federated per-reaction record kind
 * (#2686, split-record federation).
 *
 * Owns the `commissionFeedback` record kind: taste reactions split OUT of the
 * machine-local commission so they federate across sync peers (a 👍/👎 rated on
 * machine A conditions the same commission's next run on machine B), while the
 * commission's schedule stays local. See feedbackLogic.js for the WHY and the
 * per-reaction / deterministic-id rationale.
 *
 * Structure mirrors ./store.js: a `createPgFileFacade` picks the PostgreSQL leaf
 * (feedbackDb.js — the real backend for every install) or the collectionStore
 * file backend (`data/commission-feedback/`, the dev/test escape hatch). The
 * facade owns the sanitizer + LWW merge uniformly (applied on the service side,
 * not inside a backend) so the two backends can't drift, and serializes every
 * read-modify-write on a shared per-id write queue — commissions are written only
 * by the single main server process, so in-process per-id serialization is
 * sufficient (no row lock), and it keeps the sync-receive merge from racing a
 * concurrent user rating of the same run.
 *
 * The federation wiring (peerSync push/receive/tombstoneGc/conflict-resolver)
 * imports the `*ForSync` facades below, exactly as it imports writersRoom/sync.js.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import {
  contentHashForRecord,
  setSyncBaseHash,
  deleteSyncBaseHash,
  flushBaseHashes,
  maybeJournalBeforeOverwrite,
} from '../../lib/conflictJournal.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import {
  COMMISSION_FEEDBACK_KIND,
  CFEEDBACK_ID_RE,
  deterministicFeedbackId,
  sanitizeCommissionFeedbackForSync,
  mergeCommissionFeedbackRecord,
  toInlineFeedback,
} from './feedbackLogic.js';

export const TYPE = 'commission-feedback';
export const FEEDBACK_SCHEMA_VERSION = 1;

const isStr = (v) => typeof v === 'string';
const notDeleted = (r) => r && r.deleted !== true;

// --- File backend (dev/test escape hatch): wraps collectionStore ---
function makeFileBackend(dir) {
  const cs = createCollectionStore({ dir, type: TYPE, schemaVersion: FEEDBACK_SCHEMA_VERSION });
  let stamped = false;
  const ensureTypeIndex = async () => {
    if (stamped) return;
    stamped = true;
    await cs.saveTypeIndex({}).catch(() => { stamped = false; });
  };
  return {
    name: 'file',
    readRaw: async (id, { includeDeleted = false } = {}) => {
      const rec = await cs.loadOne(id);
      if (!rec) return null;
      return includeDeleted || notDeleted(rec) ? rec : null;
    },
    listRaw: async () => (await cs.loadAll()).filter(notDeleted),
    listRawByCommission: async (commissionId) =>
      (await cs.loadAll()).filter((r) => notDeleted(r) && r?.commissionId === commissionId),
    listIds: async ({ includeDeleted = false } = {}) =>
      (await cs.loadAll()).filter((r) => includeDeleted || notDeleted(r)).map((r) => r.id),
    writeRaw: async (id, record) => { await ensureTypeIndex(); await cs.saveOneNow(id, record); return record; },
    pruneTombstoned: async (olderThanMs) => {
      if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
      const all = await cs.loadAll();
      const stale = all.filter((r) => r?.deleted === true && isStr(r.deletedAt) && Date.parse(r.deletedAt) < olderThanMs);
      for (const r of stale) await cs.deleteOneNow(r.id);
      return { pruned: stale.length, ids: stale.map((r) => r.id) };
    },
    verify: () => cs.verifySchemaVersion(),
  };
}

// --- PostgreSQL backend: pure leaf I/O from ./feedbackDb.js ---
function makePgBackend(db) {
  return {
    name: 'postgres',
    readRaw: db.readRaw,
    listRaw: db.listRaw,
    listRawByCommission: db.listRawByCommission,
    listIds: db.listIds,
    writeRaw: db.writeRaw,
    pruneTombstoned: db.pruneTombstoned,
  };
}

const pgBackend = () => resolvePgBackend({
  requirement: 'Creative Commission feedback requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  loadDb: () => import('./feedbackDb.js'),
  makePg: makePgBackend,
});

let _facade = null;
let _facadeDir = null;

function createFacade(dir) {
  const { getBackend, getBackendName } = createPgFileFacade({
    makeFile: () => makeFileBackend(dir),
    makePg: () => pgBackend(),
  });
  const queueRecordWrite = createRecordWriteQueue();
  return {
    dir,
    type: TYPE,
    getBackendName,
    readRaw: async (id, opts) => (await getBackend()).readRaw(id, opts),
    listRaw: async () => (await getBackend()).listRaw(),
    listRawByCommission: async (id) => (await getBackend()).listRawByCommission(id),
    listIds: async (opts) => (await getBackend()).listIds(opts),
    writeRaw: async (id, record) => (await getBackend()).writeRaw(id, record),
    pruneTombstoned: async (olderThanMs) => (await getBackend()).pruneTombstoned(olderThanMs),
    queueRecordWrite,
  };
}

function feedbackStore() {
  const dir = join(PATHS.data, TYPE);
  if (_facade && _facadeDir === dir) return _facade;
  _facade = createFacade(dir);
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only. */
export function _resetFeedbackStore() {
  _facade = null;
  _facadeDir = null;
}

/**
 * Record (or re-record) a reaction for a commission run. Deterministic id per
 * run (`cfeedback-<runId>`) so re-rating LWW-updates in place — one reaction per
 * run, sync-safe. Run-less reactions get a random id. Returns the sanitized
 * stored record, or null when the rating is unusable (the caller validates
 * commission/run existence before calling this). Serialized per-id so a
 * concurrent sync-receive merge of the same record can't clobber it.
 */
export async function recordFeedback({ commissionId, runId = null, rating, note = '', tags = [] }) {
  const store = feedbackStore();
  const id = deterministicFeedbackId(runId) || `cfeedback-${randomUUID()}`;
  const result = await store.queueRecordWrite(id, async () => {
    const existing = await store.readRaw(id, { includeDeleted: true });
    const now = new Date().toISOString();
    const record = sanitizeCommissionFeedbackForSync({
      id,
      commissionId,
      runId,
      rating,
      note,
      tags,
      at: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deleted: false,
      deletedAt: null,
    });
    if (!record) return null;
    await store.writeRaw(id, record);
    return record;
  });
  if (!result) return null;
  // Push to every subscribed peer so the reaction (and later its tombstone)
  // propagates without waiting for a reconnect — mirrors writersRoomFolder.
  autoSubscribeRecordToAllPeers(COMMISSION_FEEDBACK_KIND, id).catch(() => {});
  return result;
}

/**
 * The inline `feedback[]` view for one commission (oldest reaction first), mapped
 * to the `{ id, runId, rating, note, tags, at }` shape directive.js + the client
 * rate UI consume. Hydrated onto the machine-local commission on read so the
 * split is invisible to both.
 */
export async function listFeedbackForCommission(commissionId) {
  const raw = await feedbackStore().listRawByCommission(commissionId);
  return raw
    .map(sanitizeCommissionFeedbackForSync)
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map(toInlineFeedback);
}

/**
 * The inline `feedback[]` view for MANY commissions in one pass (avoids an N+1
 * over listCommissions). Returns a Map<commissionId, inlineFeedback[]>.
 */
export async function listFeedbackByCommissionIds(commissionIds) {
  const want = new Set(commissionIds);
  const raw = await feedbackStore().listRaw();
  const byId = new Map();
  for (const r of raw) {
    const rec = sanitizeCommissionFeedbackForSync(r);
    if (!rec || !rec.commissionId || !want.has(rec.commissionId)) continue;
    if (!byId.has(rec.commissionId)) byId.set(rec.commissionId, []);
    byId.get(rec.commissionId).push(rec);
  }
  const out = new Map();
  for (const [cid, list] of byId) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    out.set(cid, list.map(toInlineFeedback));
  }
  return out;
}

// ---------- federation facades (imported by the peer-sync layer) ----------

/** One feedback record's sanitized wire form (tombstone surfaced), or null. */
export async function getCommissionFeedbackForSync(id) {
  const raw = await feedbackStore().readRaw(id, { includeDeleted: true });
  return raw ? sanitizeCommissionFeedbackForSync(raw) : null;
}

/** Every LIVE feedback record as `{ id, updatedAt }` for full-sync coverage compare. */
export async function listCommissionFeedbackForSync() {
  const raw = await feedbackStore().listRaw();
  return raw
    .map(sanitizeCommissionFeedbackForSync)
    .filter(Boolean)
    .map((r) => ({ id: r.id, updatedAt: r.updatedAt }));
}

/** Every feedback id — live only by default, or all (incl. tombstones) for the sweep. */
export async function listCommissionFeedbackIdsForSync(options = {}) {
  return feedbackStore().listIds(options);
}

/**
 * Merge an incoming batch of feedback records from a peer (LWW, tombstone-aware).
 * Serialized per-id on the same write queue as recordFeedback so a user rating
 * can't clobber the merge (or vice versa). Journals the about-to-be-overwritten
 * local version when the remote wins, and seeds the conflict-journal base hash —
 * mirrors writersRoom's `mergeBodylessFromSync`, minus the PG row lock (the
 * single-process per-id queue serializes both writers). Returns `{ applied, count }`.
 */
export async function mergeCommissionFeedbackFromSync(remoteRecords, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteRecords)) return { applied: false, count: 0 };
  const store = feedbackStore();
  let changed = 0;
  for (const remote of remoteRecords) {
    const id = remote?.id;
    if (!isStr(id) || !CFEEDBACK_ID_RE.test(id)) continue;
    const applied = await store.queueRecordWrite(id, async () => {
      const local = await store.readRaw(id, { includeDeleted: true });
      const { next, inserted, remoteWins, changed: didChange } = mergeCommissionFeedbackRecord(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (!inserted && (!remoteWins || !didChange)) return false; // local wins, or no-op
      if (!inserted) {
        await maybeJournalBeforeOverwrite({ kind: COMMISSION_FEEDBACK_KIND, id: next.id, local, remote: next, source });
      }
      await store.writeRaw(id, next);
      await setSyncBaseHash(COMMISSION_FEEDBACK_KIND, next.id, contentHashForRecord(COMMISSION_FEEDBACK_KIND, next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  return changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
}

/** Hard-remove tombstoned feedback older than the cutoff; evicts each pruned id's base hash. */
export async function pruneTombstonedCommissionFeedback(olderThanMs) {
  const result = await feedbackStore().pruneTombstoned(olderThanMs);
  for (const id of result.ids || []) await deleteSyncBaseHash(COMMISSION_FEEDBACK_KIND, id).catch(() => {});
  return result;
}

/**
 * Restore a feedback record from a conflict-journal snapshot (Conflicts UI).
 * Merges the RESTORABLE fields, un-tombstones, bumps `updatedAt` so the restore
 * wins the next LWW and re-pushes. A missing record returns null (→ ERR_TARGET_GONE).
 */
export async function restoreCommissionFeedback(id, patch) {
  const store = feedbackStore();
  const result = await store.queueRecordWrite(id, async () => {
    const current = await store.readRaw(id, { includeDeleted: true });
    if (!current) return null;
    const now = new Date().toISOString();
    const next = sanitizeCommissionFeedbackForSync({
      ...current,
      ...(isStr(patch?.rating) || typeof patch?.rating === 'number' ? { rating: patch.rating } : {}),
      ...(isStr(patch?.note) ? { note: patch.note } : {}),
      ...(Array.isArray(patch?.tags) ? { tags: patch.tags } : {}),
      deleted: false,
      deletedAt: null,
      updatedAt: now,
    });
    if (!next) return null;
    await store.writeRaw(id, next);
    return next;
  });
  if (!result) return null;
  emitRecordUpdated(COMMISSION_FEEDBACK_KIND, id);
  return result;
}

/**
 * Soft-delete (tombstone) a feedback record so the removal federates. Idempotent.
 * No route calls this today (re-rating LWW-updates in place; a deleted commission
 * leaves its feedback records addressable for peers that still hold the
 * commission) — it exists so the tombstone/GC wiring stays consistent with the
 * record-kind pattern and a future "forget this reaction" affordance can reuse it.
 */
export async function deleteCommissionFeedback(id) {
  const store = feedbackStore();
  const existed = await store.queueRecordWrite(id, async () => {
    const current = await store.readRaw(id, { includeDeleted: true });
    if (!current || current.deleted === true) return false;
    const now = new Date().toISOString();
    await store.writeRaw(id, sanitizeCommissionFeedbackForSync({ ...current, deleted: true, deletedAt: now, updatedAt: now }));
    return true;
  });
  if (!existed) return { id, deleted: false };
  emitRecordDeleted(COMMISSION_FEEDBACK_KIND, id);
  return { id, deleted: true };
}

/**
 * Migrate a commission's INLINE `feedback[]` (Phase 2 storage) into the federated
 * store, then return true if any were moved (the caller clears the inline array).
 * Idempotent: deterministic ids + `ON CONFLICT` upsert mean re-running is a no-op
 * once migrated, and a newer federated reaction (re-rated on a peer) is never
 * clobbered because we only write when the record is ABSENT. Used by the
 * split-record migration (#2686) and defensively by the commission read path.
 */
export async function backfillInlineFeedback(commissionId, inlineFeedback) {
  if (!Array.isArray(inlineFeedback) || inlineFeedback.length === 0) return false;
  const store = feedbackStore();
  let wrote = 0;
  for (const entry of inlineFeedback) {
    if (!entry || typeof entry !== 'object') continue;
    // Derive a STABLE id so re-migrating the same legacy reaction is idempotent —
    // even a run-LESS one — so a retry after a failed clearInlineFeedback can't
    // duplicate it: prefer the deterministic per-run id; else the entry's own id
    // (a valid federated id verbatim, or a legacy `feedback-<uuid>` remapped into
    // the `cfeedback-` namespace); only a truly id-less+run-less entry (which
    // sanitizeFeedbackEntry never produces — it always mints an id) falls to random.
    let id = deterministicFeedbackId(entry.runId);
    if (!id) {
      if (isStr(entry.id) && CFEEDBACK_ID_RE.test(entry.id)) id = entry.id;
      else if (isStr(entry.id) && entry.id) id = `cfeedback-${entry.id.replace(/[^0-9a-z-]/gi, '-')}`;
      else id = `cfeedback-${randomUUID()}`;
    }
    const at = isStr(entry.at) ? entry.at : new Date().toISOString();
    const record = sanitizeCommissionFeedbackForSync({
      id, commissionId, runId: entry.runId ?? null, rating: entry.rating,
      note: entry.note, tags: entry.tags, at, createdAt: at, updatedAt: at,
      deleted: false, deletedAt: null,
    });
    if (!record) continue;
    const didWrite = await store.queueRecordWrite(id, async () => {
      const existing = await store.readRaw(id, { includeDeleted: true });
      if (existing) return false; // already federated (possibly newer) — never clobber
      await store.writeRaw(id, record);
      return true;
    });
    if (didWrite) { wrote += 1; autoSubscribeRecordToAllPeers(COMMISSION_FEEDBACK_KIND, id).catch(() => {}); }
  }
  return wrote > 0;
}
