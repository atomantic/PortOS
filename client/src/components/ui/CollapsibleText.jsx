import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Long text collapsed to two lines with a Show more / Show less toggle.
 *
 * The overflow measurement runs against the *clamped* element, so the toggle
 * only appears when the text actually spills. It stays sticky once expanded —
 * the effect early-returns rather than re-measuring, because removing the clamp
 * collapses scrollHeight and would otherwise hide the toggle mid-expand — and is
 * recomputed on the collapsed path when the text changes, so an edit that
 * shortens the text clears a stale toggle. A ResizeObserver re-measures on width
 * changes (sidebar collapse, rotation, window resize) so text that wraps to a new
 * line at a narrower width still surfaces the toggle instead of silently
 * clamping with no affordance.
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
      {isOverflowing && (
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
