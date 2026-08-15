/**
 * ProgressBar — the shared horizontal meter: a rounded track with a tone-colored
 * fill sized to `percent`.
 *
 * Six surfaces had hand-rolled the same `h-1.5 rounded-full` track +
 * `style={{ width: `${pct}%` }}` fill (LoRA downloads, manuscript read-aloud,
 * episode-video scenes, the POST drill runner, memory practice, and the
 * autopilot milestone meter). They had already drifted on accessibility — only
 * two carried `role="progressbar"` with `aria-valuenow`, so the rest were
 * invisible to a screen reader. That is the point of centralizing: the ARIA trio
 * plus an accessible name is emitted here, once, for every host.
 *
 * Knobs map to real call-site shapes — nothing speculative:
 *   percent  — 0..100, clamped. `null`/`undefined` means INDETERMINATE (the
 *              LoRA installer gets no Content-Length from some mirrors) and
 *              draws a pulsing stub with no `aria-valuenow`. A non-finite
 *              number (a `0/0` ratio) is a *broken* measurement, not an absent
 *              one, so it renders an empty determinate bar rather than
 *              silently claiming "indeterminate".
 *   tone     — semantic fill color. The drill timer swaps accent → warning →
 *              error as it runs out; chunk mastery swaps muted → warning →
 *              success; a stopped autopilot run reads warning.
 *   label    — the accessible name. Required in spirit; defaults to 'Progress'
 *              so the trio is never nameless.
 *   size     — `sm` (h-1.5, default) or `md` (h-2, the drill timer).
 *   track    — `bg` (on a card, default) or `border` (on the page ground, where
 *              `bg-port-bg` would vanish).
 *   duration — fill transition in ms. Static class map, because Tailwind can't
 *              see an interpolated `duration-${n}` and would drop it from the
 *              build.
 * `className` passes through for layout only (`flex-1`, `mt-1.5`).
 */

const TONES = {
  accent: 'bg-port-accent',
  accent2: 'bg-port-accent-2',
  success: 'bg-port-success',
  warning: 'bg-port-warning',
  error: 'bg-port-error',
  muted: 'bg-gray-600',
};

const SIZES = {
  sm: 'h-1.5',
  md: 'h-2',
};

const TRACKS = {
  bg: 'bg-port-bg',
  border: 'bg-port-border',
};

// Interpolated Tailwind class names are invisible to the build, so the only
// durations available are the ones spelled out here.
const DURATIONS = {
  100: 'duration-100',
  150: 'duration-150',
  200: 'duration-200',
  300: 'duration-300',
  500: 'duration-500',
};

// `null`/`undefined` = "we can't measure this" (indeterminate). Anything else is
// a measurement, and a broken one reads as 0 rather than collapsing into the
// indeterminate sentinel.
export function clampPercent(percent) {
  if (percent === null || percent === undefined) return null;
  const n = Number(percent);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export default function ProgressBar({
  percent,
  tone = 'accent',
  label = 'Progress',
  size = 'sm',
  track = 'bg',
  duration = 200,
  className = '',
}) {
  const value = clampPercent(percent);
  const indeterminate = value === null;
  const fillTone = TONES[tone] || TONES.accent;
  const trackCls = [
    'w-full overflow-hidden rounded-full',
    SIZES[size] || SIZES.sm,
    TRACKS[track] || TRACKS.bg,
    className,
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fillCls = [
    'h-full rounded-full',
    fillTone,
    indeterminate
      ? 'w-1/3 animate-pulse'
      : `transition-[width] ${DURATIONS[duration] || DURATIONS[200]}`,
  ].join(' ');

  return (
    <div
      className={trackCls}
      role="progressbar"
      aria-label={label}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={fillCls} style={indeterminate ? undefined : { width: `${value}%` }} />
    </div>
  );
}
