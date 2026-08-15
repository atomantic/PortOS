import { useId } from 'react';

export default function ConfigRow({ label, value, editing, type, inputValue, onChange, suffix, tooltip }) {
  // The row's text already reads as the control's label, so pair the two rather
  // than duplicating it into an aria-label — that also makes the text a click
  // target for the checkbox, which is otherwise a 16px hit area.
  const controlId = useId();
  return (
    <div className="flex items-center justify-between p-4" title={tooltip}>
      <label htmlFor={controlId} className="text-gray-400 cursor-help">{label}</label>
      {editing ? (
        <div className="flex items-center gap-2">
          {type === 'checkbox' ? (
            <input
              id={controlId}
              type="checkbox"
              checked={inputValue}
              onChange={e => onChange(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
            />
          ) : (
            <>
              <input
                id={controlId}
                type="number"
                value={inputValue}
                onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
                className="w-24 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm text-right"
              />
              {suffix && <span className="text-gray-500 text-sm">{suffix}</span>}
            </>
          )}
        </div>
      ) : (
        <span className="text-white">{value}</span>
      )}
    </div>
  );
}
