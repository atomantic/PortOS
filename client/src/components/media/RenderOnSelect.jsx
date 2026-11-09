// Compact labeled selects shared by the shot editor's clip and frame render
// pickers, so the two rows stay the same control instead of two copies.

export const COMPACT_SELECT = 'min-w-0 max-w-full bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/** The "Render on" choice. `onChange` receives the option value. */
export function RenderOnSelect({ id, value, onChange, disabled = false, title, options, unavailable = null }) {
  return (
    <span className="flex min-w-0 max-w-full flex-1 basis-48 items-center gap-1 sm:flex-initial">
      <label htmlFor={id} className="shrink-0 text-xs">Render on</label>
      <select id={id} value={value} disabled={disabled} title={title}
        onChange={(e) => onChange(e.target.value)}
        className={`${COMPACT_SELECT} flex-1`}>
        {unavailable}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </span>
  );
}

/** A follow-on option (model, length, size) beside Render on. `onChange` receives the option value. */
export function RenderOptionSelect({ id, label, value, onChange, disabled = false, children }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      <label htmlFor={id} className="shrink-0 text-xs text-port-text-muted">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`${COMPACT_SELECT} flex-1`}>{children}</select>
    </span>
  );
}
