import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';

/**
 * The top of every stage tab: what this stage needs before it counts as done
 * (`stageChecklist(…)` items), each open item with what is still missing and,
 * where one exists, a button that scrolls to the control that settles it —
 * unless the header's next action already goes there (`headerAnchor`). A stale
 * approval lists a Revert button per changed input whose approved value was kept.
 */
export default function StageChecklist({ items, onAction, onRevert, headerAnchor = null }) {
  if (!items?.length) return null;
  const done = items.filter((item) => item.done).length;
  return (
    <section aria-label="What this step needs" className="min-w-0 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">What this step needs</h4>
        <span className={`text-xs ${done === items.length ? 'text-port-success' : 'text-port-text-muted'}`}>
          {done === items.length ? 'All done' : `${done} of ${items.length} done`}
        </span>
      </div>
      {/* A finished step needs no rows: one line names what was done, so the step's own work comes up sooner. */}
      {done === items.length ? <p className="mt-1 text-xs text-port-text-muted">{items.map((item) => item.label).join(' · ')}</p> : (
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          // The action wraps under the text on a phone instead of squeezing it into a narrow column.
          <li key={item.id} className="flex min-w-0 flex-wrap items-start gap-2 text-sm">
            {item.done
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-port-success" aria-label="done" />
              : <Circle size={16} className="mt-0.5 shrink-0 text-port-warning" aria-label={item.stale ? 'approved earlier, stale' : 'to do'} />}
            <div className="min-w-0 flex-1 basis-48">
              <span className={item.done ? 'text-port-text-muted' : ''}>{item.label}</span>
              {item.stale && <span className="ml-2 rounded bg-port-warning/10 px-1.5 py-0.5 text-xs text-port-warning">done · stale</span>}
              {!item.done && item.detail && <p className="break-words text-xs text-port-text-muted">{item.detail}</p>}
              {!item.done && item.details?.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-port-text-muted">
                  {item.details.map((text) => <li key={text} className="break-words">{text}</li>)}
                </ul>
              )}
              {!item.done && item.revert && onRevert && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {item.revert.fields.map((field) => (
                    <button key={field} type="button" onClick={() => onRevert(item.revert.stage, field)}
                      title="Put this back to the value you approved"
                      className="min-h-[44px] rounded border border-port-border px-2 py-1 text-xs text-port-accent sm:min-h-0">
                      Revert {field}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!item.done && item.action && onAction && item.action.anchor !== headerAnchor && (
              <button
                type="button"
                onClick={() => onAction(item.action)}
                className="ml-6 flex min-h-[44px] shrink-0 items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-port-accent sm:ml-0 sm:min-h-0"
              >
                {item.action.label} <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
