/**
 * Cross-machine identity for MeatSpace health rows (blood / epigenetic / eye
 * records) that federate through the `row-union` snapshot merge (#12432).
 *
 * A row created before rows carried identity has no `id`, or an `id` a machine
 * stamped with `randomUUID()` on first read — two machines holding the same
 * legacy row then gave it two different ids, and every sync duplicated it. A
 * legacy row's identity is therefore derived from its content
 * (`legacy-<sha256>`), so every machine names the same legacy row the same way.
 * Rows created since carry a minted id plus `createdAt`; the id is their
 * identity and two identical rows with different ids stay two records.
 *
 * Pure. Migration 429 imports `normalizeLegacyRows`, so the derivation here IS
 * the on-disk id: changing it would re-key every peer's rows differently.
 */

import { createHash } from 'crypto';
import { canonicalStringify, isPlainObject } from './objects.js';
import { parseTsMs } from './lwwTimestamp.js';

export const LEGACY_ROW_ID_PREFIX = 'legacy-';

// Per-row deletion markers (`{ id, deletedAt }`) kept at the top level of a
// row-union file, unioned in both directions by the snapshot merge.
export const ROW_TOMBSTONES_KEY = 'rowTombstones';

const hasStringId = (row) => typeof row?.id === 'string' && row.id !== '';

export const isLegacyRowId = (id) => typeof id === 'string' && id.startsWith(LEGACY_ROW_ID_PREFIX);

/** Deterministic id for a legacy row: a hash of its content without identity or clock fields. */
export function legacyRowId(row) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = row;
  const digest = createHash('sha256').update(canonicalStringify(content)).digest('hex');
  return `${LEGACY_ROW_ID_PREFIX}${digest.slice(0, 24)}`;
}

/**
 * The identity of a row whose file once stamped random ids (eyes.json). A row
 * without `createdAt` predates minted identity, so a non-legacy id on it is a
 * per-machine random stamp and is replaced by the content-derived id. An
 * edited legacy row keeps its `legacy-` id even though its content moved on.
 */
export function legacyRowIdentity(row) {
  if (hasStringId(row) && (row.createdAt !== undefined || isLegacyRowId(row.id))) return row.id;
  return legacyRowId(row);
}

/** Identity for rows that never had random stamps: their own id, else their content. */
export function contentRowIdentity(row) {
  return hasStringId(row) ? row.id : legacyRowId(row);
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
 * Re-key every row of an id-stamping file to `legacyRowIdentity` and collapse
 * rows that share an identity to their preferred copy (content-identical legacy
 * rows are one record). Order follows each identity's first occurrence.
 * Non-object rows are kept as they are.
 */
export function normalizeLegacyRows(rows) {
  const out = [];
  const indexById = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row)) { out.push(row); continue; }
    const id = legacyRowIdentity(row);
    const keyed = row.id === id ? row : { ...row, id };
    const index = indexById.get(id);
    if (index === undefined) {
      indexById.set(id, out.length);
      out.push(keyed);
    } else {
      out[index] = preferRowCopy(out[index], keyed);
    }
  }
  const changed = out.length !== (Array.isArray(rows) ? rows.length : 0)
    || out.some((row, i) => row !== rows[i]);
  return { rows: out, changed };
}
