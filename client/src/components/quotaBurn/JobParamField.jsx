/**
 * One burn-job parameter input, rendered from the server's param descriptor
 * (`QUOTA_BURN_JOB_CATALOG[].params[]`). Keeping the descriptor server-side is
 * what lets a new job type ship without a client change — this component only
 * needs to know the param KINDS, not any particular job's fields.
 */

const inputClass = 'w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs';

export default function JobParamField({ descriptor, value, onChange, options, idPrefix }) {
  const id = `${idPrefix}-${descriptor.key}`;
  const current = value ?? descriptor.default ?? '';

  if (descriptor.kind === 'boolean') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-xs text-gray-300">
        <input
          id={id}
          type="checkbox"
          checked={value ?? descriptor.default ?? false}
          onChange={(event) => onChange(descriptor.key, event.target.checked)}
        />
        {descriptor.label}
      </label>
    );
  }

  if (descriptor.kind === 'text') {
    return (
      <label htmlFor={id} className="block sm:col-span-2 text-xs text-gray-400">
        {descriptor.label}
        <textarea
          id={id}
          className={`${inputClass} min-h-24 font-mono`}
          value={current}
          placeholder="What should this provider spend its remaining quota on?"
          onChange={(event) => onChange(descriptor.key, event.target.value)}
        />
      </label>
    );
  }

  if (descriptor.kind === 'number') {
    return (
      <label htmlFor={id} className="block text-xs text-gray-400">
        {descriptor.label}
        <input
          id={id}
          type="number"
          min={descriptor.min}
          max={descriptor.max}
          className={inputClass}
          value={current}
          onChange={(event) => onChange(descriptor.key, Number(event.target.value))}
        />
      </label>
    );
  }

  // Everything else is a select over a list the page supplied (apps, universes,
  // image modes) or the descriptor's own enum. An `all`/`default` sentinel row
  // is emitted for the kinds whose default is "no pin".
  const rows = descriptor.kind === 'enum'
    ? (descriptor.options || []).map((option) => ({ value: option, label: option }))
    : (options || []).map((option) => ({ value: option.id ?? option, label: option.name ?? option }));
  const sentinel = descriptor.kind === 'universe'
    ? { value: 'all', label: 'All universes' }
    : (descriptor.kind === 'imageMode' ? { value: '', label: 'Match the burning provider' } : null);

  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {descriptor.label}
      <select
        id={id}
        className={inputClass}
        value={current ?? ''}
        onChange={(event) => onChange(descriptor.key, event.target.value || null)}
      >
        {sentinel && <option value={sentinel.value}>{sentinel.label}</option>}
        {descriptor.required && !sentinel && <option value="">Select…</option>}
        {rows.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
      </select>
    </label>
  );
}
