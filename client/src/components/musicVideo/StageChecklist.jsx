import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import StaleApprovalActions from './StaleApprovalActions.jsx';

/**
 * The top of every stage tab: what this stage needs before it counts as done
 * (`stageChecklist(…)` items), each open item with what is still missing and,
 * where one exists, a button that settles it: an `anchor` scrolls to the
 * control, a `run` starts the work itself (`onAction` gets either) — unless the
 * header's next action already goes there (`headerAnchor`). An item may add a
 * quieter `secondary` choice beside it. Run buttons wait while `busy`. A stale
 * approval offers a Revert per changed input whose approved value was kept
 * (folded behind "See N changes" when there are several).
 * An `optional` item is listed but never counted toward the step being done.
 * A finished step shows nothing: the step tab already says it is done.
 * An item's `notes` (open change requests) each get a Mark resolved button,
 * which calls `onAction({ run: 'resolve-feedback', feedbackId })`. An item's `shots`
 * each get a button that calls `onAction({ editShot: sceneId })`.
 */
export default function StageChecklist({ items, onAction, onRevert, headerAnchor = null, busy = false }) {
  if (!items?.length) return null;
  const required = items.filter((item) => !item.optional);
  const done = required.filter((item) => item.done).length;
  if (done === required.length) return null;
  return (
    <section aria-label="What this step needs" className="min-w-0 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">What this step needs</h4>
        <span className="text-xs text-port-text-muted">{`${done} of ${required.length} done`}</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          // The action wraps under the text on a phone instead of squeezing it into a narrow column.
          <li key={item.id} className="flex min-w-0 flex-wrap items-start gap-2 text-sm">
            {item.done
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-port-success" aria-label="done" />
              : <Circle size={16} className={`mt-0.5 shrink-0 ${item.optional ? 'text-port-text-muted' : 'text-port-warning'}`} aria-label={item.optional ? 'optional' : item.stale ? 'approved earlier, stale' : 'to do'} />}
            <div className="min-w-0 flex-1 basis-48">
              <span className={item.done ? 'text-port-text-muted' : ''}>{item.label}</span>
              {item.stale && <span className="ml-2 rounded bg-port-warning/10 px-1.5 py-0.5 text-xs text-port-warning">done · stale</span>}
              {!item.done && item.detail && <p className="break-words text-xs text-port-text-muted">{item.detail}</p>}
              {!item.done && item.details?.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-port-text-muted">
                  {item.details.map((text) => <li key={text} className="break-words">{text}</li>)}
                </ul>
              )}
              {/* Shots the row is about: each opens its card, beside what the row says about it. */}
              {!item.done && item.shots?.length > 0 && (
                <ul aria-label={`${item.label} shots`} className="mt-1 space-y-1">
                  {item.shots.map((shot) => (
                    <li key={shot.sceneId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {onAction ? (
                        <button type="button" onClick={() => onAction({ label: shot.label, editShot: shot.sceneId })}
                          className="min-h-[44px] shrink-0 rounded border border-port-border px-2 py-1 text-port-accent sm:min-h-0">
                          {shot.label}
                        </button>
                      ) : <strong className="shrink-0">{shot.label}</strong>}
                      <span className="min-w-0 flex-1 basis-40 break-words text-port-text-muted">{shot.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {/* Open change requests: each note names its target and settles with its own button. */}
              {!item.done && item.notes?.length > 0 && (
                <ul aria-label="Open change requests" className="mt-1 space-y-1">
                  {item.notes.map((note) => (
                    <li key={note.id} className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-xs">
                      <span className="min-w-0 flex-1 basis-40 break-words"><strong>{note.target}</strong>: {note.text}</span>
                      {onAction && (
                        <button type="button" disabled={busy} aria-label={`Mark resolved: ${note.target}`}
                          onClick={() => onAction({ label: 'Mark resolved', run: 'resolve-feedback', feedbackId: note.id })}
                          className="min-h-[44px] shrink-0 rounded border border-port-border px-2 py-1 text-xs text-port-accent disabled:opacity-50 sm:min-h-0">
                          Mark resolved
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!item.done && item.revert && onRevert && (
                <div className="mt-1">
                  <StaleApprovalActions revertible={item.revert.fields} busy={busy} onRevert={(field) => onRevert(item.revert.stage, field)} />
                </div>
              )}
            </div>
            {!item.done && onAction && (
              <div className="ml-6 flex shrink-0 flex-wrap items-center gap-1.5 sm:ml-0">
                {[item.action, item.secondary].filter((action) => action && (action.run || action.anchor !== headerAnchor)).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => onAction(action)}
                    disabled={action.disabled || (!!action.run && busy)}
                    title={action.reason}
                    className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0 ${action === item.action
                      ? (action.run ? 'bg-port-accent font-medium text-white' : 'border border-port-border text-port-accent')
                      : 'text-port-text-muted hover:text-port-accent'}`}
                  >
                    {action.label} {!action.run && <ArrowRight size={12} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
