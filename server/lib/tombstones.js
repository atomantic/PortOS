/**
 * Generic TOMBSTONE helpers for add-only cross-machine merges.
 *
 * Most PortOS peer merges are union/add-only: a record present on either side
 * survives. That is the right default for edits (no data is ever lost), but it
 * makes DELETES unrepresentable — the peer that still holds the record simply
 * re-adds it on the next sync and the user's delete is undone forever.
 *
 * A tombstone is the missing signal: `{ <keyField>: string, deletedAt: ISO }`,
 * meaning "this key was deliberately removed at this instant". Merges union the
 * tombstone list in BOTH directions (so a delete on machine A also removes the
 * record on machine B) and suppress any record the tombstone covers.
 *
 * The re-create case is what makes tombstones subtle: a record deleted at T1 and
 * then legitimately re-created at T2 must NOT stay suppressed forever. That is
 * why tombstones are timestamped rather than a bare key list — a record whose
 * own creation stamp is STRICTLY NEWER than the tombstone supersedes it, and
 * `pruneTombstones` then drops the tombstone so it can't resurface from a peer
 * that has not seen the re-create yet. `supersedingTimestamp` keeps that
 * ordering honest when the re-create lands in the same millisecond as the
 * delete (or when a peer's clock ran ahead).
 *
 * Timestamp comparison goes through `lwwTimestamp.js` so the polarity matches
 * every other sync merge (parse to epoch ms; unparseable loses; ties break to
 * the incumbent) rather than a lexicographic string compare.
 *
 * Choose the key field carefully: it must mean the same thing on every machine.
 * Locally-minted record ids usually do NOT (the same logical record can carry a
 * different id per install), which is why the Digital Twin documents tombstone
 * on `filename`.
 */

import { isPlainObject } from './objects.js';
import { parseTsMs, compareNewerWins } from './lwwTimestamp.js';

// Tombstones live inside a record that syncs in full on every cycle, so the list
// is capped. Oldest deletions fall off first; a delete that old has long since
// reached every peer (or the peer has been offline longer than the tombstone
// retention, in which case a resurrection is the lesser evil vs. unbounded meta).
export const DEFAULT_TOMBSTONE_LIMIT = 200;

function sortTombstones(list, keyField) {
  return [...list].sort((a, b) => {
    const am = parseTsMs(a.deletedAt) ?? 0;
    const bm = parseTsMs(b.deletedAt) ?? 0;
    if (am !== bm) return bm - am; // newest first
    const ak = a[keyField];
    const bk = b[keyField];
    return ak < bk ? -1 : ak > bk ? 1 : 0; // stable across peers
  });
}

/**
 * Coerce arbitrary (peer-supplied, possibly legacy) input into a clean, sorted,
 * de-duplicated tombstone list. Entries without a non-empty string key or
 * without a parseable `deletedAt` are dropped — an undatable tombstone can never
 * win a supersession comparison anyway, so keeping it would only grow the list.
 * Duplicate keys collapse to the NEWEST deletion.
 */
export function normalizeTombstones(value, keyField = 'key') {
  if (!Array.isArray(value)) return [];
  const byKey = new Map();
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    const key = raw[keyField];
    if (typeof key !== 'string' || key === '') continue;
    if (parseTsMs(raw.deletedAt) === null) continue;
    const existing = byKey.get(key);
    if (!existing || compareNewerWins(raw.deletedAt, existing.deletedAt)) {
      byKey.set(key, { [keyField]: key, deletedAt: raw.deletedAt });
    }
  }
  return sortTombstones([...byKey.values()], keyField);
}

/** The deletion stamp recorded for `key`, or null when it is not tombstoned. */
export function tombstoneTimestamp(list, key, keyField = 'key') {
  if (!Array.isArray(list)) return null;
  let newest = null;
  for (const raw of list) {
    if (!isPlainObject(raw) || raw[keyField] !== key) continue;
    if (parseTsMs(raw.deletedAt) === null) continue;
    if (newest === null || compareNewerWins(raw.deletedAt, newest)) newest = raw.deletedAt;
  }
  return newest;
}

