// Shared inline-label-badge primitive. Replaces the hand-rolled
// `<span className="text-xs … rounded px-2 py-0.5">{label}</span>` spans that
// were copy-pasted across the client (peer relationship/scheme badges, length
// targets, etc.).
//
// Knobs map to real call-site shapes — nothing speculative:
//   tone     — semantic color trio (text + bg-tint + border). `context` is the
//              uppercase no-bg variant; `note` is muted + italic; `bare` emits no
//              color, so a data-driven badge must supply ALL colors via `className`
//              (including a `border-<color>` when it keeps the default border, else
//              the bare `border` width paints Tailwind's default color).
//   size     — `sm` (text-xs / px-2, default) or `xs` (text-[10px] / px-1.5).
//   icon     — optional leading lucide glyph (renders inline-flex + gap).
//   bordered — default true (the WritersRoom bordered look); pass false for the
//              bg-tint-only badges (the border-color utility is stripped so we
//              never emit a `border-…` color with no `border` width).
//   mono     — adds font-mono (host / scheme badges).
// Any extra props (`title`, …) pass through to the span.

const TONES = {
  accent: 'text-port-accent bg-port-accent/10 border-port-accent/20',
  muted: 'text-gray-300 bg-port-bg border-port-border',
  note: 'text-gray-500 bg-port-bg border-port-border italic',
  context: 'text-gray-500 border-port-border uppercase tracking-wide',
  success: 'text-port-success bg-port-success/10 border-port-success/20',
  warning: 'text-port-warning bg-port-warning/10 border-port-warning/20',
  bare: '',
};

const SIZES = {
  sm: { text: 'text-xs', padding: 'px-2 py-0.5', icon: 12 },
  xs: { text: 'text-[10px]', padding: 'px-1.5 py-0.5', icon: 10 },
};

export default function Pill({
  tone = 'muted',
  size = 'sm',
  icon: Icon,
  bordered = true,
  mono = false,
  className = '',
  children,
  ...rest
}) {
  const sz = SIZES[size] || SIZES.sm;
  const toneClass = TONES[tone] ?? TONES.muted;
  // Without a border, drop the border-color utility so we don't ship a color
  // with no width to paint it.
  const color = bordered ? toneClass : toneClass.replace(/\bborder-\S+/g, '');
  const cls = [
    'inline-flex items-center gap-1 rounded',
    sz.text,
    sz.padding,
    bordered ? 'border' : '',
    mono ? 'font-mono' : '',
    color,
    className,
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    <span className={cls} {...rest}>
      {Icon && <Icon size={sz.icon} aria-hidden="true" className="shrink-0" />}
      {children}
    </span>
  );
}
