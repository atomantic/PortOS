/**
 * A checkbox styled as a pill — the "pick some of these" affordance used by the
 * Brain capture boxes (YouTube ingest artifacts, GitHub repo intake actions).
 *
 * The label wraps the input, so the whole pill is the hit target while
 * `htmlFor`/`id` still establish the accessible association explicitly.
 */
export default function ToggleChip({ id, label, hint, Icon, checked, onToggle }) {
  return (
    <label
      htmlFor={id}
      title={hint}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] sm:min-h-0 rounded-lg border text-xs cursor-pointer transition-colors ${checked
        ? 'bg-port-accent/20 text-port-accent border-port-accent/40'
        : 'bg-port-bg text-gray-400 border-port-border hover:text-gray-200'}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-port-accent"
      />
      {Icon && <Icon size={12} />}
      {label}
    </label>
  );
}
