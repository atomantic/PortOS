import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BadgeCheck, FlaskConical, HelpCircle, Sigma, Telescope } from 'lucide-react';
import { getProvenanceLevel } from '../../lib/healthProvenance.js';
import useClickOutside from '../../hooks/useClickOutside';

const POPOVER_WIDTH = 256; // w-64
const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 6; // ~mt-1.5 below the chip

// Position the fixed popover from the chip's viewport rect, biased to `align`
// (start = popover's left edge under the chip; end = its right edge under the
// chip) and then clamped to the viewport so it never runs off-screen. Fixed
// positioning is what lets the popover escape the `overflow-hidden` dashboard
// grid cell it can live inside — an absolutely-positioned panel would clip
// against the cell on narrow widget widths regardless of which edge it anchored.
function popoverStyleFor(rect, align) {
  const vw = window.innerWidth;
  const width = Math.min(POPOVER_WIDTH, vw - VIEWPORT_MARGIN * 2);
  const rawLeft = align === 'end' ? rect.right - width : rect.left;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, vw - width - VIEWPORT_MARGIN));
  return { position: 'fixed', top: rect.bottom + POPOVER_GAP, left, width };
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
  const [popStyle, setPopStyle] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popId = useId();
  const close = useCallback(() => setOpen(false), []);

  useClickOutside(wrapRef, open, close);

  // Measure the chip and place the fixed popover before paint so it never flashes
  // at the wrong spot; re-measure on scroll/resize while open since fixed coords
  // are viewport-relative and the chip can move under them.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return undefined;
    const reposition = () => setPopStyle(popoverStyleFor(btnRef.current.getBoundingClientRect(), align));
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
      {open && popStyle && (
        <div
          id={popId}
          // Fixed + viewport-clamped (see popoverStyleFor) so the panel escapes
          // any overflow-hidden ancestor — e.g. the dashboard grid cell — and
          // never renders off-screen, on a narrow widget or near the viewport edge.
          style={popStyle}
          className="z-30 rounded-lg border border-port-border bg-port-card p-3 text-left shadow-xl"
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
