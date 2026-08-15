// Shared skeleton placeholder primitives.
//
// `PageSkeleton` reserves a WHOLE page's shape at first paint (#2843). These are
// the pieces it is built from, exported so a SUB-REGION that refetches after the
// surrounding page has already rendered — a Suspense fallback for a tab body, a
// detail panel loading its rows — can reserve its own shape too, instead of
// dropping a centered `BrailleSpinner` into a tall empty box (#4147).
//
// Two tones, because a placeholder has to sit a step off whatever is behind it:
//   'card'   — on the page background (`bg-port-card`). The default.
//   'border' — INSIDE a card, where `bg-port-card` would vanish into the card
//              itself (`bg-port-border`).
//
// Every block pulses, and every block honors `prefers-reduced-motion` via
// `motion-reduce:animate-none` — so a reduced-motion user gets the reserved
// dimensions without the throb.
const TONES = {
  card: 'bg-port-card',
  border: 'bg-port-border',
};

// Callers derive counts from live data (`TABS.length`, a config value), so clamp
// rather than trusting them: `Array.from` throws on a negative or infinite
// length, and no skeleton ever needs more than a few dozen blocks.
export function skeletonRepeat(n) {
  return Array.from({ length: Math.min(64, Math.max(0, Math.floor(n) || 0)) });
}

// One pulsing block. Size it entirely through `className` (`h-4 w-1/2`, …) —
// the primitive owns only the fill, the rounding, and the animation. Rounding is
// its own prop rather than something `className` overrides, because two
// competing `rounded*` utilities resolve by stylesheet order, not by the order
// they appear in the attribute — so a `rounded-full` avatar block passed through
// `className` would be a coin flip.
export function SkeletonBlock({ tone = 'card', roundedClass = 'rounded', className = '' }) {
  return (
    <div
      aria-hidden="true"
      className={`${roundedClass} ${TONES[tone] || TONES.card} animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}

// A stack of text lines. `widths` doubles as the count, so ragged line lengths
// (the thing that makes a skeleton read as prose rather than as a grey slab)
// are the default rather than an extra prop.
export function SkeletonLines({
  widths = ['w-full', 'w-5/6', 'w-4/6'],
  tone = 'card',
  heightClass = 'h-4',
  gapClass = 'space-y-2',
  className = '',
}) {
  return (
    <div className={`${gapClass} ${className}`}>
      {widths.map((width, i) => (
        <SkeletonBlock key={i} tone={tone} className={`${heightClass} ${width}`} />
      ))}
    </div>
  );
}

// A bordered content card: title line over body lines. The card chrome matches a
// real PortOS card (`rounded-lg border border-port-border bg-port-card`) so the
// swap to loaded content doesn't move the border.
export function SkeletonCard({
  titleWidthClass = 'w-2/3',
  lineWidths = ['w-1/2', 'w-1/3'],
  className = '',
}) {
  return (
    <div className={`rounded-lg border border-port-border bg-port-card p-4 sm:p-6 ${className}`}>
      <SkeletonBlock tone="border" className={`h-5 mb-3 ${titleWidthClass}`} />
      <SkeletonLines tone="border" widths={lineWidths} />
    </div>
  );
}

// Table/list rows. `columnWidthClasses` is one entry per column, so the reserved
// row lines up with the real table's columns instead of being a single bar.
export function SkeletonRows({
  rows = 5,
  columnWidthClasses = ['flex-1', 'w-14', 'w-10'],
  heightClass = 'h-3',
  tone = 'card',
  rowClassName = 'flex items-center gap-2 px-3 py-2 border-b border-port-border/20',
  className = '',
}) {
  return (
    <div className={className}>
      {skeletonRepeat(rows).map((_, row) => (
        <div key={row} className={rowClassName}>
          {columnWidthClasses.map((width, col) => (
            <SkeletonBlock key={col} tone={tone} className={`${heightClass} ${width}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// The busy-region wrapper. A sub-region skeleton still has to ANNOUNCE itself —
// the spinner it replaces was the only thing telling a screen reader the panel
// was loading, so keep `label` specific ("Loading data contents", not "Loading").
export function SkeletonRegion({ label = 'Loading', className = '', children }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  );
}
