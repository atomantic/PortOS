import { ArrowLeft } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';
import {
  formatMindCallOutcome,
  formatMindCallUsage,
  formatMindElapsed,
  formatMindRoute,
  mindTurnElapsedMs,
  mindTurnOutcome,
  temporaryMindTurns,
} from '../../lib/mindThinkingPresets.js';
import MindRouteBadge from './MindRouteBadge.jsx';

const OUTCOME_TONE = Object.freeze({
  completed: 'text-port-success',
  failed: 'text-port-error',
  denied: 'text-port-warning',
  interrupted: 'text-port-warning',
  running: 'text-port-accent',
});

const outcomeTone = (outcome) => OUTCOME_TONE[outcome] || 'text-port-text-muted';

/**
 * Provenance for the turns that borrowed a temporary route.
 *
 * Every value here comes from a receipt the server wrote at the moment of the
 * call, never from the composer's intent: the preset that was selected, the
 * route the call ACTUALLY took, its run id, its wall time, and whatever usage
 * the provider reported. When the provider reported nothing, this says so —
 * a missing token count is rendered as unknown, never as zero, because "free"
 * and "not measured" are different claims about the user's money.
 *
 * `selectedTurnId` is owned by the URL, so one session is directly linkable
 * from the route panel and from a shared address.
 */
export default function PersistentMindSessions({
  turnExecutions = [],
  providers = [],
  selectedTurnId = null,
  onSelectTurn,
}) {
  const sessions = temporaryMindTurns(turnExecutions).slice().reverse();
  const selected = selectedTurnId
    ? sessions.find((turn) => turn.turnId === selectedTurnId) || null
    : null;

  if (selectedTurnId) {
    return (
      <section aria-labelledby="mind-session-heading" className="space-y-3">
        <button
          type="button"
          onClick={() => onSelectTurn?.(null)}
          className="flex min-h-[36px] items-center gap-1.5 rounded border border-port-border px-2.5 text-xs text-port-text hover:bg-port-border/30"
        >
          <ArrowLeft size={13} aria-hidden="true" /> All sessions
        </button>
        <h3 id="mind-session-heading" className="text-sm font-semibold text-port-text">Session provenance</h3>
        {selected ? <SessionDetail turn={selected} providers={providers} /> : (
          <p className="text-xs text-port-text-muted">
            This session is no longer in the retained execution history. Its receipts age out with the trajectory window.
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="mind-sessions-heading" className="space-y-3">
      <div>
        <h3 id="mind-sessions-heading" className="text-sm font-semibold text-port-text">Temporary sessions</h3>
        <p className="mt-1 text-xs text-port-text-muted">
          What each borrowed route actually did — the route taken, how long it ran, and what the provider reported spending. Telemetry a provider never reported is shown as unknown, not as zero.
        </p>
      </div>
      {sessions.length === 0 ? (
        <p className="rounded border border-dashed border-port-border px-3 py-4 text-center text-xs text-port-text-muted">
          No message has borrowed an alternate model yet.
        </p>
      ) : (
        <ul aria-label="Temporary thinking sessions" className="space-y-2">
          {sessions.map((turn) => {
            const outcome = mindTurnOutcome(turn);
            return (
              <li key={turn.turnId}>
                <button
                  type="button"
                  onClick={() => onSelectTurn?.(turn.turnId)}
                  className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-left hover:border-port-accent/60"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-port-text">
                      {turn.calls?.[0]?.thinkingPresetLabel || turn.thinkingPresetId || 'Temporary session'}
                    </span>
                    <span className={`shrink-0 text-[11px] font-medium ${outcomeTone(outcome)}`}>{formatMindCallOutcome(outcome)}</span>
                  </span>
                  <MindRouteBadge
                    route={{ providerId: turn.providerId, model: turn.model, effort: turn.effort }}
                    provider={providers.find((provider) => provider.id === turn.providerId) || null}
                    className="mt-1"
                    showBilling={false}
                  />
                  <span className="mt-1 block text-[11px] text-port-text-muted">
                    {turn.startedAt ? formatDateTime(turn.startedAt) : 'Start time unknown'} · {formatMindElapsed(mindTurnElapsedMs(turn))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SessionDetail({ turn, providers }) {
  const outcome = mindTurnOutcome(turn);
  const calls = Array.isArray(turn.calls) ? turn.calls : [];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <Field label="Preset">{turn.calls?.[0]?.thinkingPresetLabel || turn.thinkingPresetId || 'Unknown'}</Field>
        <Field label="Outcome"><span className={outcomeTone(outcome)}>{formatMindCallOutcome(outcome)}</span></Field>
        <Field label="Route">
          <MindRouteBadge
            route={{ providerId: turn.providerId, model: turn.model, effort: turn.effort }}
            provider={providers.find((provider) => provider.id === turn.providerId) || null}
            showBilling={false}
          />
        </Field>
        <Field label="Elapsed">{formatMindElapsed(mindTurnElapsedMs(turn))}</Field>
        <Field label="Started">{turn.startedAt ? formatDateTime(turn.startedAt) : 'Unknown'}</Field>
        <Field label="Completed">{turn.completedAt ? formatDateTime(turn.completedAt) : 'Not recorded'}</Field>
        <Field label="Turn id"><span className="break-all font-mono">{turn.turnId || 'Unknown'}</span></Field>
      </dl>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-port-accent">Provider calls</h4>
        {calls.length === 0 ? (
          <p className="mt-2 text-xs text-port-text-muted">No provider call was recorded for this turn.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {calls.map((call, index) => (
              <li key={call.eventId || `${turn.turnId}-${index}`} className="rounded border border-port-border bg-port-bg px-3 py-2 text-[11px]">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-port-text">
                    {call.purpose || 'call'}{call.round === null || call.round === undefined ? '' : ` · round ${call.round}`}
                  </span>
                  <span className={outcomeTone(call.outcome)}>{formatMindCallOutcome(call.outcome)}</span>
                </p>
                <p className="mt-1 font-mono text-port-text-muted">
                  {formatMindRoute({ providerId: call.providerId, model: call.model, effort: call.effort })}
                </p>
                <p className="mt-1 text-port-text-muted">
                  {formatMindElapsed(call.elapsedMs)} · {formatMindCallUsage(call.usage)}
                </p>
                <p className="mt-1 break-all text-port-text-muted">Run {call.runId || 'unknown'}</p>
                {call.reason && <p className="mt-1 text-port-warning">{call.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-port-text-muted">{label}</dt>
      <dd className="mt-0.5 text-port-text">{children}</dd>
    </div>
  );
}
