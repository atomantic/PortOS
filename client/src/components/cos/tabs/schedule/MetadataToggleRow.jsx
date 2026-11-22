import ToggleSwitch from '../../../ToggleSwitch';

// One full-width on/off row for a task option. `locked` (managed by the task)
// disables the row without implying a save is in flight.
export default function MetadataToggleRow({ label, description, enabled, disabled, locked = false, ariaLabel, title, badge, onToggle }) {
  const inactive = disabled || locked;
  return (
    <button
      type="button"
      disabled={inactive}
      aria-pressed={enabled}
      aria-label={ariaLabel}
      title={title}
      className={`w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left ${inactive ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-port-card/30 active:bg-port-card/50'}`}
      onClick={onToggle}
    >
      <div className="min-w-0 flex-1">
        <span className="text-sm text-white flex items-center gap-2">
          {label}
          {badge}
        </span>
        <p className="text-xs text-gray-500">{description}</p>
      </div>
      <ToggleSwitch enabled={enabled} disabled={inactive} decorative />
    </button>
  );
}
