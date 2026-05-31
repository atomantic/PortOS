// Each tone pre-composes every full class name it needs — Tailwind's JIT
// scans for complete tokens, so `${t.text}/30` would NOT generate the
// `border-port-warning/30` utility. Spell it out.
const TONES = {
  warning: {
    wrapper: 'border-port-warning/30 bg-port-warning/10 text-port-warning',
    iconColor: 'text-port-warning',
  },
  error: {
    wrapper: 'border-port-error/30 bg-port-error/10 text-port-error',
    iconColor: 'text-port-error',
  },
  success: {
    wrapper: 'border-port-success/30 bg-port-success/10 text-port-success',
    iconColor: 'text-port-success',
  },
  info: {
    wrapper: 'border-port-accent/30 bg-port-accent/10 text-port-accent',
    iconColor: 'text-port-accent',
  },
};

const SIZES = {
  sm: { padding: 'px-3 py-2', text: 'text-xs', iconSize: 14, gap: 'gap-2' },
  md: { padding: 'px-4 py-3', text: 'text-sm', iconSize: 16, gap: 'gap-2' },
  lg: { padding: 'p-4', text: 'text-sm', iconSize: 20, gap: 'gap-3' },
};

// `align` must be an explicit prop, not a className override — Tailwind
// resolves duplicate `items-*` utilities by CSS source order, not class-string
// order, so a future Tailwind upgrade could silently flip the winner.
const ALIGNMENTS = {
  start: 'items-start',
  center: 'items-center',
};

export default function Banner({
  tone = 'warning',
  icon: Icon,
  size = 'sm',
  align = 'start',
  title,
  actions,
  className = '',
  children,
  ...rest
}) {
  const t = TONES[tone] || TONES.warning;
  const s = SIZES[size] || SIZES.sm;
  const alignClass = ALIGNMENTS[align] || ALIGNMENTS.start;
  const radius = size === 'lg' || size === 'md' ? 'rounded-lg' : 'rounded';
  // Nudge the icon down half a row to sit on the text baseline when the
  // wrapper is top-aligned. For center-aligned banners the icon is already
  // visually centered by flex, so the nudge becomes a noticeable mis-align.
  const iconNudge = align === 'start' ? 'mt-0.5' : '';

  return (
    <div
      className={`${s.padding} ${s.text} border ${radius} ${t.wrapper} flex ${alignClass} ${s.gap} ${className}`.trim()}
      {...rest}
    >
      {Icon ? (
        <Icon size={s.iconSize} className={`shrink-0 ${iconNudge} ${t.iconColor}`.trim()} />
      ) : null}
      <div className="flex-1 min-w-0">
        {title ? <div className="font-medium">{title}</div> : null}
        {children}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
