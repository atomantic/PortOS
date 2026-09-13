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

// For a screen reader the tone was carried by nothing at all: the icon is
// optional and aria-hidden by default, so an error banner and a success banner
// with the same copy read identically. A visually-hidden word in front of the
// body gives the tone a TEXT form, without a visual diff at any call site.
// NB: that is a text alternative, not a visual one — the sighted half of WCAG
// 1.4.1 still rests on passing an `icon`, which this deliberately does not
// force on 124 existing call sites.
const TONE_WORDS = {
  warning: 'Warning',
  error: 'Error',
  success: 'Success',
  info: 'Note',
};

export default function Banner({
  tone = 'warning',
  icon: Icon,
  // Banner icons are decorative by default — the tone color and body text
  // already convey the meaning, so screen readers should skip the icon. Pass
  // `iconAriaHidden={false}` for the rare case where the icon carries meaning
  // the text doesn't; the icon then renders as a bare exposed <svg>, so the
  // caller is responsible for labeling it (e.g. an aria-label) at the call site.
  iconAriaHidden = true,
  // A visually-hidden tone word ("Error: ", "Success: ") prefixes the body so
  // the tone reaches a screen reader. Pass false for the rare banner whose own
  // copy already opens with the tone word.
  srLabel = true,
  size = 'sm',
  align = 'start',
  title,
  actions,
  className = '',
  children,
  ...rest
}) {
  const t = TONES[tone] || TONES.warning;
  const toneWord = TONE_WORDS[tone] || TONE_WORDS.warning;
  const s = SIZES[size] || SIZES.sm;
  const alignClass = ALIGNMENTS[align] || ALIGNMENTS.start;
  const radius = size === 'lg' || size === 'md' ? 'rounded-lg' : 'rounded';
  // Nudge the icon down half a row to sit on the text baseline when the
  // wrapper is top-aligned. For center-aligned banners the icon is already
  // visually centered by flex, so the nudge becomes a noticeable mis-align.
  const iconNudge = align === 'start' ? 'mt-0.5' : '';

  return (
    <div
      // Rely on the implicit live semantics of alert/status — a redundant
      // aria-live alongside them is what double-announces in some readers.
      // Placed BEFORE {...rest} so a call site that passes its own role wins.
      role={tone === 'error' ? 'alert' : 'status'}
      className={`${s.padding} ${s.text} border ${radius} ${t.wrapper} flex ${alignClass} ${s.gap} ${className}`.trim()}
      {...rest}
    >
      {Icon ? (
        <Icon
          size={s.iconSize}
          className={`shrink-0 ${iconNudge} ${t.iconColor}`.trim()}
          aria-hidden={iconAriaHidden ? 'true' : undefined}
        />
      ) : null}
      <div className="flex-1 min-w-0">
        {srLabel ? <span className="sr-only">{toneWord}: </span> : null}
        {title ? <div className="font-medium">{title}</div> : null}
        {children}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
