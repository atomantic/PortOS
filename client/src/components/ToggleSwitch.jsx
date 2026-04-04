const SIZES = {
  sm: {
    track: 'h-7 w-12',
    knob: 'h-5 w-5',
    on: 'translate-x-6',
    off: 'translate-x-1'
  },
  md: {
    track: 'h-8 w-14',
    knob: 'h-6 w-6',
    on: 'translate-x-7',
    off: 'translate-x-1'
  }
};

export default function ToggleSwitch({ enabled, onChange, disabled, ariaLabel, size = 'md', activeColor = 'bg-port-accent', className = '', tabIndex }) {
  const s = SIZES[size] || SIZES.md;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      tabIndex={tabIndex}
      className={`relative inline-flex ${s.track} items-center rounded-full transition-colors shrink-0 ${
        enabled ? activeColor : 'bg-gray-600'
      } ${disabled ? 'opacity-50' : ''} ${className}`}
      aria-label={ariaLabel}
    >
      <span className={`inline-block ${s.knob} transform rounded-full bg-white transition-transform ${
        enabled ? s.on : s.off
      }`} />
    </button>
  );
}
