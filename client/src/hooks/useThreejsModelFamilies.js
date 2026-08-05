import { useEffect, useState } from 'react';
import { listThreejsModelFamilies } from '../services/api';

/**
 * The default "no checklist" subject family. Mirrors the server id so a form has
 * a valid value before the taxonomy resolves; the option list itself is always
 * served rather than mirrored, so the picker and the prompt cannot drift.
 */
export const GENERAL_FAMILY_ID = 'general';

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
