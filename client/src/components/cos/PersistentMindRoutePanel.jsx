import { CircleStop, RotateCcw, Route } from 'lucide-react';
import {
  findMindThinkingPreset,
  formatMindCallOutcome,
  formatMindElapsed,
  mindTurnElapsedMs,
  mindTurnOutcome,
  sameMindRoute,
  temporaryMindTurns,
} from '../../lib/mindThinkingPresets.js';
import MindRouteBadge from './MindRouteBadge.jsx';

/**
 * Default route versus the route the mind is ACTUALLY running on right now.
 *
 * These are different questions and the page has to answer both: a temporary
 * thinking session borrows another model for exactly one turn, so "which model
 * is my Chief of Staff" and "what is this turn spending" can legitimately
 * disagree for the length of that turn. A field the claim never recorded is
 * shown as unknown rather than back-filled from the profile — that fallback
 * would report the default route for a turn that is not taking it.
 *
 * Cancelling routes through the caller's existing lifecycle action (pause),
 * which is the machinery that already interrupts a claimed turn and retires a
 * temporary session rather than requeueing it. There is no second cancel path.
 */
export default function PersistentMindRoutePanel({
  profile,
  state,
  providers = [],
  presets = [],
  turnExecutions = [],
  selectedPresetId = null,
  onReturnToDefault,
  onCancelSession,
  cancelPending = false,
  onInspectSession,
}) {
  const defaultRoute = {
    providerId: profile?.providerId || null,
    model: profile?.model || null,
    effort: profile?.effort || null,
  };
  const defaultProvider = providers.find((provider) => provider.id === profile?.providerId) || null;
  const session = state?.activeThinkingSession || null;
  const activeRoute = state?.activeRoute || null;
  const activeProvider = activeRoute?.providerId
    ? providers.find((provider) => provider.id === activeRoute.providerId) || null
    : null;
  // Editing or deleting a preset while a message that selected it is still in
  // flight is a refusal, not a route swap — the server re-validates the
  // accepted route against the saved list. Say so here rather than letting the
  // turn fail with no explanation on the page that offered the edit.
  //
  // `presets` is safe to read as authoritative: it arrives in the same payload
  // as `session`, so a session can never be visible against a not-yet-loaded
  // list.
  const savedPreset = session ? findMindThinkingPreset(presets, session.presetId) : null;
  const presetRemoved = Boolean(session?.resolvable && !savedPreset);
  const routeDrifted = Boolean(session?.resolvable && savedPreset && !sameMindRoute(session, savedPreset));
  const lastTemporary = temporaryMindTurns(turnExecutions).slice(-1)[0] || null;
  const queuedTemporary = state?.queuedTemporaryMessageCount || 0;

  return (
    <section aria-label="Thinking route" className="rounded-2xl border border-port-border bg-port-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-port-text-muted">Thinking route</p>
          <h3 className="mt-1 text-base font-semibold text-port-text">
            {session ? 'Temporary session' : 'Default profile'}
          </h3>
        </div>
        <Route size={16} className="shrink-0 text-port-text-muted" aria-hidden="true" />
      </div>

      <dl className="mt-3 space-y-2 text-xs">
        <div>
          <dt className="text-port-text-muted">Default</dt>
          <dd className="mt-0.5"><MindRouteBadge route={defaultRoute} provider={defaultProvider} /></dd>
        </div>
        <div>
          <dt className="text-port-text-muted">Now</dt>
          <dd className="mt-0.5">
            {activeRoute
              ? <MindRouteBadge route={activeRoute} provider={activeProvider} />
              : <span className="text-port-text-muted">Idle — the next wake uses the default.</span>}
          </dd>
        </div>
      </dl>

      {session && (
        <p className="mt-2 rounded border border-port-accent/40 bg-port-accent/5 px-2 py-1.5 text-[11px] text-port-text">
          Borrowing <span className="font-medium">{session.label || session.presetId}</span> for this turn only.
          {!session.resolvable && ' Its saved route is no longer valid, so this turn will be refused rather than answered on another model.'}
          {routeDrifted && ' That preset has been edited since this message was accepted, so this turn will be refused — send a new message to authorize its new route.'}
          {presetRemoved && ' That preset has been removed since this message was accepted, so this turn will be refused rather than answered on another model.'}
        </p>
      )}

      {queuedTemporary > 0 && (
        <p className="mt-2 text-[11px] text-port-text-muted">
          {queuedTemporary} queued message{queuedTemporary === 1 ? '' : 's'} {queuedTemporary === 1 ? 'is' : 'are'} waiting on a borrowed route.
        </p>
      )}

      {lastTemporary && (
        <button
          type="button"
          onClick={() => onInspectSession?.(lastTemporary.turnId)}
          className="mt-3 block w-full rounded border border-port-border px-2 py-1.5 text-left text-[11px] text-port-text-muted hover:border-port-accent/60 hover:text-port-text"
        >
          Last temporary session · {formatMindCallOutcome(mindTurnOutcome(lastTemporary))} · {formatMindElapsed(mindTurnElapsedMs(lastTemporary))}
        </button>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {selectedPresetId && (
          <button
            type="button"
            onClick={() => onReturnToDefault?.()}
            className="flex min-h-[32px] items-center gap-1.5 rounded border border-port-border px-2.5 text-[11px] text-port-text hover:bg-port-border/30"
          >
            <RotateCcw size={12} aria-hidden="true" /> Return to default
          </button>
        )}
        {session && (
          <button
            type="button"
            onClick={() => onCancelSession?.()}
            disabled={cancelPending}
            className="flex min-h-[32px] items-center gap-1.5 rounded border border-port-warning/50 px-2.5 text-[11px] text-port-warning hover:bg-port-warning/10 disabled:opacity-50"
          >
            <CircleStop size={12} aria-hidden="true" /> {cancelPending ? 'Cancelling…' : 'Cancel this session'}
          </button>
        )}
      </div>
      {session && (
        <p className="mt-2 text-[11px] text-port-text-muted">
          Cancelling pauses the mind and retires this session instead of requeueing it — a cancelled temporary turn never replays itself. Send a new message to run it again.
        </p>
      )}
    </section>
  );
}
