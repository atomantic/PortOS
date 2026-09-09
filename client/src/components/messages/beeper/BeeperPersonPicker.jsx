import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, UserPlus } from 'lucide-react';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../../hooks/usePopoverPosition.js';

// Matches the list's old `w-48` — kept as a JS constant now that width is set
// via `usePopoverPosition` instead of a Tailwind width utility.
const LIST_WIDTH = 192;

/**
 * Search-first Tribe-person picker for the Beeper participant-linking path
 * (#98 part B). It replaces the bare full-roster `<select>` `ParticipantRow`
 * used to render in `BeeperThread.jsx` — a plain dropdown does not scale past
 * a handful of names, and it gave no way to type-to-find.
 *
 * The roster (`people`) is loaded once per chat surface already
 * (`BeeperChatSurface.jsx`'s `people` state, `api.getTribePeople({ silent: true })`
 * with no `?search=` param) — filtering it client-side here avoids adding a
 * network round-trip per keystroke for a list this surface already holds in
 * full. The filter itself is still debounced (≥200ms) so a fast typist does
 * not re-run it on every keystroke; the server's own `?search=` param
 * (`GET /tribe/people`) stays available for a future caller with a roster
 * too large to hold client-side.
 *
 * Selecting a result IS the link action — there is no separate "Link" button
 * to press afterwards, unlike the `<select>` this replaces. "Create new…" is
 * always the LAST row, below every match, and calls the exact same
 * `onCreateNew` callback the old "New" button called — #97 changes what that
 * callback DOES (a confirm-and-rename form instead of an immediate create),
 * not this wiring.
 *
 * `autoFocus` (#97 part B) is only ever passed `true` from "Change" on an
 * already-linked participant row, so re-pointing a link opens straight into
 * a focused, ready-to-type input rather than requiring an extra click.
 *
 * The results list is portaled to `document.body` and fixed-positioned via
 * `usePopoverPosition` (#105): `BeeperThread.jsx` renders this inside a
 * `max-h-40 overflow-y-auto` participants roster, and an absolutely
 * positioned child cannot escape an `overflow: auto` ancestor — the list was
 * extending that roster's own scroll area instead of floating over it. This
 * is a combobox, not a menu: focus never leaves the input while the list is
 * open, so closing is still driven by `onBlur` (`closeList`) exactly as
 * before, and every pointer target inside the portaled list (not just each
 * row) calls `preventDefault` on `mousedown` so clicking anywhere in it —
 * padding, the "No matches" row, the scrollbar — counts as inside the picker
 * rather than blurring the input out from under a would-be selection.
 */
export default function BeeperPersonPicker({
  id,
  label,
  people,
  onSelectPerson,
  onCreateNew,
  disabled = false,
  placeholder = 'Link to…',
  autoFocus = false,
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const optionId = (index) => `${listboxId}-option-${index}`;
  const wrapperRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const matches = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    const list = needle
      ? (people || []).filter((person) => (person.name || '').toLowerCase().includes(needle))
      : (people || []);
    // A ceiling, not a hint that more exist — keeps a very large roster from
    // rendering an unbounded results list.
    return list.slice(0, 50);
  }, [people, debouncedQuery]);

  // "Create new…" is always present and always LAST; the row count for
  // keyboard purposes is every match plus that one trailing row.
  const createNewIndex = matches.length;
  const rowCount = matches.length + 1;

  // Right-aligned below the input (flipping above only when there's no room
  // below), re-measured whenever the match count changes the list's height —
  // typing can grow or shrink it between "No matches" and a full page of
  // rows — so an above/below flip made while the list was short doesn't
  // paint stale once it grows.
  const { popoverRef: listRef, style: listStyle } = usePopoverPosition({
    open,
    width: LIST_WIDTH,
    minWidth: LIST_WIDTH,
    gap: 4,
    position: 'below',
    anchorRef: wrapperRef,
    contentDeps: [matches.length],
  });

  const closeList = () => { setOpen(false); setActiveIndex(0); };

  const selectRow = (index) => {
    if (index === createNewIndex) onCreateNew();
    else if (matches[index]) onSelectPerson(matches[index].id);
    setQuery('');
    closeList();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      setActiveIndex((index) => (index + 1) % rowCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      setActiveIndex((index) => (index - 1 + rowCount) % rowCount);
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      selectRow(activeIndex);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeList();
    }
  };

  return (
    <div className="relative min-w-[9rem] max-w-[12rem]" ref={wrapperRef}>
      {label && <label htmlFor={id} className="sr-only">{label}</label>}
      <div className="flex items-center gap-1 rounded border border-port-border bg-port-bg px-1.5 py-1">
        <Search size={11} className="shrink-0 text-gray-500" aria-hidden="true" />
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          disabled={disabled}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={closeList}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-gray-200 placeholder:text-gray-500 focus:outline-none disabled:opacity-50"
        />
      </div>
      {open && createPortal(
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          // The input owns focus the whole time this is open (see the class
          // doc comment) — any pointerdown here must not blur it, or the
          // input's own `onBlur` would close the list before a click on it
          // could land. Each row below already prevents default for the
          // same reason; this catches everything else in the portal (padding,
          // "No matches", the scrollbar).
          onMouseDown={(event) => event.preventDefault()}
          className="fixed z-[100] max-h-48 overflow-y-auto rounded border border-port-border bg-port-card py-1 shadow-lg"
          style={{
            left: listStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: listStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: listStyle?.width ?? `${LIST_WIDTH}px`,
            visibility: listStyle ? 'visible' : 'hidden',
          }}
        >
          {matches.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-gray-500">No matches</li>
          )}
          {matches.map((person, index) => (
            <li
              key={person.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              // `onMouseDown` with `preventDefault`, not `onClick`: a click
              // fires AFTER the input's own `onBlur`, which would have
              // already closed (and unmounted) this list.
              onMouseDown={(event) => { event.preventDefault(); selectRow(index); }}
              className={`cursor-pointer truncate px-2 py-1 text-[11px] ${
                index === activeIndex ? 'bg-port-accent/20 text-white' : 'text-gray-200'
              }`}
            >
              {person.name}
            </li>
          ))}
          <li
            id={optionId(createNewIndex)}
            role="option"
            aria-selected={createNewIndex === activeIndex}
            onMouseDown={(event) => { event.preventDefault(); selectRow(createNewIndex); }}
            className={`flex items-center gap-1 border-t border-port-border/60 px-2 py-1 text-[11px] ${
              createNewIndex === activeIndex ? 'bg-port-accent/20 text-white' : 'text-gray-300'
            }`}
          >
            <UserPlus size={10} aria-hidden="true" />
            Create new…
          </li>
        </ul>,
        document.body,
      )}
    </div>
  );
}
