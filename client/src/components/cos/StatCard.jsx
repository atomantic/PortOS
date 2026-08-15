// Status tones for a card whose color reflects a health signal rather than the
// generic "something is running" `active` state. Border, icon and sub-label all
// read from one entry so the three can't drift apart — which is exactly what
// happened while the CoS Learning tiles were hand-rolled buttons (#4129).
// A tone with `border: null` tints only the icon and leaves the border to the
// `active` treatment below.
const TONE_CLASSES = {
  critical: { icon: 'text-port-error', border: 'border-port-error shadow-md shadow-port-error/20', label: 'text-port-error' },
  warning: { icon: 'text-port-warning', border: 'border-port-warning shadow-md shadow-port-warning/20', label: 'text-port-warning' },
  good: { icon: 'text-port-accent-2', border: null, label: 'text-port-accent-2' },
  default: { icon: 'text-gray-500', border: null, label: null },
};

// The `mini` and `default` variants share one stacked layout and differ only by
// scale, so they live in a size table instead of two near-identical returns.
// `compact` keeps its own row layout but reads its shell classes from here too.
const SIZES = {
  default: {
    bg: 'bg-port-card',
    root: 'rounded-lg p-2 sm:p-3 lg:p-4',
    activeBorder: 'border-port-accent shadow-lg shadow-port-accent/20',
    header: 'mb-0.5 sm:mb-1 lg:mb-2',
    label: 'text-xs sm:text-sm mr-1',
    value: 'text-lg sm:text-xl lg:text-2xl',
    activeLabel: 'text-xs mt-0.5 sm:mt-1 animate-pulse',
  },
  mini: {
    bg: 'bg-port-card',
    root: 'rounded p-1.5 sm:p-2 lg:p-3',
    activeBorder: 'border-port-accent shadow-md shadow-port-accent/20',
    header: 'mb-0.5',
    label: 'text-[10px] sm:text-xs',
    value: 'text-sm sm:text-base lg:text-xl',
    activeLabel: 'text-[9px] mt-0.5',
  },
  compact: {
    bg: 'bg-port-card/80',
    root: 'rounded px-2 py-1.5 flex items-center gap-2',
    activeBorder: 'border-port-accent shadow-md shadow-port-accent/20',
    activeLabel: 'text-[9px]',
  },
};

export default function StatCard({ label, value, icon, active, activeLabel, compact, mini, tone, onClick, title }) {
  const ariaLabel = `${label}: ${value}${active && activeLabel ? `, ${activeLabel}` : ''}`;
  // Only tint the icon when a tone was asked for — tone-less callers pass a
  // pre-colored icon element of their own.
  const toneStyles = tone ? (TONE_CLASSES[tone] ?? TONE_CLASSES.default) : null;
  const iconClass = ['shrink-0', active ? 'animate-pulse' : '', toneStyles?.icon ?? ''].filter(Boolean).join(' ');
  const subLabelClass = toneStyles?.label ?? 'text-port-accent';
  const showActiveLabel = Boolean(active && activeLabel);

  const size = compact ? SIZES.compact : (mini ? SIZES.mini : SIZES.default);
  const borderClass = toneStyles?.border ?? (active ? size.activeBorder : 'border-port-border');

  // `onClick` promotes the card to a real <button> so it's keyboard- and
  // screen-reader-reachable; without it the card stays a labelled group. A card
  // already wearing a tone or active border keeps that color on hover — the
  // border-hover affordance only applies where the border is still neutral.
  const Wrapper = onClick ? 'button' : 'div';
  const wrapperProps = onClick
    ? { type: 'button', onClick, title, 'aria-label': ariaLabel }
    : { role: 'group', title, 'aria-label': ariaLabel };
  const hasNeutralBorder = !toneStyles?.border && !active;
  const interactiveClass = onClick
    ? `text-left hover:bg-port-card/60${hasNeutralBorder ? ' hover:border-port-accent-2/50' : ''}`
    : '';
  const shellClass = `${size.bg} border transition-all ${size.root} ${borderClass} ${interactiveClass}`;

  if (compact) {
    return (
      <Wrapper {...wrapperProps} className={shellClass}>
        <div className={iconClass} aria-hidden="true">
          {icon}
        </div>
        {/* Stacked, not a flex row: as flex items these keep min-width:auto, so
            on a narrow card the sub-label can't shrink and spills out. (The
            `min-w-0` here is what lets the column shrink at all — a nowrap
            label in a `min-width:auto` flex item can't.) The value itself stays
            wrappable: truncate the label, leave the value alone, or a wide
            value like 'No data' clips to 'No dat…'. */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-500 truncate">{label}</div>
          <div className="text-sm font-bold text-white">{value}</div>
          {showActiveLabel && (
            <div className={`${size.activeLabel} truncate ${subLabelClass}`} aria-live="polite">
              {activeLabel}
            </div>
          )}
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper {...wrapperProps} className={shellClass}>
      <div className={`flex items-center justify-between ${size.header}`}>
        <span className={`${size.label} text-gray-500 truncate`}>{label}</span>
        <div className={iconClass} aria-hidden="true">
          {icon}
        </div>
      </div>
      <div className={`${size.value} font-bold text-white`}>{value}</div>
      {showActiveLabel && (
        <div className={`${size.activeLabel} truncate ${subLabelClass}`} aria-live="polite">
          {activeLabel}
        </div>
      )}
    </Wrapper>
  );
}
