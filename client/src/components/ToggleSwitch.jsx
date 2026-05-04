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

export default function ToggleSwitch({ enabled, onChange, disabled, ariaLabel, size = 'md', activeColor = 'bg-port-accent', className = '', tabIndex, decorative = false }) {
  const s = SIZES[size] || SIZES.md;
  const knob = (
    <span className={`inline-block ${s.knob} transform rounded-full bg-white transition-transform ${
      enabled ? s.on : s.off
    }`} />
  );
  const trackClass = `relative inline-flex ${s.track} items-center rounded-full transition-colors shrink-0 ${
    enabled ? activeColor : 'bg-gray-600'
  } ${disabled ? 'opacity-50' : ''} ${className}`;

  // Decorative mode renders as a <span> so it can sit inside another <button>
  // without producing invalid nested-button HTML (which breaks tap on iOS Safari).
  if (decorative) {
    return <span aria-hidden="true" className={trackClass}>{knob}</span>;
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      tabIndex={tabIndex}
      className={trackClass}
      aria-label={ariaLabel}
    >
      {knob}
    </button>
  );
}
