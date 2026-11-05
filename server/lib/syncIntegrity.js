/**
 * Pure integrity diff for federated record lists.
 *
 * Compares local vs remote manifest lists and classifies each record by
 * synchronisation status. No I/O — all logic is pure so it can be called
 * from any service without side effects.
 */

import { parseTsMs } from './lwwTimestamp.js';

export const INTEGRITY_STATUS = Object.freeze({
  IN_PARITY: 'in-parity',
  LOCAL_ONLY: 'local-only',
  PEER_ONLY: 'peer-only',
  DIVERGED: 'diverged',
  ASSETS_MISSING: 'assets-missing',
  METADATA_MISSING: 'metadata-missing',
  UNKNOWN: 'unknown',
});

const sortedHashes = (a) => [...(Array.isArray(a) ? a : [])].sort();

const hashesEqual = (a, b) => {
  const sa = sortedHashes(a);
  const sb = sortedHashes(b);
  return sa.length === sb.length && sa.every((h, i) => h === sb[i]);
};

// Different strings can be an LWW tie at millisecond precision, but a clock
// alone cannot prove that the two record bodies match.
const sameLwwTime = (a, b) => {
  const parsed = parseTsMs(a);
  return parsed !== null && parsed === parseTsMs(b);
};

/**
 * Pure diff of two manifest lists.
 *
 * Each entry shape:
 * `{ id, name?, updatedAt, deleted?, assetHashes, metadataMissing? }`.
 *
 * Tombstone handling: when BOTH sides are tombstoned (deleted === true) the
 * pair is omitted from the output entirely — both agree the record is gone, so
 * there's nothing to reconcile. A live-vs-tombstoned mismatch IS surfaced as
 * LOCAL_ONLY / PEER_ONLY (the live side still holds a record the other side
 * deleted), so the user can decide whether to propagate the delete or re-push.
 *
 * @param {Array} localList  - Local manifest rows.
 * @param {Array} remoteList - Remote manifest rows.
 * `assessment: 'unknown'` plus `reason: 'timestamp-tie'` marks an LWW
 * timestamp tie whose record contents cannot be verified. Its `status` stays
 * `diverged` as a conservative fallback for older consumers.
 *
 * @returns {Array<{id:string, name:string, status:string, assessment?:string, reason?:string}>}
 */
export function computeRecordIntegrity(localList, remoteList) {
  const byId = new Map();

  for (const l of localList || []) {
    byId.set(l.id, { id: l.id, name: l.name, local: l, remote: null });
  }

  for (const r of remoteList || []) {
    const cur = byId.get(r.id) || { id: r.id, name: r.name, local: null, remote: null };
    cur.remote = r;
    if (!cur.name) cur.name = r.name;
    byId.set(r.id, cur);
  }

  const out = [];

  for (const { id, name, local, remote } of byId.values()) {
    const localLive = local && local.deleted !== true;
    const remoteLive = remote && remote.deleted !== true;

    let status;
    let assessment;
    let reason;
    if (localLive && !remoteLive) {
      status = INTEGRITY_STATUS.LOCAL_ONLY;
    } else if (!localLive && remoteLive) {
      status = INTEGRITY_STATUS.PEER_ONLY;
    } else if (!localLive && !remoteLive) {
      // Both tombstoned — agree on deletion, omit from output.
      continue;
    } else if (local.updatedAt !== remote.updatedAt && !sameLwwTime(local.updatedAt, remote.updatedAt)) {
      status = INTEGRITY_STATUS.DIVERGED;
    } else if (!hashesEqual(local.assetHashes, remote.assetHashes)) {
      status = INTEGRITY_STATUS.ASSETS_MISSING;
    } else if (local.metadataMissing === true || remote.metadataMissing === true) {
      status = INTEGRITY_STATUS.METADATA_MISSING;
    } else if (local.updatedAt !== remote.updatedAt) {
      // Keep the existing status for clients that do not know the added
      // assessment; it is safer for them to retain the conservative warning.
      status = INTEGRITY_STATUS.DIVERGED;
      assessment = INTEGRITY_STATUS.UNKNOWN;
      reason = 'timestamp-tie';
    } else {
      status = INTEGRITY_STATUS.IN_PARITY;
    }

    out.push({ id, name: name || id, status, ...(assessment ? { assessment, reason } : {}) });
  }

  return out;
}