/**
 * True when `key` is tombstoned AND the record's own `createdAt` does not
 * supersede the deletion. A record with no (or an unparseable) creation stamp
 * never supersedes — records that predate the tombstone convention are exactly
 * the ones a delete was meant to remove.
 */
export function isTombstoned(list, key, createdAt, keyField = 'key') {
  const deletedAt = tombstoneTimestamp(list, key, keyField);
  if (deletedAt === null) return false;
  return !compareNewerWins(createdAt, deletedAt);
}

/** Record (or refresh) a tombstone for `key`. Returns a new normalized list. */
export function recordTombstone(list, key, { keyField = 'key', deletedAt, limit = DEFAULT_TOMBSTONE_LIMIT } = {}) {
  const stamp = parseTsMs(deletedAt) === null ? new Date().toISOString() : deletedAt;
  const kept = normalizeTombstones(list, keyField).filter((t) => t[keyField] !== key);
  return sortTombstones([...kept, { [keyField]: key, deletedAt: stamp }], keyField).slice(0, limit);
}

/** Drop the tombstone for `key` (the record came back). Returns a new list. */
export function clearTombstone(list, key, keyField = 'key') {
  return normalizeTombstones(list, keyField).filter((t) => t[keyField] !== key);
}

/** Structural equality for two normalized tombstone lists (order-sensitive). */
export function tombstonesEqual(a, b, keyField = 'key') {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t[keyField] === b[i][keyField] && t.deletedAt === b[i].deletedAt);
}

/**
 * Union two tombstone lists (newest deletion per key wins) so a delete performed
 * on either machine reaches the other. `changed` is structural, so a merge that
 * only reorders or truncates still reports honestly.
 */
export function mergeTombstones(localArr, remoteArr, { keyField = 'key', limit = DEFAULT_TOMBSTONE_LIMIT } = {}) {
  const local = normalizeTombstones(localArr, keyField);
  const map = new Map(local.map((t) => [t[keyField], t]));
  for (const rt of normalizeTombstones(remoteArr, keyField)) {
    const lt = map.get(rt[keyField]);
    if (!lt || compareNewerWins(rt.deletedAt, lt.deletedAt)) map.set(rt[keyField], rt);
  }
  const merged = sortTombstones([...map.values()], keyField).slice(0, limit);
  return { merged, changed: !tombstonesEqual(merged, local, keyField) };
}

/**
 * Drop tombstones that a surviving record has superseded (its creation stamp is
 * strictly newer than the deletion). Without this the tombstone would keep
 * bouncing back from a peer that has not seen the re-create yet, and the
 * re-created record would be reaped on every subsequent cycle.
 */
export function pruneTombstones(list, records, { keyField = 'key', recordKeyField = keyField, timestampField = 'createdAt' } = {}) {
  const live = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) continue;
    const key = record[recordKeyField];
    if (typeof key !== 'string' || key === '') continue;
    const stamp = record[timestampField];
    if (!live.has(key) || compareNewerWins(stamp, live.get(key))) live.set(key, stamp);
  }
  return normalizeTombstones(list, keyField)
    .filter((t) => !compareNewerWins(live.get(t[keyField]), t.deletedAt));
}

/**
 * A creation stamp guaranteed to supersede `priorDeletedAt`. Normally just
 * `now`; when the re-create lands in the same millisecond as the delete (or the
 * deleting peer's clock ran ahead) it steps one millisecond past the tombstone
 * so the re-created record is not suppressed on the next merge.
 */
export function supersedingTimestamp(priorDeletedAt, now = new Date().toISOString()) {
  const priorMs = parseTsMs(priorDeletedAt);
  const nowMs = parseTsMs(now);
  if (priorMs === null || nowMs === null || nowMs > priorMs) return now;
  return new Date(priorMs + 1).toISOString();
}
