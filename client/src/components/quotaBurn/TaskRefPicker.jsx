/**
 * The searchable, grouped scheduled-task picker a burn step is built from.
 *
 * A burn window is spent unattended, so what it spends on has to be work the
 * user already defined and can inspect — not a prompt typed into this page and
 * duplicated away from the automation catalog. This control therefore offers the
 * SAME two catalogs the rest of PortOS schedules from: built-in scheduled task
 * types and app custom jobs. Creating new work happens in Scheduled Tasks, and
 * the picker links there rather than growing an editor of its own.
 *
 * The filter box is separate from the `<select>` on purpose: an install ships
 * ~30 built-in types plus however many custom jobs, which is past the point a
 * flat dropdown is usable, and a native grouped select keeps the whole thing
 * keyboard- and touch-usable without a popover to clamp to the viewport.
 */

import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { searchTaskCatalog } from '../../lib/quotaBurnTasks';
import { inputClass } from './fields';

export default function TaskRefPicker({
  id, label, groups, value = '', onPick, hint, disabled = false, placeholder = 'Choose a scheduled task…',
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const filtered = searchTaskCatalog(groups, query);
  const hasAny = (groups || []).some((group) => group.entries?.length);
  const total = filtered.reduce((sum, group) => sum + group.entries.length, 0);
  // A stale `value` (the referenced task was deleted, or the catalog read
  // failed) must not leave React's <select> sitting on whatever option the
  // browser picked instead — the row's own unavailable banner is what explains
  // it, and the picker reverts to its placeholder.
  const selectable = filtered.some((group) => group.entries.some((entry) => entry.key === value));

  return (
    <div className="space-y-1">
      <label htmlFor={searchId} className="block text-xs text-gray-400">
        Search tasks
        <span className="relative mt-1 block">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            className={`${inputClass} mt-0 pl-6`}
            value={query}
            disabled={disabled || !hasAny}
            placeholder="Filter by task, app, or description"
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
      </label>
      <label htmlFor={id} className="block text-xs text-gray-400">
        {label}
        <select
          id={id}
          className={inputClass}
          value={selectable ? value : ''}
          disabled={disabled || !hasAny}
          onChange={(event) => {
            const entry = filtered.flatMap((group) => group.entries).find((row) => row.key === event.target.value);
            if (entry) onPick(entry);
          }}
        >
          <option value="">{placeholder}</option>
          {filtered.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.entries.map((entry) => (
                <option key={entry.key} value={entry.key} title={entry.description || undefined}>
                  {entry.label}
                  {entry.blockedReason ? ` — ${entry.blockedReason}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {/* A filter that matched nothing is its own state: without it the select
          silently collapses to just the placeholder and reads as "this install
          has no scheduled tasks". */}
      {hasAny && total === 0 && (
        <p role="status" className="text-[11px] text-amber-300">No scheduled task matches “{query}”.</p>
      )}
      {hint && <p className="text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}
