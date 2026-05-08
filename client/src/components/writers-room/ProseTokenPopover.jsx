import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

// ProseTokenPopover — single fixed-position card driven by hover events from
// inline tokens in ProseReader. Stateless w.r.t. open/close: WorkEditor passes
// `anchorEl` (the token's DOM element-or-null), `kind`, `refId`. The popover
// re-reads getBoundingClientRect on every reflow (scroll, resize, content
// height change) so the card stays attached to the token rather than
// freezing at the rect captured on hover. We resolve refId against the
// characters/settings/objects lists prop'd in.
//
// Hover semantics: 200ms open delay, 150ms close grace handled by the parent
// (WorkEditor) — this component just renders or doesn't.

// Conservative height estimate for the popover. The actual rendered height
// varies (rows/missing/aliases) but is bounded by a hard CSS ceiling on
// content; using a single number keeps the math simple and avoids a
// measure→reposition flicker. A ResizeObserver in the component body
// refines the position any time the popover's actual height changes
// post-mount (font load, dynamic content, viewport changes).
const POPOVER_EST_HEIGHT = 220;
const POPOVER_WIDTH = 320;
const GAP = 6;
const EDGE_PAD = 8;

function clampToViewport(rect, measuredHeight) {
  if (!rect) return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = POPOVER_WIDTH;
  const h = measuredHeight && measuredHeight > 0 ? measuredHeight : POPOVER_EST_HEIGHT;
  const left = Math.max(EDGE_PAD, Math.min(W - w - EDGE_PAD, rect.left));
  // Flip above the token when there isn't room below for the popover height
  // (was incorrectly comparing against w/2).
  const wouldOverflowBelow = rect.bottom + GAP + h > H - EDGE_PAD;
  const flipped = wouldOverflowBelow && rect.top - GAP - h >= EDGE_PAD;
  const top = flipped
    ? rect.top - GAP - h
    : Math.min(rect.bottom + GAP, Math.max(EDGE_PAD, H - EDGE_PAD - h));
  return { left, top, width: w };
}

function resolveProfile({ kind, refId, characters, settings, objects }) {
  if (kind === 'char') return characters.find((c) => c.id === refId) || null;
  if (kind === 'place') return settings.find((s) => s.id === refId) || null;
  if (kind === 'object') return objects.find((o) => o.id === refId) || null;
  return null;
}

function fieldRows(kind, profile) {
  if (!profile) return [];
  if (kind === 'char') {
    return [
      ['Role', profile.role],
      ['Appearance', profile.physicalDescription],
      ['Personality', profile.personality],
      ['Background', profile.background],
    ].filter(([, v]) => v && String(v).trim());
  }
  if (kind === 'place') {
    return [
      ['Slugline', profile.slugline],
      ['Era', profile.era],
      ['Weather', profile.weather],
      ['Description', profile.description],
      ['Recurring', profile.recurringDetails],
    ].filter(([, v]) => v && String(v).trim());
  }
  if (kind === 'object') {
    return [
      ['Description', profile.description],
      ['Significance', profile.significance],
    ].filter(([, v]) => v && String(v).trim());
  }
  return [];
}

const KIND_DOT = {
  char: 'bg-port-accent',
  place: 'bg-blue-400',
  object: 'bg-amber-400',
};
const KIND_LABEL = {
  char: 'Character',
  place: 'Setting',
  object: 'Object',
};

