import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Long text collapsed to two lines with a Show more / Show less toggle.
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
export default function CollapsibleText({ id, text, className = '' }) {
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

  return (
    <>
      <p
        ref={ref}
        id={id}
        className={`whitespace-pre-wrap break-words ${className} ${expanded ? '' : 'line-clamp-2'}`}
      >
        {text}
      </p>
      {(isOverflowing || expanded) && (
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
