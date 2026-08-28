import { useId } from 'react';

export default function ConfigRow({
  label,
  description,
  value,
  editing,
  type,
  inputValue,
  onChange,
  suffix,
  options = [],
  min,
  max,
  step,
}) {
  const controlId = useId();
  const isCheckbox = type === 'checkbox';

  return (
    <div className="flex min-h-24 flex-col justify-between gap-3 rounded-lg border border-port-border bg-port-card p-3.5">
      <div>
        <label htmlFor={controlId} className="text-sm font-medium text-port-text">{label}</label>
        {description && <p className="mt-1 text-xs leading-relaxed text-port-text-muted">{description}</p>}
      </div>

      {editing ? (
        isCheckbox ? (
          <label htmlFor={controlId} className="flex cursor-pointer items-center justify-between gap-3">
            <span className={`text-xs font-medium ${inputValue ? 'text-port-success' : 'text-port-text-muted'}`}>
              {inputValue ? 'Enabled' : 'Disabled'}
            </span>
            <span className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-port-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-port-card ${inputValue ? 'bg-port-accent' : 'bg-port-border'}`}>
              <input
                id={controlId}
                type="checkbox"
                checked={Boolean(inputValue)}
                onChange={(event) => onChange(event.target.checked)}
                className="peer sr-only"
              />
              <span className={`m-1 h-4 w-4 rounded-full bg-white transition-transform ${inputValue ? 'translate-x-5' : ''}`} />
            </span>
          </label>
        ) : type === 'select' ? (
          <select
            id={controlId}
            value={inputValue}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-md border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2">
            <input
              id={controlId}
              type="number"
              min={min}
              max={max}
              step={step}
              value={inputValue}
              onChange={(event) => onChange(Number(event.target.value))}
              className="min-w-0 flex-1 rounded-md border border-port-border bg-port-bg px-3 py-2 text-right text-sm text-port-text"
            />
            {suffix && <span className="shrink-0 text-xs text-port-text-muted">{suffix}</span>}
          </div>
        )
      ) : (
        <span className={`text-sm font-semibold ${isCheckbox && inputValue ? 'text-port-success' : 'text-port-text'}`}>
          {value}
        </span>
      )}
    </div>
  );
}
