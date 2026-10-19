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
 * which every machine computes alike. Copies of one record that carry different
 * ids converge on the smallest of them and keep the rest as `aliasIds`, so an
 * edit or delete still addressed by a retired id finds the row.
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
  const { id: _id, aliasIds: _aliasIds, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = row;
  const digest = createHash('sha256').update(canonicalStringify(content)).digest('hex');
  return `${LEGACY_ROW_ID_PREFIX}${digest.slice(0, 24)}`;
}

const rowIds = (row) => [
  ...(hasStringId(row) ? [row.id] : []),
  ...(Array.isArray(row.aliasIds) ? row.aliasIds.filter((id) => typeof id === 'string' && id !== '') : []),
];

/** Every key a row answers to: id, aliases, then the content key. A delete tombstones all of them. */
export function rowIdentityKeys(row) {
  const keys = [...new Set(rowIds(row))];
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

// One record from a group of its copies: the preferred copy's fields, the
// smallest id as its id and every other id as an alias. Both choices are
// order-free, so every machine reduces the same copies to the same row.
function reduceCopies(members) {
  if (members.length === 1) return members[0];
  const winner = members.map((m) => m.row).reduce(preferRowCopy);
  const ids = [...new Set(members.flatMap((m) => rowIds(m.row)))].sort();
  let row = winner;
  if (ids.length > 0) {
    const { aliasIds: _aliasIds, ...fields } = winner;
    row = ids.length > 1 ? { ...fields, id: ids[0], aliasIds: ids.slice(1) } : { ...fields, id: ids[0] };
  }
  const keys = new Set([...members.flatMap((m) => [...m.keys]), ...rowIdentityKeys(row)]);
  return { row, keys };
}

/**
 * Collapse copies of one record across `localRows` then `remoteRows`. Rows are
 * copies when they share any identity key, transitively, so a row bridging two
 * others joins all three whichever side is local. Each result entry is
 * `{ row, keys }` (`keys` is null for a non-object row, kept only from the
 * local side), in first-occurrence order.
 *
 * `stampIds` gives an id-less row its content key as its id (eyes.json, whose
 * rows are addressed by id). `keepLocalDuplicates` keeps a group's local rows
 * as they are and drops its remote copies (blood/epigenetic files: id-less rows
 * keyed by content alone, which were never deduped locally).
 */
export function mergeRowCopies(localRows, remoteRows = [], { stampIds = false, keepLocalDuplicates = false } = {}) {
  const items = [];
  const add = (row, local) => {
    if (!isPlainObject(row)) {
      if (local) items.push({ row, keys: null, local });
      return;
    }
    const keys = rowIdentityKeys(row);
    const keyed = stampIds && !hasStringId(row) ? { ...row, id: keys[keys.length - 1] } : row;
    items.push({ row: keyed, keys: new Set(keys), local });
  };
  for (const row of Array.isArray(localRows) ? localRows : []) add(row, true);
  for (const row of Array.isArray(remoteRows) ? remoteRows : []) add(row, false);

  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const ownerByKey = new Map();
  items.forEach((item, i) => {
    for (const key of item.keys ?? []) {
      if (!ownerByKey.has(key)) { ownerByKey.set(key, i); continue; }
      const a = find(ownerByKey.get(key));
      const b = find(i);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });

  const groups = new Map();
  items.forEach((item, i) => {
    const root = item.keys ? find(i) : `passthrough-${i}`;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  const entries = [];
  for (const members of groups.values()) {
    if (members[0].keys === null) { entries.push({ row: members[0].row, keys: null }); continue; }
    const locals = members.filter((m) => m.local);
    if (keepLocalDuplicates && locals.length > 0) entries.push(...locals.map(({ row, keys }) => ({ row, keys })));
    else entries.push(reduceCopies(members.map(({ row, keys }) => ({ row, keys }))));
  }
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
