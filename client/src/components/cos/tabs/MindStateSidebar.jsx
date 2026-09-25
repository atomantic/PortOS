import { Link } from 'react-router';
import { Brain, Database, Eraser, Wrench } from 'lucide-react';
import PersistentMindRoutePanel from '../PersistentMindRoutePanel';
import { formatCount, formatDateTime, timeUntil } from '../../../utils/formatters';
import { MindStateButton } from './MindPanelParts.jsx';

export default function MindStateSidebar({
  turnProgress,
  state,
  isPaused,
  openPanel,
  mind,
  providers,
  thinkingPresets,
  turnExecutions,
  selectedPresetId,
  selectPreset,
  runLifecycle,
  lifecyclePending,
  inspectSession,
  runtime,
  grantedCapabilityCount,
  visibility,
  runtimeError,
  visibilityError,
}) {
  return (
    <aside aria-labelledby="mind-state-heading" className="space-y-3 xl:min-h-0 xl:overflow-y-auto">
      <section className="rounded-2xl border border-port-border bg-port-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-port-text-muted">Live workspace</p>
            <h3 id="mind-state-heading" className="mt-1 text-base font-semibold text-port-text">Mind state</h3>
          </div>
          <span className={`h-2.5 w-2.5 rounded-full ${turnProgress.phase === 'stalled' || turnProgress.phase === 'blocked' ? 'bg-port-warning' : turnProgress.phase === 'thinking' ? 'animate-pulse bg-port-accent' : state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
        </div>
        <p className="mt-3 text-sm text-port-text-muted">
          {turnProgress.phase === 'stalled' ? 'No heartbeat from the current turn — checking whether it is still alive.'
            : turnProgress.phase === 'blocked' ? (state?.contextBudgetBlocked
              ? `${turnProgress.reason || 'Local context window is too small for this wake'}. Raise provider numCtx under Settings → AI providers (or shrink Context), then Resume.`
              : `${turnProgress.reason || 'Blocked'}${turnProgress.retryAt ? ' — the mind retries on its own; no action needed.' : '. No retry is scheduled.'}`)
              : turnProgress.phase === 'thinking' ? `${turnProgress.stage || 'Working through the current turn'}.`
                : state?.pauseReason || (state?.started ? 'Listening for messages and scheduled wakes.' : 'Configure the AI profile to begin.')}
        </p>
        {state?.contextBudgetBlocked && (
          <div data-testid="mind-context-budget-actions" className="mt-2 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              onClick={() => openPanel('context')}
              className="rounded-lg border border-port-border px-2.5 py-1 font-medium text-port-text hover:border-port-accent hover:text-port-accent"
            >
              Open Context
            </button>
            <a
              href="/settings?tab=providers"
              className="rounded-lg border border-port-border px-2.5 py-1 font-medium text-port-text hover:border-port-accent hover:text-port-accent"
            >
              AI providers (numCtx)
            </a>
          </div>
        )}
        {turnProgress.detail && (
          <p data-testid="mind-turn-progress-detail" className={`mt-1 text-xs ${turnProgress.phase === 'stalled' || turnProgress.phase === 'blocked' ? 'text-port-warning' : 'text-port-text-muted'}`}>
            {turnProgress.detail}
          </p>
        )}
        {turnProgress.retryAt && (
          <p className="mt-1 text-xs text-port-warning">
            Next retry <time dateTime={turnProgress.retryAt} className="font-medium">{formatDateTime(turnProgress.retryAt)}</time> · {timeUntil(turnProgress.retryAt)}
          </p>
        )}
        {state?.queuedMessageCount > 0 && <p className="mt-2 text-xs font-medium text-port-accent">{state.queuedMessageCount} queued message{state.queuedMessageCount === 1 ? '' : 's'}</p>}
        {state?.started && state?.nextWakeAt && (
          <button
            type="button"
            onClick={() => openPanel('settings')}
            aria-label="Configure wake cadence"
            className="mt-2 block rounded text-left text-xs text-port-text-muted hover:text-port-accent focus:outline-none focus:ring-2 focus:ring-port-accent/50"
          >
            Next wake <time dateTime={state.nextWakeAt} className="font-medium text-port-text">{formatDateTime(state.nextWakeAt)}</time> · {timeUntil(state.nextWakeAt)}
          </button>
        )}
      </section>

      <PersistentMindRoutePanel
        profile={mind?.profile}
        state={state}
        providers={providers}
        presets={thinkingPresets}
        turnExecutions={turnExecutions}
        selectedPresetId={selectedPresetId}
        onReturnToDefault={() => selectPreset(null)}
        onCancelSession={() => runLifecycle('pause')}
        cancelPending={lifecyclePending === 'pause'}
        onInspectSession={inspectSession}
      />

      <div className="grid grid-cols-2 gap-2">
        <MindStateButton icon={Brain} label="Context" value={runtime?.context?.approximateTokens == null ? 'Unavailable' : `~${formatCount(runtime.context.approximateTokens)} tokens`} detail={`${formatCount(runtime?.context?.chars)} characters`} onClick={() => openPanel('context')} />
        <MindStateButton icon={Database} label="Memories" value={runtime?.context?.memoryCount == null ? 'Unavailable' : `${formatCount(runtime.context.memoryCount)} accessible`} detail="Created and curated" onClick={() => openPanel('memories')} />
        <MindStateButton icon={Eraser} label="Cleanup" value={mind?.capabilities?.manageMind ? 'Self-maintenance on' : 'User controlled'} detail="Memories, history, and context" onClick={() => openPanel('maintenance')} />
        <MindStateButton icon={Wrench} label="Tools" value={grantedCapabilityCount > 0 ? `${grantedCapabilityCount} grant${grantedCapabilityCount === 1 ? '' : 's'} enabled` : 'No grants'} detail="Narrow, typed authority" onClick={() => openPanel('tools')} />

      </div>

      <section aria-label="Mind environment" className="rounded-2xl border border-port-border bg-port-card p-3 text-xs text-port-text-muted">
        <p className="font-medium text-port-text">Eidoverse · {visibility?.orientation?.eidoverse?.status || 'Unknown'}</p>
        <p className="mt-1">World building {mind?.capabilities?.manageEidoverse ? 'enabled' : 'off'} · Release {visibility?.orientation?.release?.version || 'unknown'}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link to="/eidoverse" className="text-port-accent hover:underline">Open world</Link>
          <button type="button" onClick={() => openPanel('tools')} className="text-port-accent hover:underline">World permissions</button>
          <button type="button" onClick={() => openPanel('context')} className="text-port-accent hover:underline">Environment details</button>
        </div>
      </section>

      {(runtimeError || visibilityError) && <p role="status" className="rounded-xl border border-port-warning/40 bg-port-warning/10 p-3 text-xs text-port-warning">Some live status is delayed. The last successful snapshot remains visible.</p>}
    </aside>
  );
}
