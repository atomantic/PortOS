import { ChevronRight } from 'lucide-react';

/**
 * A stage panel group that folds away: a native `<details>` (so it works
 * without script and reads as a disclosure to assistive tech) with a one-line
 * summary beside the title, collapsed unless `defaultOpen`. The summary row is
 * the 44px tap target on a phone.
 */
export default function StageSection({ id, title, summary = null, defaultOpen = false, children, className = '' }) {
  return (
    <details id={id} open={defaultOpen || undefined} className={`group min-w-0 rounded-lg border border-port-border bg-port-card ${className}`}>
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center gap-2 px-3 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-port-text-muted transition-transform group-open:rotate-90" />
        <span className="shrink-0 text-sm font-medium">{title}</span>
        {summary && <span className="min-w-0 truncate text-xs text-port-text-muted">{summary}</span>}
      </summary>
      <div className="min-w-0 space-y-2 px-3 pb-3">{children}</div>
    </details>
  );
}
