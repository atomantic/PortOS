/**
 * Shared marker-file helpers for one-time migration / repair / reconcile scripts (filenames relative to
 * PATHS.data). Atomic writes keep a crash from leaving a truncated marker misread as "not applied".
 */

import { join } from 'path';
import { PATHS, tryReadFile, atomicWrite, safeJSONParse } from './fileUtils.js';

function markerPath(filename) {
  return join(PATHS.data, filename);
}

/**
 * True when the marker file is present (any readable content).
 * @param {string} filename - Marker filename relative to data/.
 * @returns {Promise<boolean>}
 */
export async function markerExists(filename) {
  const raw = await tryReadFile(markerPath(filename));
  return raw != null;
}

/**
 * Parsed marker payload, or null when the file is missing / empty / not valid
 * JSON.
 * @param {string} filename - Marker filename relative to data/.
 * @returns {Promise<any|null>}
 */
export async function readMarker(filename) {
  const raw = await tryReadFile(markerPath(filename));
  if (raw == null) return null;
  return safeJSONParse(raw, null);
}

/**
 * Atomically write the marker payload as pretty-printed JSON.
 * @param {string} filename - Marker filename relative to data/.
 * @param {object} payload - JSON-serializable marker contents.
 * @returns {Promise<void>}
 */
export async function writeMarker(filename, payload) {
  await atomicWrite(markerPath(filename), payload);
}
