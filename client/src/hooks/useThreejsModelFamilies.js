/**
 * Three.js subject-family options served by `/api/threejs-models/families` as `{ families, status,
 * retry }` (`status`: `loading` / `ready` / `error`), plus the exported `GENERAL_FAMILY_ID` default.
 *
 * Use when: Any surface picking a subject family — the taxonomy is served, never mirrored client-side,
 * so the picker and the generation prompt cannot drift. Pass `status` and `retry` to
 * `SubjectFamilySelect`, which hides while loading and shows a Retry on error.
 */

import { useCallback, useEffect, useState } from 'react';
import { listThreejsModelFamilies } from '../services/apiThreejsModels.js';

/**
 * The default "no checklist" subject family; mirrors the server id so a form has a valid value before the taxonomy resolves (the option list itself is always served, never mirrored).
 */
export const GENERAL_FAMILY_ID = 'general';

/**
 * A family id the served taxonomy actually offers, or `general`. A record can hold a family this install no longer ships (written by a larger-taxonomy build, then downgraded or restored): fed to a `<select>` it leaves no matching option, so the screen stops agreeing with the state and picking the option it appears to show fires no change event. The rendered and submitted values both go through here.
 * An empty list means the taxonomy has not resolved (or failed): the stored id passes through untouched rather than flattening to `general`, since no picker is on screen to disagree and the record's family should survive a refine.
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
