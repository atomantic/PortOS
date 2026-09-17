import { Children, useCallback, useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// Tailwind scans source for literal class names, so the clamp variants must
// appear as whole strings — a computed `line-clamp-${lines}` compiles to nothing
// and the "clamped" preview silently renders full height.
const CLAMP_CLASS = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
  6: 'line-clamp-6'
};

/**
 * Long content collapsed to a short preview with a Show more / Show less toggle.
 *
 * Two clamp strategies, picked by which content prop you pass:
 *
 * 1. **`text` (line-clamp)** — the default. `lines` (default 2) picks the clamp
 *    depth; only the values in `CLAMP_CLASS` are supported, since Tailwind needs
 *    the literal class name in source.
 * 2. **`children` (max-height)** — for content CSS `line-clamp` cannot clamp:
 *    rendered markdown and anything else that emits *block* children, where
 *    `line-clamp` applies to the container's own inline content and silently
 *    does nothing. `maxHeight` (default `3.5rem`) caps the collapsed preview.
 *    Passing `children` wins over `text`.
 *
 * `expandedContent` lets a `text` caller swap in richer markup once the user
 * opts in — e.g. a card that previews arbitrary markdown as flattened plain text
 * (so the clamp works and foreign headings stay out of the page outline) but
 * renders the real markdown on expand. When omitted, expanding just unclamps
 * `text`. It and `expandedClassName` are `text`-mode only: a `children` caller
 * already holds the rich markup, and expanding simply lifts the height cap off
 * it — the children stay mounted throughout, so there is nothing to swap in.
 *
 * `forceToggle` shows the toggle even when the preview fits. It exists for the
 * `expandedContent` case: there, the toggle is the ONLY route to the rich
 * content, so gating it purely on overflow strands a short-but-lossy body —
 * a one-line description holding a link or an image would render as inert
 * flattened text with no way to reach the real markup. Callers pass it when
 * the preview is lossy, not merely when it is truncated.
 *
 * The overflow measurement runs against the *clamped* element, so the toggle
 * only appears when the content actually spills. It is recomputed on the
 * collapsed path when `text` changes, so an edit that shortens the text clears a
 * stale toggle. A ResizeObserver re-measures on width changes (sidebar collapse,
 * rotation, window resize) so content that wraps to a new line at a narrower
 * width still surfaces the toggle instead of silently clamping with no
 * affordance.
 *
 * In `children` mode the observer is attached to the *inner* wrapper as well as
 * the clamped outer one. The outer element is height-capped, so growing children
 * never change its box and a resize callback bound to it alone would never fire;
 * the inner wrapper is uncapped, so its height tracks the real content and a
 * changed child re-measures without needing `children` (a fresh element object
 * every render, which would churn the observer on every parent re-render) in the
 * effect deps. Switching *modes* still has to re-run it, though — the rendered
 * element swaps between `<p>` and the capped `<div>`, so the effect's captured
 * element would otherwise stay bound to the detached one and never measure.
 * That's what `hasChildren` (a stable boolean) is doing in the deps.
 *
 * Two separate guards keep the toggle from vanishing mid-expand (which would
 * strand the user in the expanded wall of text with no way back): the effect
 * early-returns while expanded rather than re-measuring an unclamped element,
 * AND the render gates on `isOverflowing || expanded`. The second is not
 * redundant — expanding *is* a resize of the observed element, and the observer
 * is still connected at that moment (its `disconnect()` runs in passive-effect
 * cleanup, which the scheduler may flush after the browser delivers the resize
 * notification). Without the `|| expanded` term that in-flight callback can
 * measure the now-unclamped element, see no overflow, and drop the toggle.
 *
 * `onExpand` fires the first time the reader opens the preview, for content the
 * caller only fetches on demand — a card whose listing payload carries a
 * truncated copy hydrates the rest here rather than downloading it for every row
 * up front. It is called once per mount, not on every toggle, so re-collapsing
 * and re-expanding never re-fetches.
 *
 * `id` is required: it wires the toggle's `aria-controls` to the content it expands.
 */