export default function ProseTokenPopover({
  open,
  pinned,
  anchorEl,
  kind,
  refId,
  characters = [],
  settings = [],
  objects = [],
  onOpenProfile,
  onClose,
  onPopoverEnter,
  onPopoverLeave,
}) {
  const [pos, setPos] = useState(null);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!open || !anchorEl) { setPos(null); return; }
    setPos(clampToViewport(anchorEl.getBoundingClientRect()));
  }, [open, anchorEl]);

  // Once the popover has rendered, observe its actual size and reposition
  // whenever the height changes (font load, dynamic content, viewport
  // resize). The initial estimate-based pos avoids a first-paint flicker.
  // Also re-reads the anchor's live getBoundingClientRect on every reflow so
  // scroll-induced position drift is corrected. Listens for window scroll
  // (capture, so any scrolling ancestor triggers it) and resize so a pinned
  // popover stays attached to its token even as the user scrolls the prose.
  // Reflow is throttled via requestAnimationFrame so a fast scrollwheel
  // can't queue dozens of layout reads per frame; the scroll listener is
  // passive so it doesn't block scrolling itself.
  useEffect(() => {
    if (!open || !anchorEl || !cardRef.current) return undefined;
    const el = cardRef.current;
    const doReflow = () => {
      const rect = anchorEl.getBoundingClientRect();
      const measured = el.offsetHeight;
      const next = clampToViewport(rect, measured);
      if (!next) return;
      setPos((prev) => (
        prev && next.top === prev.top && next.left === prev.left && next.width === prev.width
          ? prev
          : next
      ));
    };
    let rafHandle = 0;
    const reflow = () => {
      if (rafHandle) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = 0;
        doReflow();
      });
    };
    doReflow();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(reflow);
      ro.observe(el);
    }
    const scrollOpts = { capture: true, passive: true };
    window.addEventListener('scroll', reflow, scrollOpts);
    window.addEventListener('resize', reflow);
    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      if (ro) ro.disconnect();
      window.removeEventListener('scroll', reflow, scrollOpts);
      window.removeEventListener('resize', reflow);
    };
  }, [open, anchorEl, refId, kind]);

  const handleMouseEnter = useCallback(() => {
    onPopoverEnter?.();
  }, [onPopoverEnter]);
  const handleMouseLeave = useCallback(() => {
    if (pinned) return;
    onPopoverLeave?.();
  }, [pinned, onPopoverLeave]);

  // Close on Escape when pinned (mirrors the dropdown patterns in this folder).
  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, onClose]);

  if (!open || !pos) return null;

  const profile = resolveProfile({ kind, refId, characters, settings, objects });
  if (!profile) return null;

  const rows = fieldRows(kind, profile);
  const missing = Array.isArray(profile.missingFromProse) ? profile.missingFromProse : [];
  const aliases = Array.isArray(profile.aliases) ? profile.aliases.filter(Boolean) : [];

  // Use role="dialog" because the popover contains interactive controls
  // (Close button when pinned, Open profile button always). role="tooltip"
  // is only correct for non-interactive descriptive content.
  // aria-modal=false: this popover doesn't trap focus or block the page; it's
  // a non-modal floating panel.
  const a11yLabel = `${KIND_LABEL[kind] || 'Profile'}: ${profile.name || profile.slugline || ''}`;
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-label={a11yLabel}
      style={{ left: pos.left, top: pos.top, width: pos.width, position: 'fixed' }}
      className="z-40 bg-port-card border border-port-border rounded-lg shadow-2xl p-3 text-xs text-gray-200"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${KIND_DOT[kind] || 'bg-gray-400'}`} />
        <span className="font-semibold text-white text-[13px] truncate">{profile.name || profile.slugline}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-500">{KIND_LABEL[kind]}</span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {aliases.length > 0 && (
        <div className="mb-2 text-[10px] text-gray-400">
          a.k.a. {aliases.join(', ')}
        </div>
      )}

      {rows.length === 0 && (
        <div className="text-gray-500 italic mb-2">No profile details yet.</div>
      )}
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2 py-1 border-t border-port-border/60 first:border-t-0">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 w-20 shrink-0 pt-0.5">{k}</span>
          <span className="text-gray-200 flex-1 leading-snug">{v}</span>
        </div>
      ))}

      {missing.length > 0 && (
        <div className="mt-2 pt-2 border-t border-port-border/60">
          <div className="text-[10px] uppercase tracking-wider text-port-warning mb-1">Missing from prose</div>
          <div className="flex flex-wrap gap-1">
            {missing.slice(0, 6).map((m, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-port-warning/15 text-port-warning">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => onOpenProfile?.({ kind, refId })}
        className="mt-3 w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] bg-port-bg hover:bg-port-bg/60 border border-port-border text-gray-300 hover:text-white"
      >
        <ExternalLink size={11} /> Open profile
      </button>
    </div>
  );
}
