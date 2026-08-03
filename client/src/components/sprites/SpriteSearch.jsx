/**
 * Header autocomplete (#2932, reworked): a compact combobox that filters the
 * library by name/id/kind and navigates on Enter/click. It lives in the page
 * header rather than a sidebar, so it renders only the search field + its
 * suggestion popover — full browsing lives in the Library catalog (the bare
 * `/sprites` route), which scales past a scannable sidebar list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside.js';
import { filterSpriteRecords } from '../../lib/spriteRecordGroups.js';
import { groupIconForKind } from './spriteGroupIcons.js';

export default function SpriteSearch({ records, onSelect }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef(null);
  const inputId = 'sprite-search';
  const listId = 'sprite-search-listbox';

  const suggestions = useMemo(() => filterSpriteRecords(records, query), [records, query]);
  const showSuggestions = query.trim().length > 0;

  // Clicking outside dismisses the suggestion popover (clearing the query is the
  // same close path as Escape) instead of leaving a stale list floating open.
  const dismiss = useCallback(() => setQuery(''), []);
  useClickOutside(wrapRef, showSuggestions, dismiss);

  // A changed query invalidates the highlighted row's index.
  useEffect(() => { setActiveIndex(-1); }, [query]);

  const commit = (record) => {
    if (!record) return;
    onSelect(record.id);
    setQuery('');
    setActiveIndex(-1);
  };

  const onKeyDown = (e) => {
    if (!showSuggestions) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setActiveIndex(-1);
    }
  };

  const activeId = activeIndex >= 0 && suggestions[activeIndex]
    ? `sprite-opt-${suggestions[activeIndex].id}` : undefined;

  return (
    <div ref={wrapRef} className="relative w-full sm:w-64">
      <label htmlFor={inputId} className="sr-only">Search sprites</label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
      <input
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search sprites…"
        className="w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-sm text-white"
      />
      {showSuggestions && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching sprites"
          className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg"
        >
          {suggestions.length === 0 ? (
            <li className="px-3 py-2 text-xs text-gray-500">No matches</li>
          ) : suggestions.map((r, i) => {
            const Icon = groupIconForKind(r.kind);
            return (
              <li key={r.id} id={`sprite-opt-${r.id}`} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  onClick={() => commit(r)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm ${i === activeIndex ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'}`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                  <span className="font-medium truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-gray-500 shrink-0">{r.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
