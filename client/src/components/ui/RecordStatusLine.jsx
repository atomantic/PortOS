import { ArrowRight } from 'lucide-react';

const TONES = {
  error: 'text-port-error',
  muted: 'text-port-text-muted',
  ok: 'text-port-success',
  warn: 'text-port-warning',
};

/**
 * The one "where does this record stand" row under a multi-stage record's
 * title: a headline naming the current stage in words (toned `warn` when it
 * waits on the user, `error` when it failed), short facts, and at most one
 * next-action button. Mirrors the Music Video header's status line (#9858) for
 * the pages that don't share its layout.
 *
 * `status` is `{ headline, tone, facts: [{ id, label, tone }] }`; `nextAction`
 * is `{ label, reason?, disabled?, icon? }` or null. `leading` is an optional
 * node (a back link) that sits before the status text.
 */
export default function RecordStatusLine({
  status, nextAction = null, onNextAction, leading = null, className = '',
}) {
  if (!status) return null;
  const ActionIcon = nextAction?.icon || ArrowRight;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      {leading}
      <p role="status" aria-label="Record status" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className={`font-medium ${TONES[status.tone] || ''}`}>{status.headline}</span>
        {status.facts.map((fact) => (
          <span key={fact.id} className={`flex items-center gap-2 text-xs ${TONES[fact.tone] || ''}`}>
            <span aria-hidden="true" className="text-port-text-muted">·</span>{fact.label}
          </span>
        ))}
      </p>
      {nextAction && (
        <button
          type="button"
          onClick={onNextAction}
          disabled={nextAction.disabled}
          title={nextAction.reason}
          className="flex min-h-[44px] shrink-0 items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-sm text-white disabled:opacity-50 sm:min-h-0"
        >
          <ActionIcon size={14} aria-hidden="true" /> {nextAction.label}
        </button>
      )}
    </div>
  );
}
