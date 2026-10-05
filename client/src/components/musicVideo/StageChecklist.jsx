import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';

/**
 * The top of every stage tab: what this stage needs before it counts as done
 * (`stageChecklist(…)` items), each open item with what is still missing and,
 * where one exists, a button that scrolls to the control that settles it —
 * unless the header's next action already goes there (`headerAnchor`).
 */
export default function StageChecklist({ items, onAction, headerAnchor = null }) {
  if (!items?.length) return null;
  const done = items.filter((item) => item.done).length;
  return (
    <section aria-label="What this stage needs" className="min-w-0 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">What this stage needs</h4>
        <span className={`text-xs ${done === items.length ? 'text-port-success' : 'text-port-text-muted'}`}>
          {done === items.length ? 'All done' : `${done} of ${items.length} done`}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-2 text-sm">
            {item.done
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-port-success" aria-label="done" />
              : <Circle size={16} className="mt-0.5 shrink-0 text-port-warning" aria-label={item.stale ? 'approved earlier, stale' : 'to do'} />}
            <div className="min-w-0 flex-1">
              <span className={item.done ? 'text-port-text-muted' : ''}>{item.label}</span>
              {item.stale && <span className="ml-2 rounded bg-port-warning/10 px-1.5 py-0.5 text-xs text-port-warning">done · stale</span>}
              {!item.done && item.detail && <p className="break-words text-xs text-port-text-muted">{item.detail}</p>}
            </div>
            {!item.done && item.action && onAction && item.action.anchor !== headerAnchor && (
              <button
                type="button"
                onClick={() => onAction(item.action)}
                className="flex min-h-[44px] shrink-0 items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-port-accent sm:min-h-0"
              >
                {item.action.label} <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
