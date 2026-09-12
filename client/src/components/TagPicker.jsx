/**
 * TagPicker — chip-list tag editor with canonical-tag autocomplete.
 *
 * Backs the tag fields on CatalogIngredient.jsx + the Quick Idea widget. The
 * selected tags render as removable chips; typing queries the canonical
 * `catalog_tags` table (`GET /api/catalog/tags?q=`, debounced) and shows a
 * suggestion dropdown. Enter / comma / picking a suggestion commits the current
 * input as a tag. Freeform tags are allowed (the server normalizes + creates a
 * canonical row on save), so this is autocomplete-assisted, not a closed list.
 *
 * Controlled: `value` is the array of tag labels; `onChange(nextArray)` fires
 * on every add/remove. Client-side dedup uses `canonicalTagKey` so `Noir` and
 * `noir` don't both show as chips before save (matching the server's dedup).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { listCatalogTags } from '../services/apiCatalog';
import { canonicalTagKey } from '../lib/catalogTypes';

export default function TagPicker({
  value = [],
  onChange,
  id = 'tag-picker',
  placeholder = 'Add a tag…',
  maxTags = 12,
  maxTagChars = 60,
}) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const listId = useId();
  const inputRef = useRef(null);
  const activeOptionRef = useRef(null);

  // Clear old options immediately and ignore responses after input changes.
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setActiveId(null);
    const term = input.trim();
    if (!term) return undefined;
    const timer = setTimeout(() => {
      listCatalogTags({ q: term, limit: 8, silent: true })
        .then((res) => {
          if (!cancelled) setSuggestions(Array.isArray(res?.items) ? res.items : []);
        })
        .catch(() => { if (!cancelled) setSuggestions([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [input]);

  const selectedKeys = new Set(value.map(canonicalTagKey));

  const addTag = (raw) => {
    const label = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, maxTagChars);
    const key = canonicalTagKey(label);
    if (!key) return;
    if (selectedKeys.has(key)) { setInput(''); return; }
    if (value.length >= maxTags) return;
    onChange?.([...value, label]);
    setInput('');
    setSuggestions([]);
    setActiveId(null);
    setOpen(false);
  };

  const removeTag = (label) => {
    // Keep a live focus target so leaving the picker still commits pending text.
    inputRef.current?.focus();
    const key = canonicalTagKey(label);
    onChange?.(value.filter((t) => canonicalTagKey(t) !== key));
  };

  // Track option identity, not position, as filtering can remove an option.
  const visibleSuggestions = suggestions.filter((s) => !selectedKeys.has(canonicalTagKey(s.label)));
  const expanded = open && value.length < maxTags && visibleSuggestions.length > 0;
  const activeIndex = expanded ? visibleSuggestions.findIndex((s) => s.id === activeId) : -1;

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeId, activeIndex]);

  const pickSuggestion = (label) => {
    // Assistive clicks can focus an option. Move focus before removing it.
    inputRef.current?.focus();
    addTag(label);
  };

  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && visibleSuggestions.length > 0) {
      e.preventDefault();
      setOpen(true);
      const next = e.key === 'ArrowDown'
        ? (activeIndex + 1) % visibleSuggestions.length
        : (activeIndex <= 0 ? visibleSuggestions.length : activeIndex) - 1;
      setActiveId(visibleSuggestions[next].id);
    } else if (e.key === 'Escape') {
      if (expanded) { e.preventDefault(); e.stopPropagation(); }
      setOpen(false);
      setActiveId(null);
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (e.key === 'Enter' && activeIndex >= 0) pickSuggestion(visibleSuggestions[activeIndex].label);
      else if (input.trim()) addTag(input);
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div className="relative" onBlur={(e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      // Preserve pending text when leaving for Save/Send, but not on internal focus moves.
      if (input.trim()) addTag(input);
      setOpen(false);
      setActiveId(null);
    }}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 bg-port-bg border border-port-border rounded focus-within:border-port-accent">
        {value.map((label) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-accent/15 text-port-accent text-xs"
          >
            {label}
            <button
              type="button"
              onClick={() => removeTag(label)}
              className="hover:text-white"
              aria-label={`Remove tag ${label}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={value.length >= maxTags ? `Max ${maxTags} tags` : placeholder}
          disabled={value.length >= maxTags}
          maxLength={maxTagChars}
          className="flex-1 min-w-[8ch] bg-transparent text-white text-sm focus:outline-none disabled:opacity-50"
        />
      </div>
      {expanded && (
        <ul id={listId} role="listbox" aria-label="Tag suggestions" className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto bg-port-card border border-port-border rounded shadow-lg">
          {visibleSuggestions.map((s, index) => (
            <li key={s.id} role="presentation">
              <button
                type="button"
                role="option"
                ref={activeIndex === index ? activeOptionRef : undefined}
                id={`${listId}-${index}`}
                aria-selected={activeIndex === index}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickSuggestion(s.label)}
                className={`w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-port-bg flex items-center gap-2 ${activeIndex === index ? 'bg-port-bg outline outline-port-accent' : ''}`}
              >
                {s.color && (
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                    aria-hidden="true"
                  />
                )}
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
