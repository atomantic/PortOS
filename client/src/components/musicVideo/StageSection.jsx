import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A stage panel group that folds away: a native `<details>` (so it works
 * without script and reads as a disclosure to assistive tech) with a one-line
 * summary beside the title, collapsed unless `defaultOpen`. The summary row is
 * the 44px tap target on a phone. `defaultOpen` sets the first state; a later
 * false → true change unfolds it (something now needs the director), but props
 * never fold it — only the director closes an open section.
 */
export default function StageSection({ id, title, summary = null, defaultOpen = false, children, className = '' }) {
  const ref = useRef(null);
  const [initialOpen] = useState(defaultOpen);
  const previous = useRef(defaultOpen);
  useEffect(() => {
    if (defaultOpen && !previous.current && ref.current) ref.current.open = true;
    previous.current = defaultOpen;
  }, [defaultOpen]);
  return (
    <details ref={ref} id={id} open={initialOpen || undefined} className={`group min-w-0 rounded-lg border border-port-border bg-port-card ${className}`}>
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center gap-2 px-3 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-port-text-muted transition-transform group-open:rotate-90" />
        <span className="min-w-0 break-words text-sm font-medium">{title}</span>
        {summary && <span className="min-w-0 truncate text-xs text-port-text-muted">{summary}</span>}
      </summary>
      <div className="min-w-0 space-y-2 px-3 pb-3">{children}</div>
    </details>
  );
}