// The 1px slack absorbs sub-pixel line-height rounding, which otherwise reports
// a phantom overflow on content that fits exactly.
const overflows = el => el.scrollHeight > el.clientHeight + 1;

export default function CollapsibleText({
  id,
  text,
  children = null,
  maxHeight = '3.5rem',
  className = '',
  lines = 2,
  expandedContent = null,
  expandedClassName = '',
  forceToggle = false,
  onExpand = null
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const ref = useRef(null);
  const innerRef = useRef(null);
  const expandedOnceRef = useRef(false);

  // `onExpand` is deliberately NOT fired from inside the `setExpanded` updater:
  // React may invoke an updater more than once (StrictMode double-invoke), and a
  // hydration fetch must not ride a function the renderer is free to replay.
  const open = useCallback(() => {
    if (!expandedOnceRef.current) {
      expandedOnceRef.current = true;
      onExpand?.();
    }
    setExpanded(true);
  }, [onExpand]);
  // An empty list or an empty string is *no* children, not "children that
  // happen to be blank" — a caller doing `<CollapsibleText text={fallback}>
  // {items.map(…)}</CollapsibleText>` over an empty list must get the text
  // fallback, not an empty capped box with its `text` silently dropped.
  // Array *length* is the wrong signal: `items.map(i => i.show ? <Row/> : null)`
  // over an all-hidden list yields `[null]` — length 1, renders nothing.
  // `Children.toArray` drops exactly those non-rendering placeholders (`null`,
  // `undefined`, booleans) and flattens nested arrays; empty/whitespace strings
  // survive it, so they're filtered here too.
  const hasChildren = Children.toArray(children).some(
    child => typeof child !== 'string' || child.trim() !== ''
  );

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => setIsOverflowing(overflows(el));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [text, hasChildren, expanded]);

  const clamp = CLAMP_CLASS[lines] || CLAMP_CLASS[2];

  const renderContent = () => {
    if (hasChildren) {
      return (
        <div
          ref={ref}
          id={id}
          className={`break-words ${className} ${expanded ? '' : 'overflow-hidden'}`}
          style={expanded ? undefined : { maxHeight }}
          // `overflow-hidden` is a scroll container with no visible scrollbar,
          // and children may hold links, buttons or a horizontally-scrollable
          // <pre>. Tabbing to one below the cap would scroll the preview to
          // reveal it with no way to scroll back — and `aria-expanded="false"`
          // would be a lie, since the content is fully in the tab order.
          // Expanding on focus keeps the claim honest and the target on screen.
          // Gated on real overflow: content that fits is never clipped, so
          // expanding it would only mint a no-op "Show less" into the tab order.
          // Measured live rather than read off `isOverflowing`: a descendant with
          // `autoFocus` takes focus during commit, before the passive measure
          // effect has run, so the state flag is still false on that first focus.
          onFocus={() => { if (ref.current && overflows(ref.current)) open(); }}
        >
          <div ref={innerRef}>{children}</div>
        </div>
      );
    }
    if (expanded && expandedContent) {
      return <div id={id} className={`break-words ${className} ${expandedClassName}`}>{expandedContent}</div>;
    }
    return (
      <p
        ref={ref}
        id={id}
        className={`whitespace-pre-wrap break-words ${className} ${expanded ? '' : clamp}`}
      >
        {text}
      </p>
    );
  };

  return (
    <>
      {renderContent()}
      {(isOverflowing || expanded || forceToggle) && (
        <button
          type="button"
          onClick={() => (expanded ? setExpanded(false) : open())}
          className="flex items-center gap-0.5 mt-0.5 text-xs text-port-accent hover:text-port-accent/80 transition-colors"
          aria-expanded={expanded}
          aria-controls={id}
        >
          {expanded ? (
            <><ChevronUp size={12} aria-hidden="true" /> Show less</>
          ) : (
            <><ChevronDown size={12} aria-hidden="true" /> Show more</>
          )}
        </button>
      )}
    </>
  );
}
