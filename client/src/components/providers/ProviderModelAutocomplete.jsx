import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

// Catalog-backed model fields are selections: typing only filters the options,
// and an unfinished search must never replace a saved model.
export default function ProviderModelAutocomplete({ label, labelClassName = 'block text-sm text-gray-400 mb-1', description, wrapperClassName = '', value, options, onChange, className }) {
  const inputId = useId();
  const listId = `${inputId}-options`;
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const activeRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(null);
  const [activeValue, setActiveValue] = useState(null);

  const selected = options.find(option => option.value === value);
  const search = (query || '').trim().toLowerCase();
  const visible = search
    ? options.filter(option => `${option.value} ${option.label}`.toLowerCase().includes(search))
    : options;
  // Keep a disabled saved value active when opening the list. Otherwise Enter
  // would silently replace that value with the first enabled option (None).
  const selectedActive = visible.findIndex(option => option.value === activeValue);
  // An older pin may no longer be in the catalog at all. Only searches choose
  // the first match automatically; opening an absent pin leaves none active.
  const activeIndex = selectedActive >= 0 ? selectedActive
    : activeValue === null ? visible.findIndex(option => !option.disabled) : -1;
  const active = visible[activeIndex];
  const activeId = open && active ? `${listId}-${activeIndex}` : undefined;

  useLayoutEffect(() => {
    const list = listRef.current;
    const option = activeRef.current;
    if (!open || !list || !option) return;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    const rect = option.getBoundingClientRect();
    const delta = rect.top < top ? rect.top - top : Math.max(0, rect.bottom - bottom);
    if (delta) list.scrollTo({ top: list.scrollTop + delta, behavior: 'instant' });
  }, [open, activeId, query]);

  const close = () => { setOpen(false); setQuery(null); };
  const choose = (option) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
    inputRef.current?.focus();
  };
  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setActiveValue(value);
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = activeIndex + step;
      while (next >= 0 && next < visible.length && visible[next].disabled) next += step;
      if (visible[next]) setActiveValue(visible[next].value);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && open) {
      // Keep Enter from submitting the form while a search is unresolved.
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className={wrapperClassName}>
      <label htmlFor={inputId} className={labelClassName}>{label}</label>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={query ?? (value ? selected?.label || value : '')}
          placeholder={options[0]?.label}
          onFocus={(event) => { setOpen(true); setActiveValue(value); event.currentTarget.select(); }}
          onClick={(event) => {
            if (query === null) event.currentTarget.select();
            if (!open) setActiveValue(value);
            setOpen(true);
          }}
          onChange={(event) => { setQuery(event.target.value); setActiveValue(null); setOpen(true); }}
          onBlur={close}
          onKeyDown={onKeyDown}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-describedby={description ? `${inputId}-description` : undefined}
          className={`${className} pr-9`}
        />
        <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
        {open && (
          <div ref={listRef} id={listId} role="listbox" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded border border-port-border bg-port-card shadow-lg">
            {visible.length === 0 && <div className="px-3 py-2 text-sm text-gray-500">No matching models</div>}
            {visible.map((option, index) => (
              <button
                key={option.value}
                ref={index === activeIndex ? activeRef : null}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value); }}
                onClick={() => choose(option)}
                className={`w-full px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${index === activeIndex ? 'bg-port-bg text-white' : 'text-gray-300 hover:bg-port-bg'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {description && <p id={`${inputId}-description`} className="text-xs text-gray-500 mt-1">{description}</p>}
    </div>
  );
}
