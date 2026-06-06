import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BadgeCheck, FlaskConical, HelpCircle, Sigma, Telescope } from 'lucide-react';
import { getProvenanceLevel } from '../../lib/healthProvenance.js';
import useClickOutside from '../../hooks/useClickOutside';

const POPOVER_WIDTH = 256; // w-64
const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 6; // ~mt-1.5 between chip and popover

// Hidden placeholder applied for the one layout-effect pass before the popover is
// measured — keeps it in the DOM (so its height is measurable) without flashing
// at the wrong spot.
const HIDDEN_POPOVER_STYLE = { position: 'fixed', top: 0, left: 0, visibility: 'hidden' };

// Position the fixed popover from the chip's viewport rect, then clamp it fully
// inside the viewport. Horizontally it's biased to `align` (start = popover's left
// edge under the chip; end = its right edge under the chip) before clamping.
// Vertically it prefers opening below the chip, flips above when there isn't room
// below, and clamps either way. Fixed positioning is what lets the popover escape
// the `overflow-hidden` dashboard grid cell it can live inside — an absolutely-
// positioned panel would clip against the cell on narrow widget widths or near
// the viewport bottom regardless of which edge it anchored. `popHeight` is the
// measured popover height (0 on the pre-measure pass → defaults to below).
function popoverStyleFor(rect, align, popHeight) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(POPOVER_WIDTH, vw - VIEWPORT_MARGIN * 2);
  const rawLeft = align === 'end' ? rect.right - width : rect.left;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, vw - width - VIEWPORT_MARGIN));

  const h = popHeight || 0;
  const belowTop = rect.bottom + POPOVER_GAP;
  const aboveTop = rect.top - POPOVER_GAP - h;
  let top;
  if (!h || belowTop + h <= vh - VIEWPORT_MARGIN) top = belowTop;        // fits below
  else if (aboveTop >= VIEWPORT_MARGIN) top = aboveTop;                  // flip above
  else top = Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - h);        // clamp into view
  // `width` drives only the `left` math above — the element's actual width is
  // pinned by the w-64/max-w className so the hidden measure pass (which sets the
  // height used for the flip) wraps text at exactly the visible width. Don't set
  // width inline, or the two passes could measure at different widths.
  return { position: 'fixed', top, left, visibility: 'visible' };
}

// Source-style provenance chip for health/longevity insights. Tap (or click) to
// reveal how the insight was derived plus a "what would change this?" explainer.
// Mirrors Ask's SourceChip affordance but for confidence/derivation rather than
// citations. Levels + default copy live in lib/healthProvenance.js; pass
// `explainer` / `whatWouldChange` to override the defaults for a specific insight.

// Full literal class strings so Tailwind's JIT keeps them — never interpolate tones.
const TONE_CHIP = {
  success: 'text-port-success bg-port-success/10 border-port-success/30 hover:border-port-success/60',
  accent: 'text-port-accent bg-port-accent/10 border-port-accent/30 hover:border-port-accent/60',
  warning: 'text-port-warning bg-port-warning/10 border-port-warning/30 hover:border-port-warning/60',
  muted: 'text-gray-400 bg-port-bg border-port-border hover:border-gray-500',
};

const TONE_ICON = {
  success: 'text-port-success',
  accent: 'text-port-accent',
  warning: 'text-port-warning',
  muted: 'text-gray-400',
};

const LEVEL_ICONS = {
  'data-backed': BadgeCheck,
  inferred: Sigma,
  experimental: FlaskConical,
  speculative: Telescope,
};

export default function ProvenanceChip({
  level,
  label,
  explainer,
  whatWouldChange,
  className = '',
  align = 'start',
}) {
  const meta = getProvenanceLevel(level);
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState(HIDDEN_POPOVER_STYLE);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const popId = useId();
  const close = useCallback(() => setOpen(false), []);

  useClickOutside(wrapRef, open, close);

  // Measure the chip (and the popover's own height, for the below/above flip) and
  // place the fixed popover before paint so it never flashes at the wrong spot;
  // re-measure on scroll/resize while open since fixed coords are viewport-relative
  // and the chip can move under them. Reset to hidden on close so the next open
  // re-measures from scratch instead of reusing a stale rect.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setPopStyle(HIDDEN_POPOVER_STYLE);
      return undefined;
    }
    const reposition = () => setPopStyle(
      popoverStyleFor(btnRef.current.getBoundingClientRect(), align, popRef.current?.offsetHeight),
    );
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const Icon = LEVEL_ICONS[meta.id] ?? Sigma;
  const chipTone = TONE_CHIP[meta.tone] ?? TONE_CHIP.muted;
  const iconTone = TONE_ICON[meta.tone] ?? TONE_ICON.muted;
  const description = explainer ?? meta.description;
  const change = whatWouldChange ?? meta.whatWouldChange;

  return (
    <div ref={wrapRef} className={`relative inline-flex align-middle ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={`${meta.label} — tap for how this is derived`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${chipTone}`}
      >
        <Icon size={10} aria-hidden="true" className="shrink-0" />
        <span>{label ?? meta.label}</span>
        <HelpCircle size={10} aria-hidden="true" className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          // Fixed + viewport-clamped (see popoverStyleFor) so the panel escapes
          // any overflow-hidden ancestor — e.g. the dashboard grid cell — and
          // never renders off-screen, on a narrow widget or near any viewport edge.
          // Rendered hidden for one layout-effect pass so its height is measurable
          // before it's placed (the below/above flip needs that height).
          style={popStyle}
          className="z-30 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-port-border bg-port-card p-3 text-left shadow-xl"
        >
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-200 normal-case tracking-normal">
            <Icon size={12} aria-hidden="true" className={`shrink-0 ${iconTone}`} />
            {meta.label}
          </p>
          <p className="text-xs leading-relaxed text-gray-400">{description}</p>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            What would change this?
          </p>
          <p className="text-xs leading-relaxed text-gray-400">{change}</p>
        </div>
      )}
    </div>
  );
}
