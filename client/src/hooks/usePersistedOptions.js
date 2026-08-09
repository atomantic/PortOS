import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Registry for "saved default + per-run override" options — the scaffold every
 * autopilot-style option used to hand-copy seven times (a default const, a
 * `useState`, an `editedRef`, an `edit*` callback, a hydrate-if-untouched line,
 * an override-collect line, and a `start()` dep-array entry). Missing any one of
 * those is a silent bug: an untouched field clobbers a higher saved setting, or
 * an edited one never reaches the run. Here a whole option is ONE spec entry.
 *
 * The contract each spec buys you:
 * - **Untouched fields never persist.** `hydrate()` only writes fields the user
 *   hasn't edited, so a slow settings load can't clobber a fast edit and an
 *   unedited display default never overwrites a saved value.
 * - **Only edited fields become overrides.** `collectOverrides()` emits exactly
 *   the edited keys, clamped through the SAME `clamp` the input uses on blur —
 *   so the value sent can't drift from the value shown.
 * - **No stale closures.** `edit` / `hydrate` / `collectOverrides` / `inputProps`
 *   are identity-stable and read live state through refs, so a caller's
 *   `useCallback` needs one dep (the registry) instead of one per option.
 *
 * @param {Record<string, {
 *   defaultValue: any,
 *   read?: (raw: any) => any,   // undefined = "not a valid saved value" → defaultValue
 *   clamp?: (v: any) => any,    // applied on blur-persist and override-collect
 *   persistOnEdit?: boolean,    // booleans/selects with no blur event
 * }>} specs Keyed by the SETTING key sent to the server. Treated as constant —
 *   define it at module scope (later renders keep the first spec object).
 * @param {(patch: Record<string, any>) => any} [persist] Called with `{ key: value }`
 *   when a `persistOnEdit` option changes, and handed to `inputProps().persist`.
 *   Read through a ref, so passing a fresh closure each render is fine.
 */
export default function usePersistedOptions(specs, persist) {
  // Specs are a constant table; pinning them keeps every returned callback
  // identity-stable (the whole point — a caller's dep array stays 1 entry).
  const specsRef = useRef(specs);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const [values, setValues] = useState(() => Object.fromEntries(
    Object.entries(specsRef.current).map(([key, spec]) => [key, spec.defaultValue]),
  ));
  // Live mirror so `collectOverrides` / `inputProps` (called from an async start
  // handler, or in the same event frame as an edit) never read a stale value.
  // `edit` and `hydrate` write it SYNCHRONOUSLY — waiting for the re-render would
  // let a blur-then-click send the pre-edit value as the run's override.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // Per-field dirty flags. Until a field is edited its input shows a display
  // default we must NOT persist or send.
  const editedRef = useRef({});

  const edit = useCallback((key, value) => {
    editedRef.current[key] = true;
    valuesRef.current = { ...valuesRef.current, [key]: value };
    setValues(valuesRef.current);
    // Persist OUTSIDE any state updater — an updater can run twice under
    // StrictMode and would double-fire the PATCH.
    if (specsRef.current[key]?.persistOnEdit) persistRef.current?.({ [key]: value });
  }, []);

  /** Apply loaded settings to every field the user hasn't edited. */
  const hydrate = useCallback((saved) => {
    const source = saved || {};
    const next = { ...valuesRef.current };
    let changed = false;
    for (const [key, spec] of Object.entries(specsRef.current)) {
      if (editedRef.current[key]) continue;
      const read = spec.read ? spec.read(source[key]) : source[key];
      // `undefined` means absent-or-invalid — fall back to the default rather
      // than letting a missing setting read as an intentional clear.
      const value = read === undefined ? spec.defaultValue : read;
      if (next[key] !== value) { changed = true; next[key] = value; }
    }
    if (!changed) return; // no-op load — don't re-render
    valuesRef.current = next;
    setValues(next);
  }, []);

  /** `{ settingKey: clampedValue }` for the EDITED fields only. */
  const collectOverrides = useCallback(() => {
    const out = {};
    for (const [key, spec] of Object.entries(specsRef.current)) {
      if (!editedRef.current[key]) continue;
      const value = valuesRef.current[key];
      out[key] = spec.clamp ? spec.clamp(value) : value;
    }
    return out;
  }, []);

  /**
   * Props for a controlled numeric field: value + a setter that marks the field
   * edited, plus the spec's own clamp and the persist callback — so the value an
   * input clamps on blur can't drift from the one `collectOverrides` sends.
   */
  const inputProps = useCallback((key) => ({
    settingKey: key,
    value: valuesRef.current[key],
    setValue: (v) => edit(key, v),
    clamp: specsRef.current[key].clamp,
    persist: (patch) => persistRef.current?.(patch),
  }), [edit]);

  return useMemo(
    () => ({ values, edit, hydrate, collectOverrides, inputProps }),
    [values, edit, hydrate, collectOverrides, inputProps],
  );
}

/** Saved-value readers. Each returns `undefined` for "absent or not this type". */
export const readInteger = (raw) => (Number.isInteger(raw) ? raw : undefined);
export const readNumber = (raw) => (Number.isFinite(raw) ? raw : undefined);
export const readBoolean = (raw) => (typeof raw === 'boolean' ? raw : undefined);
