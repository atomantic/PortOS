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
 */
export default function useSettingsForm(initialValues) {
  const [state, dispatch] = useReducer(reducer, initialValues, (values) => ({ values, saved: values }));
  const set = useCallback((path, value) => dispatch({ type: 'set', path, value }), []);
  const load = useCallback((values) => dispatch({ type: 'load', values }), []);
  const markSaved = useCallback((values, submitted) => dispatch({ type: 'markSaved', values, submitted }), []);
  const isDirty = useMemo(() => !sameJsonShape(state.values, state.saved), [state]);
  return { values: state.values, saved: state.saved, isDirty, set, load, markSaved };
}
