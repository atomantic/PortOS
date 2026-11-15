/**
 * `{ values, saved, isDirty, set(path, value), load(values), markSaved(values?, submitted?) }` — one
 * reducer holding a settings form's editable values and the saved snapshot they are diffed against.
 *
 * A field is one entry in the loaded object, `set` takes a dotted path or an updater. Use when: A
 * settings tab/drawer with many fields and a Save button (the Media settings drawer) — instead of one
 * `useState` per field plus a hand-maintained `saved` mirror and dirty check.
 */

import { useCallback, useMemo, useReducer } from 'react';

const sameJsonShape = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Immutable write at a dotted path, copying only the containers on the path.
const setAtPath = (object, segments, update) => {
  const [head, ...rest] = segments;
  const current = object?.[head];
  const next = rest.length ? setAtPath(current ?? {}, rest, update) : (typeof update === 'function' ? update(current) : update);
  return { ...(object || {}), [head]: next };
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'set':
      return { ...state, values: setAtPath(state.values, action.path.split('.'), action.value) };
    case 'load':
      return { values: action.values, saved: action.values };
    case 'markSaved': {
      const saved = action.values ?? state.values;
      const submitted = action.submitted ?? state.values;
      // Normalize only fields that still match the submitted snapshot. A save
      // acknowledges that snapshot, not edits made while the request was pending.
      const values = action.submitted ? Object.fromEntries(Object.entries(state.values).map(([key, value]) => [
        key, sameJsonShape(value, submitted[key]) ? saved[key] : value,
      ])) : saved;
      return { values, saved };
    }
    case 'markFieldsSaved': {
      // Partial save: only the patched keys move to the saved snapshot, so an
      // unsaved edit in another section of the same form stays dirty.
      const values = { ...state.values };
      for (const key of Object.keys(action.patch)) {
        if (sameJsonShape(state.values[key], action.submitted[key])) values[key] = action.patch[key];
      }
      return { values, saved: { ...state.saved, ...action.patch } };
    }
    default:
      return state;
  }
};

/**
 * One reducer for a settings form: the editable `values`, the `saved`
 * snapshot they are compared against, and a generic `isDirty`. A field is one
 * entry in the loaded object — no parallel saved mirror, hand-written dirty
 * check or per-field payload assembly to keep in step.
 *
 * - `set(path, value)` writes one field; `path` may be dotted for a nested
 *   map (`'cleaners.local'`), and `value` may be an updater of the current
 *   field value.
 * - `load(values)` replaces both cells (the settings fetch landing).
 * - `markSaved(values?, submitted?)` records the persisted state; pass the
 *   normalized values and the original submitted snapshot for async saves.
 *   Fields edited in the meantime stay visible and dirty; untouched fields
 *   adopt normalization. Omit both to mark the current values saved.
 * - `markFieldsSaved(patch, submitted?)` is `markSaved` for one section of a
 *   form saved on its own: only the patched keys join the saved snapshot.
 * - `comparators` (optional, `{ [topLevelKey]: (a, b) => boolean }`) replaces
 *   the JSON-shape equality for a field whose "unchanged" is looser than
 *   identical, e.g. an order-independent list. Pass a stable object.
 */
export default function useSettingsForm(initialValues, { comparators } = {}) {
  const [state, dispatch] = useReducer(reducer, initialValues, (values) => ({ values, saved: values }));
  const set = useCallback((path, value) => dispatch({ type: 'set', path, value }), []);
  const load = useCallback((values) => dispatch({ type: 'load', values }), []);
  const markSaved = useCallback((values, submitted) => dispatch({ type: 'markSaved', values, submitted }), []);
  const markFieldsSaved = useCallback((patch, submitted = patch) => dispatch({ type: 'markFieldsSaved', patch, submitted }), []);
  const isDirty = useMemo(() => {
    if (!comparators) return !sameJsonShape(state.values, state.saved);
    const keys = new Set([...Object.keys(state.values), ...Object.keys(state.saved)]);
    return [...keys].some((key) => !(comparators[key] || sameJsonShape)(state.values[key], state.saved[key]));
  }, [state, comparators]);
  return { values: state.values, saved: state.saved, isDirty, set, load, markSaved, markFieldsSaved };
}
