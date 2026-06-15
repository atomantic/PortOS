import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, Plus, Loader2 } from 'lucide-react';
import useClickOutside from '../hooks/useClickOutside';

/**
 * Generic autocomplete combobox: search a list of `{ id, name, subtitle? }`
 * items or create a new one when the trimmed query doesn't exactly match an
 * existing item. Extracted from UniverseBuilder's `UniverseSelector` so the
 * Importer can reuse the same match-or-create UX for both universe and series
 * selection.
 *
 * Behaviour preserved from the original:
 *  - When the input still mirrors the selected item's name (user opened the
 *    list on a selection), every item is shown instead of filtering down to the
 *    one we then exclude (`isBrowsing`).
 *  - The currently-selected item is excluded from the list — clicking it would
 *    be a no-op.
 *  - Keyboard nav: ArrowUp/Down move the active option, Enter picks/creates,
 *    Escape closes.
 *
 * The parent owns `value` (controlled input). `onPick` receives the full item;
 * `onCreate` (optional) fires when the user commits a non-matching name.
 */
export default function EntityCombobox({
  items,
  selectedId,
  value,
  onChange,
  onPick,
  onCreate,
  busy,
  inputId,
  noun = 'item',
  placeholder,
  createPrefix = 'Create',
  emptyNoItems,
  maxLength = 200,
  className = 'flex-1 min-w-[200px]',
}) {
  const wrapRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Memoize the close callback so useClickOutside doesn't rebind its window
  // listener on every render of the parent (which re-renders per keystroke).
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, open, close);

  const list = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const trimmed = (value || '').trim();
  const lower = trimmed.toLowerCase();

  const listId = `${inputId}-listbox`;
  const optionId = (id) => `${inputId}-option-${id}`;
  const createOptionId = `${inputId}-option-create`;

  // When the input still mirrors the selected item's name, the user is browsing
  // the list (just clicked the chevron) rather than searching — show every item
  // instead of filtering down to the one we then exclude.
  const selectedName = list.find((u) => u.id === selectedId)?.name || '';
  const isBrowsing = !!selectedId && lower === selectedName.trim().toLowerCase();

  // Exclude current — clicking it would be a navigation no-op.
  const filtered = useMemo(() => {
    if (list.length === 0) return [];
    return list
      .filter((u) => u.id !== selectedId)
      .filter((u) => isBrowsing || !lower || (u.name || '').toLowerCase().includes(lower))
      .slice(0, 20);
  }, [list, selectedId, lower, isBrowsing]);

  // exactMatch still considers the current one so renaming-to-same doesn't
  // surface a misleading Create option.
  const exactMatch = useMemo(() => {
    if (!trimmed) return false;
    return list.some((u) => (u.name || '').trim().toLowerCase() === lower);
  }, [list, trimmed, lower]);

  const showCreateOption = !!onCreate && !!trimmed && !exactMatch;
  const totalItems = filtered.length + (showCreateOption ? 1 : 0);

  // Reset on result change to avoid stale Enter target.
  useEffect(() => { setActiveIdx(0); }, [filtered.length, showCreateOption]);

  const activeOptionId = open
    ? (activeIdx < filtered.length
      ? optionId(filtered[activeIdx]?.id)
      : (showCreateOption ? createOptionId : undefined))
    : undefined;

  const handleKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') { setOpen(false); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') {
      setActiveIdx((i) => (totalItems ? Math.min(totalItems - 1, i + 1) : 0));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      setActiveIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      if (activeIdx < filtered.length) {
        const u = filtered[activeIdx];
        if (u) { onPick(u); setOpen(false); }
        e.preventDefault();
      } else if (showCreateOption) {
        onCreate();
        setOpen(false);
        e.preventDefault();
      }
    }
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || `Search ${noun}s or type a new name…`}
          className="w-full bg-port-bg border border-port-border rounded pl-8 pr-9 py-2 text-white focus:outline-none focus:border-port-accent"
          maxLength={maxLength}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
        />
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-white"
          aria-label={open ? `Close ${noun} list` : `Open ${noun} list`}
          tabIndex={-1}
        >
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 z-30 max-h-80 overflow-y-auto bg-port-card border border-port-border rounded shadow-lg"
        >
          {filtered.length === 0 && !showCreateOption && (
            <li className="px-3 py-2 text-xs text-gray-500">
              {list.length === 0
                ? (emptyNoItems || `No ${noun}s yet — type a name.`)
                : 'No matches'}
            </li>
          )}
          {filtered.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                id={optionId(u.id)}
                role="option"
                aria-selected={u.id === selectedId}
                onClick={() => { onPick(u); setOpen(false); }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  i === activeIdx ? 'bg-port-bg text-white' : 'text-gray-300 hover:bg-port-bg'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{u.name}</div>
                  {u.subtitle ? <div className="text-[11px] text-gray-500 truncate">{u.subtitle}</div> : null}
                </div>
                {u.id === selectedId && <Check size={14} className="text-port-accent" />}
              </button>
            </li>
          ))}
          {showCreateOption && (
            <li>
              <button
                type="button"
                id={createOptionId}
                role="option"
                aria-selected={false}
                disabled={busy}
                onClick={() => { onCreate(); setOpen(false); }}
                onMouseEnter={() => setActiveIdx(filtered.length)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-t border-port-border disabled:opacity-50 ${
                  activeIdx === filtered.length
                    ? 'bg-port-accent/20 text-port-accent'
                    : 'text-port-accent hover:bg-port-accent/15'
                }`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {createPrefix} &ldquo;{trimmed}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
