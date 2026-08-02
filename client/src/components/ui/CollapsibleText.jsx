import { useState, useRef, useEffect } from 'react';
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
 * Long text collapsed to a few lines with a Show more / Show less toggle.
 *
 * `lines` (default 2) picks the clamp depth; only the values in `CLAMP_CLASS`
 * are supported, since Tailwind needs the literal class name in source.
 *
 * `expandedContent` lets a caller swap in richer markup once the user opts in —
 * e.g. a card that previews arbitrary markdown as flattened plain text (so the
 * clamp works and foreign headings stay out of the page outline) but renders
 * the real markdown on expand. When omitted, expanding just unclamps `text`.
 *
 * `forceToggle` shows the toggle even when the preview fits. It exists for the
 * `expandedContent` case: there, the toggle is the ONLY route to the rich
 * content, so gating it purely on overflow strands a short-but-lossy body —
 * a one-line description holding a link or an image would render as inert
 * flattened text with no way to reach the real markup. Callers pass it when
 * the preview is lossy, not merely when it is truncated.
 *
 * The overflow measurement runs against the *clamped* element, so the toggle
 * only appears when the text actually spills. It is recomputed on the collapsed
 * path when the text changes, so an edit that shortens the text clears a stale
 * toggle. A ResizeObserver re-measures on width changes (sidebar collapse,
 * rotation, window resize) so text that wraps to a new line at a narrower width
 * still surfaces the toggle instead of silently clamping with no affordance.
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
 * `id` is required: it wires the toggle's `aria-controls` to the text it expands.
 */
export default function CollapsibleText({
  id,
  text,
  className = '',
  lines = 2,
  expandedContent = null,
  expandedClassName = '',
  forceToggle = false
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  const clamp = CLAMP_CLASS[lines] || CLAMP_CLASS[2];

  return (
    <>
      {expanded && expandedContent ? (
        <div id={id} className={`break-words ${className} ${expandedClassName}`}>{expandedContent}</div>
      ) : (
        <p
          ref={ref}
          id={id}
          className={`whitespace-pre-wrap break-words ${className} ${expanded ? '' : clamp}`}
        >
          {text}
        </p>
      )}
      {(isOverflowing || expanded || forceToggle) && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
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
