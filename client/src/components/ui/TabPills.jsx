// Shared tab-nav primitive. Three visual families: `underline` (default — flat
// bottom border with port-accent marker; used across page-level tabs),
// `pills` (rounded card with internal pill rows; used by UniverseBuilder), and
// `filter` (pills' markup, toggle-button semantics). `filter` exists because a
// faceted count chip row (Settings > AI Assignments) narrows rows in place
// rather than swapping panels: a tab promises a panel it never shows, so those
// chips are a `role="group"` of `aria-pressed` buttons — the same semantics the
// app's other toggle filters use — while sharing this component's styling.
//
// `mobileCompact` is the phone treatment for a bar with more tabs than fit at
// 375px. It collapses to an ICON-ONLY row below `sm` — same buttons, same
// tablist, labels kept for screen readers — with chevrons at whichever edge is
// still scrollable. That is a deliberate product preference over a `<select>`
// (#7283 swapped to one and it reads as a form control, not navigation): icons
// keep every destination one tap away and keep the bar looking like a nav.
// A tab list where any tab has no icon has nothing to render in that row and
// falls back to the labelled `<select>`. That is for the lists icons genuinely
// cannot serve — an unbounded, data-driven one, like FableLoomStory's episodes,
// where every entry would draw the same glyph. A FIXED set of sections is not
// that case: give it icons rather than letting it fall through here. The
// fallback's wrapper is `sm:hidden` unless `mobileSelectClassName` replaces it
// (a caller passes that to make the select a flex sibling sharing one row with
// other controls, `sm:hidden min-w-0 flex-1` in FableLoomStory's episode row,
// and the replacement must carry its own `sm:hidden` or the select shows on
// desktop). `mobileSelectId` pairs a real `<label htmlFor>` with that fallback.
//
// Other knobs cover the call-site quirks: `runningKind` swaps a per-tab icon
// for a spinner; `stretch` makes each tab `flex-1` (StoryboardPanel);
// `controlsIdPrefix` wires `aria-controls` (and `id="tab-<id>"`) to matching
// tabpanels — pass `'tabpanel'` to mirror ChiefOfStaff's wiring. `t.trailing`
// is an optional ReactNode rendered after the count (e.g. PipelineIssue's
// per-stage status dot).
import { useRef, useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

const SIZE = {
  xs: { text: 'text-[11px]', icon: 11, padding: 'px-2 py-2', gap: 'gap-1' },
  sm: { text: 'text-sm', icon: 14, padding: 'px-3 py-1.5', gap: 'gap-1.5' },
  md: { text: 'text-sm', icon: 16, padding: 'px-3 sm:px-4 py-3', gap: 'gap-2' },
};

// Chevrons are the only overflow cue an icon row gets — with labels gone there
// is no half-clipped word hinting that the strip continues. They sit in flow
// beside the strip rather than over it, so they never cover a destination.
const ARROW_CLASS = 'sm:hidden shrink-0 flex items-center justify-center self-stretch px-1 text-gray-400 hover:text-white';

export default function TabPills({
  tabs,
  activeTab,
  onChange,
  variant = 'underline',
  size = 'md',
  stretch = false,
  runningKind = null,
  mobileCompact = false,
  mobileSelectId,
  mobileSelectClassName = '',
  ariaLabel,
  controlsIdPrefix,
  className = '',
}) {
  const sz = SIZE[size] || SIZE.md;
  const visibleTabs = tabs.filter(Boolean);
  const tabRefs = useRef([]);
  const stripRef = useRef(null);
  // Widest scrollLeft the strip can reach. Held in a ref because it only moves
  // on resize or a tab-count change — reading `scrollWidth` per scroll event
  // would force a layout flush on every frame of a momentum scroll.
  const maxScrollRef = useRef(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const enabledTabIndexes = visibleTabs
    .map((tab, index) => (tab.disabled ? null : index))
    .filter((index) => index !== null);

  const activeIndex = visibleTabs.findIndex((t) => t.id === activeTab);

  // Icons ARE the row in compact mode, so one iconless tab disqualifies the
  // whole bar rather than rendering a gap the user can't aim at.
  const iconRow = mobileCompact && visibleTabs.every((t) => t.icon);
  const selectFallback = mobileCompact && !iconRow;

  // Reveal only inside the horizontal tab strip. scrollIntoView also scrolls
  // ancestors, pulling a mobile page away from its task form/content.
  useEffect(() => {
    const tab = tabRefs.current[activeIndex];
    const strip = tab?.parentElement;
    if (!strip || variant === 'filter') return;
    const bounds = strip.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    const left = bounds.left + strip.clientLeft;
    const right = left + strip.clientWidth;
    const delta = tabBounds.left < left
      ? tabBounds.left - left
      : Math.max(0, tabBounds.right - right);
    if (delta) strip.scrollBy({ left: delta, behavior: 'smooth' });
  }, [activeTab, activeIndex, variant]);

  // Scroll path: position only, against the cached extent.
  const syncPosition = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setCanScrollLeft(strip.scrollLeft > 1);
    setCanScrollRight(strip.scrollLeft < maxScrollRef.current - 1);
  }, []);

  // Extent path: re-measure whenever the strip's width or its tab count moves,
  // neither of which fires `scroll`.
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    maxScrollRef.current = strip.scrollWidth - strip.clientWidth;
    syncPosition();
  }, [syncPosition]);

  useEffect(() => { if (iconRow) measure(); }, [iconRow, measure, visibleTabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!iconRow || !strip || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [iconRow, measure]);

  const scrollStrip = (direction) => {
    const strip = stripRef.current;
    if (strip) strip.scrollBy({ left: direction * strip.clientWidth * 0.8, behavior: 'smooth' });
  };

  const handleTabKeyDown = (event, index) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }

    const currentPosition = enabledTabIndexes.indexOf(index);
    if (currentPosition === -1 || enabledTabIndexes.length === 0) {
      return;
    }

    let targetPosition;
    if (event.key === 'Home') {
      targetPosition = 0;
    } else if (event.key === 'End') {
      targetPosition = enabledTabIndexes.length - 1;
    } else {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      targetPosition = (currentPosition + direction + enabledTabIndexes.length) % enabledTabIndexes.length;
    }

    const targetIndex = enabledTabIndexes[targetPosition];
    const targetTab = visibleTabs[targetIndex];
    event.preventDefault();
    onChange(targetTab.id);
    tabRefs.current[targetIndex]?.focus({ preventScroll: true });
  };

  // ONE label node either way. Compact mode reaches for `sr-only` (takes no
  // layout, still read aloud) rather than a `hidden` + `sr-only` pair: two
  // copies of the word would each land in the accessible name, renaming every
  // tab to "Agents Agents" for a screen reader and for `getByRole` alike. It is
  // scoped with `max-sm:` rather than undone with `sm:not-sr-only` because that
  // utility also resets `white-space` and `overflow`, which would unpick the
  // `whitespace-nowrap` and `truncate` the desktop row depends on.
  const renderLabel = (label, truncate = false) => label && (
    <span className={[iconRow && 'max-sm:sr-only', truncate && 'truncate'].filter(Boolean).join(' ')}>{label}</span>
  );

  // Mobile `<select>` collapse for bars that cannot render an icon row, shared
  // by both variants so `mobileCompact` works regardless of `variant`.
  const mobileSelect = selectFallback ? (
    <div className={mobileSelectClassName || 'sm:hidden'}>
      {mobileSelectId && <label htmlFor={mobileSelectId} className="sr-only">{ariaLabel || 'Section'}</label>}
      <select
        id={mobileSelectId}
        value={activeTab}
        onChange={(e) => onChange(e.target.value)}
        aria-label={mobileSelectId ? undefined : (ariaLabel || 'Section')}
        className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent min-h-[40px]"
      >
        {visibleTabs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}{t.count != null && t.count > 0 ? ` (${t.count})` : ''}
          </option>
        ))}
      </select>
    </div>
  ) : null;

  // One strip, wrapped in an arrow row only when compact — an extra flex
  // wrapper on every bar would break the callers that size this thing. The
  // wrapper IS the bar when it exists, so the caller's `className` and the
  // underline move onto it; the strip keeps only what makes it the scroller.
  const withArrows = (strip) => (iconRow ? (
    <div className={`flex min-w-0 items-stretch ${variant === 'underline' ? 'border-b border-port-border' : ''} ${className}`}>
      {canScrollLeft && (
        <button type="button" onClick={() => scrollStrip(-1)} aria-label="Scroll tabs left" className={ARROW_CLASS}>
          <ChevronLeft size={18} />
        </button>
      )}
      {strip}
      {canScrollRight && (
        <button type="button" onClick={() => scrollStrip(1)} aria-label="Scroll tabs right" className={ARROW_CLASS}>
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  ) : strip);

  if (variant === 'pills' || variant === 'filter') {
    const isFilter = variant === 'filter';
    return (
      <>
        {mobileSelect}
        {withArrows(
          <div
            ref={stripRef}
            onScroll={iconRow ? syncPosition : undefined}
            className={`${selectFallback ? 'hidden sm:flex' : 'flex'} ${iconRow ? 'min-w-0 flex-1' : `shrink-0 ${className}`} items-center gap-1 bg-port-card border border-port-border rounded p-1 overflow-x-auto scrollbar-hide touch-pan-x`}
            role={isFilter ? 'group' : 'tablist'}
            aria-label={ariaLabel}
          >
            {visibleTabs.map((t, index) => {
              const Icon = t.icon;
              const active = t.id === activeTab;
              const running = runningKind && t.runningKind === runningKind;
              return (
                <button
                  key={t.id}
                  type="button"
                  role={isFilter ? undefined : 'tab'}
                  aria-selected={isFilter ? undefined : active}
                  aria-pressed={isFilter ? active : undefined}
                  aria-controls={!isFilter && controlsIdPrefix ? `${controlsIdPrefix}-${t.id}` : undefined}
                  id={!isFilter && controlsIdPrefix ? `tab-${t.id}` : undefined}
                  ref={!isFilter ? (node) => { tabRefs.current[index] = node; } : undefined}
                  tabIndex={!isFilter ? (active ? 0 : -1) : undefined}
                  disabled={t.disabled}
                  onClick={() => onChange(t.id)}
                  onKeyDown={!isFilter ? (event) => handleTabKeyDown(event, index) : undefined}
                  className={`flex items-center ${sz.gap} ${sz.padding} rounded ${sz.text} transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                      : 'text-gray-300 hover:bg-port-bg border border-transparent'
                  } ${t.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {running
                    ? <Loader2 size={sz.icon} className="animate-spin shrink-0" />
                    : (Icon && <Icon size={sz.icon} aria-hidden="true" className="shrink-0" />)}
                  {renderLabel(t.label)}
                  {t.count != null && t.count > 0 && (
                    <span className={`text-[10px] ${active ? 'text-port-accent/70' : 'text-gray-500'}`}>
                      {t.count}
                    </span>
                  )}
                  {t.trailing}
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  }

  // underline variant
  return (
    <>
      {mobileSelect}
      {withArrows(
        <div
          ref={stripRef}
          onScroll={iconRow ? syncPosition : undefined}
          className={`${selectFallback ? 'hidden sm:flex' : 'flex'} ${iconRow ? 'min-w-0 flex-1' : `shrink-0 border-b border-port-border ${className}`} ${stretch ? 'items-stretch bg-port-bg/40' : 'gap-1'} overflow-x-auto scrollbar-hide touch-pan-x`}
          role="tablist"
          aria-label={ariaLabel}
        >
          {visibleTabs.map((t, index) => {
            const Icon = t.icon;
            const active = t.id === activeTab;
            const running = runningKind && t.runningKind === runningKind;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={controlsIdPrefix ? `${controlsIdPrefix}-${t.id}` : undefined}
                id={controlsIdPrefix ? `tab-${t.id}` : undefined}
                ref={(node) => { tabRefs.current[index] = node; }}
                tabIndex={active ? 0 : -1}
                disabled={t.disabled}
                onClick={() => onChange(t.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={`flex items-center ${stretch ? 'flex-1 min-w-0 justify-center' : 'shrink-0 justify-center'} ${sz.gap} ${sz.padding} ${sz.text} font-medium transition-colors whitespace-nowrap min-h-[44px] sm:min-h-[40px] border-b-2 -mb-px ${
                  active
                    ? 'text-port-accent border-port-accent bg-port-accent/5'
                    : 'text-gray-400 border-transparent hover:text-white hover:bg-port-card'
                } ${t.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {running
                  ? <Loader2 size={sz.icon} className="animate-spin shrink-0" />
                  : (Icon && <Icon size={sz.icon} aria-hidden="true" className="shrink-0" />)}
                {renderLabel(t.label, stretch)}
                {t.count != null && t.count > 0 && (
                  <span className={`text-[10px] ${active ? 'text-port-accent/70' : 'text-gray-500'}`}>
                    {t.count}
                  </span>
                )}
                {t.trailing}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
