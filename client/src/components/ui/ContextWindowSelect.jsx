export default function ContextWindowSelect({ label, options, ...props }) {
  return (
    <select {...props} aria-label={label} className="rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white disabled:opacity-60">
      {options.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
}
