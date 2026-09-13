import { AlertCircle, Check, CircleDashed, Loader2, MinusCircle } from 'lucide-react';

/**
 * The live step list for the programmatic phase of a user-triggered run.
 *
 * Pressing "Run Now" (or "Review this PR") used to show nothing on the Tasks
 * page until an agent existed — which for pr-reviewer is after the whole
 * security preflight has screened every contributor diff. The server now opens
 * a card the moment the request is queued (services/preflightTaskCard.js) and
 * reports each deterministic step into it; this renders that, so the user can
 * see exactly which check is running rather than an empty page.
 *
 * The shape is owned by server/lib/preflightPlan.js.
 */

// One row per step status, so adding a status is one entry rather than an edit
// to two parallel maps that degrade silently when only one is updated.
const STEP_STYLE = {
  done: { icon: <Check size={13} aria-hidden="true" className="text-port-success" />, text: 'text-gray-300' },
  active: { icon: <Loader2 size={13} aria-hidden="true" className="text-port-accent animate-spin" />, text: 'text-white' },
  failed: { icon: <AlertCircle size={13} aria-hidden="true" className="text-port-error" />, text: 'text-port-error' },
  skipped: { icon: <MinusCircle size={13} aria-hidden="true" className="text-gray-600" />, text: 'text-gray-600' },
  pending: { icon: <CircleDashed size={13} aria-hidden="true" className="text-gray-600" />, text: 'text-gray-500' },
};

export default function PreflightProgress({ preflight, idScope, taskId }) {
  const steps = Array.isArray(preflight?.steps) ? preflight.steps : null;
  if (!steps?.length) return null;
  const running = preflight.phase === 'queued' || preflight.phase === 'preparing';
  const footer = preflight.note
    || (!running && preflight.reason ? `Reason: ${preflight.reason}` : null);

  return (
    <section
      className="mt-2 px-2 py-2 bg-port-bg border border-port-border rounded text-sm"
      aria-label="Pre-agent checks"
      aria-busy={running}
    >
      <div className="flex items-center gap-2 text-gray-300">
        <span className="font-medium">Pre-agent checks</span>
        <span className="text-xs text-gray-500">
          {running ? 'running now — no agent has started yet' : 'finished'}
        </span>
      </div>
      <ol className="mt-1 space-y-1">
        {steps.map((step) => {
          const style = STEP_STYLE[step.status] || STEP_STYLE.pending;
          return (
            <li key={`${idScope}-${taskId}-preflight-${step.key}`} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{style.icon}</span>
              <span className="min-w-0">
                <span className={`text-xs ${style.text}`}>{step.label}</span>
                {step.detail && <span className="block text-xs text-gray-500">{step.detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {footer && <p className="mt-2 text-xs text-gray-400">{footer}</p>}
    </section>
  );
}
