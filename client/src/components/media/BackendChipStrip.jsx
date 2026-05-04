// Pill-style backend selector shared by ImageGen, VideoGen, and the Writers
// Room storyboard config. `size="md"` matches the standalone Image Gen
// page; `size="sm"` matches the storyboard's denser config tab.

const SIZES = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-1 text-xs',
};

export default function BackendChipStrip({
  availableBackends,
  value,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel = 'Backend',
  titlePrefix = 'Use',
}) {
  if (!availableBackends?.length) return null;
  const sizeCls = SIZES[size] || SIZES.md;
  return (
    <div className="inline-flex items-center gap-1 p-0.5 border border-port-border rounded-full bg-port-bg" role="group" aria-label={ariaLabel}>
      {availableBackends.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange?.(id)}
          disabled={disabled}
          className={`inline-flex items-center gap-1 rounded-full transition-colors disabled:opacity-50 ${sizeCls} ${value === id ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white hover:bg-port-border/40'}`}
          title={`${titlePrefix} ${label}`}
        >
          <Icon className="w-3 h-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
