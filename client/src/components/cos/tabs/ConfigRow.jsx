export default function ConfigRow({ label, value, editing, type, inputValue, onChange, suffix, tooltip }) {
  return (
    <div className="flex items-center justify-between p-4" title={tooltip}>
      <span className="text-gray-400 cursor-help">{label}</span>
      {editing ? (
        <div className="flex items-center gap-2">
          {type === 'checkbox' ? (
            <input
              type="checkbox"
              checked={inputValue}
              onChange={e => onChange(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
            />
          ) : (
            <>
              <input
                type="number"
                value={inputValue}
                onChange={e => onChange(parseInt(e.target.value) || 0)}
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
