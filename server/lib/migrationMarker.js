/**
 * Shared marker-file helpers for one-time migration / repair / reconcile scripts.
 *
 * ~11 boot-time scripts under server/scripts/ gate their idempotent walk on a
 * small JSON "applied" / "migrated" marker under data/. They used to hand-roll
 * three near-identical helpers each — `markerExists` / `readMarker` /
 * `writeMarker` — built on `readFile(...).catch(() => null)` and a non-atomic
 * `writeFile(JSON.stringify(...))`. This module collapses those into the shared
 * `tryReadFile` / `atomicWrite` primitives from fileUtils, so a crash mid-write
 * can't leave a truncated marker that a later boot misreads as "not applied".
 *
 * All three operate on a marker filename relative to PATHS.data. Pass just the
 * filename (e.g. 'universes.migrated.json'); the helper anchors it under data/.
 */

import { join } from 'path';
import { PATHS, tryReadFile, atomicWrite, safeJSONParse } from './fileUtils.js';

function markerPath(filename) {
  return join(PATHS.data, filename);
}

/**
 * True when the marker file is present (any readable content), else false.
 * Mirrors the old `raw != null` boolean gate used by the migrate*ToDB scripts.
 * @param {string} filename - Marker filename relative to data/.
 * @returns {Promise<boolean>}
 */
export async function markerExists(filename) {
  const raw = await tryReadFile(markerPath(filename));
  return raw != null;
}

/**
 * Parsed marker payload, or null when the file is missing / empty / not valid
 * JSON. Mirrors the old `readMarker` (read → JSON.parse with a null fallback)
 * used by the backfill / repair / reconcile scripts.
 * @param {string} filename - Marker filename relative to data/.
 * @returns {Promise<any|null>}
 */
export async function readMarker(filename) {
  const raw = await tryReadFile(markerPath(filename));
  if (raw == null) return null;
  return safeJSONParse(raw, null);
}

/**
 * Atomically write the marker payload as pretty-printed JSON. Uses fileUtils'
 * `atomicWrite` (temp file + rename) so a crash can't leave a partial marker.
 * @param {string} filename - Marker filename relative to data/.
 * @param {object} payload - JSON-serializable marker contents.
 * @returns {Promise<void>}
 */
export async function writeMarker(filename, payload) {
  await atomicWrite(markerPath(filename), payload);
}
