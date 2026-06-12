import { useMemo } from 'react';
import { useParams } from 'react-router-dom';

/**
 * Resolve the active tab for a tabbed page from the `:tab` URL param.
 * Returns the param when it names a real tab, otherwise `fallback` — so a
 * hand-edited or stale deep link degrades to the default tab instead of a
 * blank view. Accepts the page's TABS array (`{ id }` objects) or plain id
 * strings.
 */
export function useValidTab(tabs, fallback) {
  const { tab } = useParams();
  const validIds = useMemo(
    () => new Set(tabs.map((t) => (typeof t === 'string' ? t : t.id))),
    [tabs],
  );
  return validIds.has(tab) ? tab : fallback;
}
