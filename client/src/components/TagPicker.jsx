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

import { useEffect, useRef, useState } from 'react';
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
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Debounced autocomplete fetch. A stale generation counter prevents an
  // earlier-but-slower response from clobbering a later one's results.
  const genRef = useRef(0);
  useEffect(() => {
    const term = input.trim();
    if (!term) { setSuggestions([]); return undefined; }
    const gen = ++genRef.current;
    const timer = setTimeout(() => {
      listCatalogTags({ q: term, limit: 8, silent: true })
        .then((res) => {
          if (!mountedRef.current || gen !== genRef.current) return;
          setSuggestions(Array.isArray(res?.items) ? res.items : []);
        })
        .catch(() => { if (mountedRef.current && gen === genRef.current) setSuggestions([]); });
    }, 200);
    return () => clearTimeout(timer);
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
  };

  const removeTag = (label) => {
    const key = canonicalTagKey(label);
    onChange?.(value.filter((t) => canonicalTagKey(t) !== key));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (input.trim()) addTag(input);
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      // Backspace on an empty input pops the last chip (common chip-input UX).
      removeTag(value[value.length - 1]);
    }
  };

  // Suggestions not already selected.
  const visibleSuggestions = suggestions.filter((s) => !selectedKeys.has(canonicalTagKey(s.label)));

  return (
    <div className="relative">
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
          id={id}
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Commit a typed-but-uncommitted tag on blur so clicking Save/Send
            // (which blurs this input) doesn't silently drop it. addTag dedups
            // and guards empty/max, so it's a no-op for a blank or duplicate
            // input. Suggestion picks use onMouseDown+preventDefault and never
            // blur, so they can't double-add here.
            if (input.trim()) addTag(input);
            setTimeout(() => { if (mountedRef.current) setOpen(false); }, 120);
          }}
          placeholder={value.length >= maxTags ? `Max ${maxTags} tags` : placeholder}
          disabled={value.length >= maxTags}
          maxLength={maxTagChars}
          className="flex-1 min-w-[8ch] bg-transparent text-white text-sm focus:outline-none disabled:opacity-50"
        />
      </div>
      {open && visibleSuggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto bg-port-card border border-port-border rounded shadow-lg">
          {visibleSuggestions.map((s) => (
            <li key={s.id}>
              {/* onMouseDown (not onClick) fires before the input's onBlur so the
                  pick lands before the dropdown closes. */}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); addTag(s.label); }}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-port-bg flex items-center gap-2"
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
