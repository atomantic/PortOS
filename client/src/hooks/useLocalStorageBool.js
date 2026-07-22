import { useCallback, useState } from 'react';
import {
  safeReadJsonStorage,
  safeReadStorage,
  safeWriteJsonStorage,
  safeWriteStorage,
} from '../lib/safeStorage.js';

// Boolean-valued `useState` mirror that round-trips through `localStorage`.
//
// History: six pages independently re-implemented this with subtly different
// encodings — `'1'/'0'`, `'true'/'false'`, sometimes wrapped in `try/catch` for
// sandboxed-storage failures, sometimes not. We accept both legacy encodings
// on read so swapping any one call site to the hook is non-breaking; writes
// are pinned to whichever format the page already uses (`format` option).
//
// `format`: `'1'` writes `'1'`/`'0'`; `'true'` writes `'true'`/`'false'`.
// Reads always treat either `'1'` or `'true'` as truthy so existing values
// keep working when a page switches its `format` later.
export function useLocalStorageBool(key, defaultValue = false, { format = '1' } = {}) {
  const [value, setValue] = useState(() => readBool(key, defaultValue));

  const write = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      const bool = !!resolved;
      writeBool(key, bool, format);
      return bool;
    });
  }, [key, format]);

  return [value, write];
}

// JSON-blob variant: hydrates from localStorage on first render, persists on
// every change via the setter. `defaultValue` is returned both when the key is
// missing and when JSON.parse fails (corrupted/old-shape value).
//
// Pass `{ parse: (raw) => merged }` to migrate older shapes — `parse` is only
// invoked when JSON.parse succeeded, so it sees the raw stored object. Use it
// to spread fresh defaults under saved values (additive shape changes) so a
// new field appears for users with pre-existing storage.
export function useLocalStoragePersisted(key, defaultValue, { parse } = {}) {
  const [value, setValue] = useState(() => {
    const raw = readJsonRaw(key);
    if (raw === undefined) return defaultValue;
    return parse ? parse(raw) : raw;
  });

  const write = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      writeJson(key, resolved);
      return resolved;
    });
  }, [key]);

  return [value, write];
}

function readBool(key, defaultValue) {
  const raw = safeReadStorage(key);
  if (raw === null) return defaultValue;
  return raw === '1' || raw === 'true';
}

function writeBool(key, bool, format) {
  safeWriteStorage(key, format === 'true' ? String(bool) : (bool ? '1' : '0'));
}

// `safeReadJsonStorage` collapses "missing" and "corrupt" into its fallback, so
// pass a private sentinel rather than `undefined` — `undefined` would hit the
// helper's own `fallback = null` default and be indistinguishable from a stored
// `null`, which we must return verbatim.
const MISSING = Symbol('missing');

// Returns `undefined` to distinguish "key missing / parse failed" (caller
// applies the default) from a stored `null`. useLocalStoragePersisted uses
// this so it can run an optional `parse` migration only on real stored data.
function readJsonRaw(key) {
  const value = safeReadJsonStorage(key, MISSING);
  return value === MISSING ? undefined : value;
}

function writeJson(key, value) {
  safeWriteJsonStorage(key, value);
}
