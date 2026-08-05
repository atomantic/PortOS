import { useEffect, useState } from 'react';
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
 * The Three.js subject-family options. A failed fetch yields an empty list, and
 * callers hide the picker rather than rendering an empty select — generation
 * still works and simply gets the general-purpose prompt.
 */
export default function useThreejsModelFamilies() {
  const [families, setFamilies] = useState([]);

  useEffect(() => {
    listThreejsModelFamilies({ silent: true })
      .then((options) => setFamilies(Array.isArray(options) ? options : []))
      .catch(() => setFamilies([]));
  }, []);

  return families;
}
