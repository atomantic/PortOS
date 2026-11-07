import { readJSONFileStrict, unreadableStoreError } from './jsonIo.js';

/**
 * Read a machine-local incremental sync-state file without ever rewinding its
 * high-water cursor. Only a genuinely absent file (or one lacking the cursor
 * key, a legacy shape) starts at 0; an unreadable file, non-object root, or a
 * cursor that is not a non-negative integer throws UNREADABLE_STORE. Resetting
 * to 0 would re-ingest erased history and overwrite the real cursor on the next
 * write. `lastRunAt`/`lastResult` stay lenient — they never gate ingestion.
 */
export async function readSyncCursorState(filePath, cursorKey) {
  const absent = Symbol('absent sync state');
  const { ok, value } = await readJSONFileStrict(filePath, absent, { allowArray: false });
  if (!ok) throw unreadableStoreError(filePath);
  if (value !== absent && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw unreadableStoreError(filePath);
  }
  const cursor = value?.[cursorKey];
  if (cursor !== undefined && !(Number.isInteger(cursor) && cursor >= 0)) {
    throw unreadableStoreError(filePath);
  }
  return {
    [cursorKey]: cursor ?? 0,
    lastRunAt: value?.lastRunAt || null,
    lastResult: value?.lastResult || null,
  };
}

/**
 * Status-endpoint companion: an unreadable cursor file must not blank the
 * settings page. Returns the state with a null cursor plus `stateError`.
 */
export async function readSyncCursorStateForStatus(filePath, cursorKey) {
  const state = await readSyncCursorState(filePath, cursorKey).catch((err) => {
    if (err?.code !== 'UNREADABLE_STORE') throw err;
    return null;
  });
  if (state) return { state };
  return {
    state: { [cursorKey]: null, lastRunAt: null, lastResult: null },
    stateError: 'UNREADABLE_STORE',
  };
}
