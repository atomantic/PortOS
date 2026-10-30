import { useCallback, useEffect, useState } from 'react';
import { listThreejsModelFamilies } from '../services/api';

/**
 * The default "no checklist" subject family. Mirrors the server id so a form has
 * a valid value before the taxonomy resolves; the option list itself is always
 * served rather than mirrored, so the picker and the prompt cannot drift.
 */
export const GENERAL_FAMILY_ID = 'general';

/**
 * A family id the served taxonomy actually offers, or `general`.
 *
 * A record can hold a family this install no longer ships — written by a build
 * with a larger taxonomy, then downgraded or restored from a backup. Feeding
 * that id to a `<select>` leaves the control with no matching option, so what is
 * on screen stops agreeing with the state behind it and picking the option it
 * appears to be showing fires no change event at all. Both the rendered value
 * and the value submitted go through here so they cannot disagree.
 *
 * An empty list means the taxonomy has not resolved (or failed): the stored id
 * is passed through untouched rather than being flattened to `general`, since
 * there is no picker on screen to disagree with and the record's own family
 * should survive a refine.
 */
export const resolveFamilyId = (families, value) => (
  families.length === 0 || families.some((option) => option.id === value)
    ? value
    : GENERAL_FAMILY_ID
);

/**
 * The Three.js subject-family options, with the read's status so a picker can
 * tell "still loading" from "failed" from "served an empty list".
 *
 * `status` is `loading`, `ready`, or `error`; `retry()` re-issues the read. A
 * failure never blocks create or refine — callers fall back to the general
 * family, which `resolveFamilyId` already handles.
 */
export default function useThreejsModelFamilies() {
  const [state, setState] = useState({ status: 'loading', families: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    listThreejsModelFamilies({ silent: true })
      .then((options) => {
        if (active) setState({ status: 'ready', families: Array.isArray(options) ? options : [] });
      })
      .catch(() => {
        if (active) setState({ status: 'error', families: [] });
      });
    return () => { active = false; };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading', families: [] });
    setAttempt((count) => count + 1);
  }, []);

  return { families: state.families, status: state.status, retry };
}
