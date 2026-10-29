/**
 * Video Gen — render history I/O.
 *
 * The render history (`data/video-history.json`) is the flat list the Media
 * History page grid-views. This module owns the read/write primitives; the
 * generation and post-processing modules load/save through these primitives;
 * local.js re-exports them as part of the stable provider surface.
 */

import { join } from 'path';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { compactSource } from '../mediaAssetIndex/logic.js';
import { PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

// STRICT (#4115): every write to this file goes `loadHistory` → mutate →
// `saveHistory`, so a present-but-unreadable video-history.json swallowed to `[]`
// makes the next completed download persist an empty array over the user's whole
// render history. The Media History page also counts this list ("Show more (N
// remaining)"), where a fake 0 reads as fact. Absent stays a real first-run empty.
export const loadHistory = () => readJSONFile(HISTORY_FILE, [], { strict: true });
let compactSnapshot;
let compactRead;
let revisionEpoch = 0;
export async function saveHistory(h) {
  await atomicWrite(HISTORY_FILE, h);
  revisionEpoch++;
  compactSnapshot = undefined;
}

async function historyRevision() {
  try {
    const info = await stat(HISTORY_FILE, { bigint: true });
    await access(HISTORY_FILE, constants.R_OK);
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function freezeRecord(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}

/** Fresh, immutable card/filter data; search and detail still use loadHistory. */
export function loadCompactHistory() {
  if (compactRead) return compactRead;
  compactRead = (async () => {
    // One builder owns admission. A save during its read invalidates the epoch;
    // external writers/replacements are detected on both sides of the read.
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = revisionEpoch;
      const before = await historyRevision();
      if (before !== null && compactSnapshot?.revision === before && epoch === revisionEpoch) {
        return compactSnapshot.rows;
      }
      const history = await loadHistory();
      const after = await historyRevision();
      if (epoch !== revisionEpoch || before !== after) continue;
      const rows = freezeRecord(history.map(compactSource));
      compactSnapshot = after === null ? undefined : { revision: after, rows };
      return rows;
    }
    throw new Error('Video history changed repeatedly while reading its compact snapshot');
  })().finally(() => { compactRead = undefined; });
  return compactRead;
}

// Resolve ONE entry by its history id, or `null` when no entry carries it (#4165).
// A history id is NOT the filename stem — `videoGen/local.js` names a clip
// `<jobId>.mp4` (so reconstruction happens to work there), but the timeline
// renderer mints `timeline-<project>-<ts>.mp4` beside an independent
// `randomUUID()` id, so a Creative Director `finalVideoId` can only be resolved
// through the stored `filename`. Callers that hold just an id used to pull the
// WHOLE list to find one row; this is the single-entry read behind
// `GET /api/video-gen/history/:id`.
//
// `null` (not a throw) is the not-found signal so the route owns the 404 and
// this stays usable as a plain lookup; distinct from the strict `loadHistory`
// read, which still throws on an unreadable history file rather than reporting
// a bogus "no such entry".
export async function getHistoryItem(id) {
  const history = await loadHistory();
  if (!Array.isArray(history)) return null;
  return history.find((entry) => entry?.id === id) || null;
}

// Serialized read-modify-write for the shared history file. `loadHistory` +
// mutate + `saveHistory` is not atomic on its own, so two write paths that
// finish near-simultaneously (e.g. two out-of-queue video downloads completing
// from two browser tabs — see server/services/videoDownload.js) both read the
// same stale array and the later save clobbers the earlier's new entry, leaving
// an orphaned file that's absent from the list/media-index and undeletable. A
// module-level promise tail collapses concurrent mutations to a single writer
// per file (the `createKeyCachedQueue` pattern in AGENTS.md). `mutator(list)` receives
// the freshest persisted array and returns the array to persist (return the
// same reference after mutating it in place, or a new array). Any writer that
// can race another on this file should route through here.
// A mutator that found nothing to change returns `HISTORY_UNCHANGED` so the
// file is not rewritten (an idempotent replay stays a true no-op).
export const HISTORY_UNCHANGED = Symbol('video-history-unchanged');
let historyWriteTail = Promise.resolve();
// `originInstanceId` (the machine that created the row) is immutable once set:
// a row rebuilt under a known id inherits the prior row's origin, and only
// genuinely new ids get the local id. Peer merges pass `{ stampOrigin: false }`
// because rows they add were created elsewhere. Stamped only when the id is known.
export function mutateVideoHistory(mutator, { stampOrigin = true } = {}) {
  const run = historyWriteTail.then(async () => {
    const history = await loadHistory();
    const base = Array.isArray(history) ? history : [];
    // Captured before the mutator, which may edit rows in place.
    const priorOrigins = stampOrigin ? new Map(base.map((r) => [r?.id, r?.originInstanceId])) : null;
    const next = await mutator(base);
    if (next === HISTORY_UNCHANGED) return history;
    const toSave = Array.isArray(next) ? next : history;
    // Rows this local mutation added (new ids); announced to peers after the save.
    const added = [];
    let origin = null;
    if (stampOrigin && Array.isArray(toSave)) {
      for (const r of toSave) {
        if (!r || typeof r !== 'object') continue;
        if (!priorOrigins.has(r.id)) added.push(r);
        else if (!r.originInstanceId && priorOrigins.get(r.id)) r.originInstanceId = priorOrigins.get(r.id);
      }
      if (added.length > 0) {
        // Lazy: identity pulls in fileUtils at load; a stamping failure must never lose the row.
        origin = await import('../instanceIdentity.js')
          .then((m) => m.getInstanceId().then((id) => (id === m.UNKNOWN_INSTANCE_ID ? null : id)))
          .catch((err) => { console.log(`⏭️ Video origin stamp skipped: ${err.message}`); return null; });
        // A new id on the local path was created HERE, even when the mutator spread
        // a peer's source row (upscale, trim): origin is this machine, never a
        // copied one, and the copied machine-local supplier and pending delete are dropped.
        for (const r of added) {
          delete r.suppliedByInstanceId;
          delete r.pendingDelete;
          if (origin) r.originInstanceId = origin;
          else delete r.originInstanceId;
        }
      }
    }
    await saveHistory(toSave);
    if (added.length > 0) {
      // After the commit, once per added row; peer merges (stampOrigin:false) never announce.
      // Copied now: the caller receives `toSave` and may edit it before the import settles.
      const committed = added.map((r) => ({ ...r }));
      void import('../peerSyncEventBus.js')
        .then((m) => m.announceLocalVideoRows(committed, origin))
        .catch((err) => console.error(`❌ Video row announce failed: ${err.message}`));
    }
    return toSave;
  });
  // Keep the tail alive even if this mutation rejects, so one failure doesn't
  // wedge every subsequent write behind a permanently-rejected promise.
  historyWriteTail = run.then(() => {}, () => {});
  return run;
}
