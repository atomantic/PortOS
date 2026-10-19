/**
 * Cross-machine identity for MeatSpace health rows (blood / epigenetic / eye
 * records) that federate through the `row-union` snapshot merge (#12432).
 *
 * Before #12432 an id-less eye exam was stamped with `randomUUID()` on each
 * machine's first read, so two machines gave the same exam two ids and every
 * sync appended the peer's copy. Rows created since carry `createdAt`, and
 * their `id` alone is their identity. A row without `createdAt` has unknown
 * provenance — an id-less legacy row, a random stamp, or an id minted before
 * #12432 — so it answers to its own id AND to `legacy-<sha256>` of its content,
 * which every machine computes alike. Two copies that meet only through the
 * content key converge on that key as their id.
 *
 * Pure. Migration 429 calls `normalizeLegacyRows`, so `legacyRowId` IS an
 * on-disk id: changing it would key every peer's rows differently.
 */

import { createHash } from 'crypto';
import { canonicalStringify, isPlainObject } from './objects.js';
import { parseTsMs } from './lwwTimestamp.js';

export const LEGACY_ROW_ID_PREFIX = 'legacy-';

// Per-row deletion markers (`{ id, deletedAt }`) kept at the top level of a
// row-union file, unioned in both directions by the snapshot merge.
export const ROW_TOMBSTONES_KEY = 'rowTombstones';

const hasStringId = (row) => typeof row?.id === 'string' && row.id !== '';

/** Deterministic id for a legacy row: a hash of its content without identity or clock fields. */
export function legacyRowId(row) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = row;
  const digest = createHash('sha256').update(canonicalStringify(content)).digest('hex');
  return `${LEGACY_ROW_ID_PREFIX}${digest.slice(0, 24)}`;
}

/** Every key a row answers to; the content key last. A delete tombstones all of them. */
export function rowIdentityKeys(row) {
  const keys = hasStringId(row) ? [row.id] : [];
  if (row.createdAt === undefined) {
    const contentKey = legacyRowId(row);
    if (!keys.includes(contentKey)) keys.push(contentKey);
  }
  return keys;
}

/** A row's newest clock: `updatedAt`, else `createdAt` (string, or undefined). */
export const rowLiveStamp = (row) => {
  const updated = parseTsMs(row?.updatedAt);
  const created = parseTsMs(row?.createdAt);
  if (updated === null) return created === null ? undefined : row.createdAt;
  if (created === null || updated >= created) return row.updatedAt;
  return row.createdAt;
};

/**
 * Pick one of two copies of the same row: newer live stamp wins, then the
 * larger canonical text. The order is total, so every machine converges on the
 * same copy whichever side is local.
 */
export function preferRowCopy(a, b) {
  const am = parseTsMs(rowLiveStamp(a)) ?? -Infinity;
  const bm = parseTsMs(rowLiveStamp(b)) ?? -Infinity;
  if (am !== bm) return am > bm ? a : b;
  return canonicalStringify(a) >= canonicalStringify(b) ? a : b;
}

/**
 * Collapse copies of one record across `localRows` then `remoteRows`. Each
 * entry of the result is `{ row, keys }` (`keys` is null for a non-object row,
 * which is kept only from the local side). Copies resolve to `preferRowCopy`;
 * copies with different ids that met through the content key take that key as
 * their id.
 *
 * `stampIds` gives an id-less row its content key as its id (eyes.json, whose
 * rows are addressed by id). `keepLocalDuplicates` keeps rows of `localRows`
 * that share a key as separate rows (blood/epigenetic files, whose id-less rows
 * were never deduped locally); only a remote copy is matched against them.
 */
export function mergeRowCopies(localRows, remoteRows = [], { stampIds = false, keepLocalDuplicates = false } = {}) {
  const entries = [];
  const indexByKey = new Map();
  const register = (keys, index) => {
    for (const key of keys) if (!indexByKey.has(key)) indexByKey.set(key, index);
  };
  const add = (row, fromLocal) => {
    if (!isPlainObject(row)) {
      if (fromLocal) entries.push({ row, keys: null });
      return;
    }
    const keys = rowIdentityKeys(row);
    const keyed = stampIds && !hasStringId(row) ? { ...row, id: keys[keys.length - 1] } : row;
    const matchKey = keys.find((key) => indexByKey.has(key));
    if (matchKey === undefined || (keepLocalDuplicates && fromLocal)) {
      register(keys, entries.length);
      entries.push({ row: keyed, keys: new Set(keys) });
      return;
    }
    const entry = entries[indexByKey.get(matchKey)];
    const preferred = preferRowCopy(entry.row, keyed);
    const id = entry.row.id === keyed.id ? preferred.id : matchKey;
    entry.row = preferred.id === id ? preferred : { ...preferred, id };
    for (const key of [...keys, ...rowIdentityKeys(entry.row)]) entry.keys.add(key);
    register(entry.keys, indexByKey.get(matchKey));
  };
  for (const row of Array.isArray(localRows) ? localRows : []) add(row, true);
  for (const row of Array.isArray(remoteRows) ? remoteRows : []) add(row, false);
  return entries;
}

/**
 * Give id-less eye exams their content id and collapse copies of one exam (the
 * duplicates pre-#12432 syncs created). Returns `{ rows, changed }`; rows keep
 * the order of each record's first occurrence.
 */
export function normalizeLegacyRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = mergeRowCopies(list, [], { stampIds: true }).map((entry) => entry.row);
  const changed = out.length !== list.length || out.some((row, i) => row !== list[i]);
  return { rows: out, changed };
}
