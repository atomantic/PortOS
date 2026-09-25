import { Brain, CirclePause, CirclePlay, PhoneCall, PhoneOff, RefreshCw, Settings2, Square, Wrench } from 'lucide-react';
import Banner from '../../ui/Banner';
import { PersistentMindThoughtStatus } from '../PersistentMindRuntimePanel';
import { mindTurnRuntimeSnapshot } from '../../../lib/mindTurnProgress.js';
import { ActionButton } from './MindPanelParts.jsx';

export default function MindHeader({
  state,
  isPaused,
  mind,
  turnProgress,
  runtime,
  profileReady,
  lifecyclePending,
  loading,
  setupSaving,
  runLifecycle,
  openPanel,
  runtimeLoading,
  visibilityLoading,
  loadHistory,
  loadRuntime,
  loadVisibility,
  callState,
  hangUpCall,
  hangingUp,
  gap,
  loadError,
  lifecycleError,
}) {
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-3 rounded-2xl border border-port-border bg-port-card/70 p-3 sm:p-4">
        <div className="flex min-w-0 flex-[1_0_min(100%,20rem)] items-center gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-port-accent ring-1 ring-port-accent/30">
            <Brain size={23} aria-hidden="true" />
            <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-port-card ${state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-port-text-muted">Persistent Mind</p>
            <h2 id="mind-heading" aria-live="polite" className="break-words text-3xl font-semibold tracking-tight text-port-accent sm:text-4xl [overflow-wrap:anywhere]">
              {mind ? mind.identity?.name || 'Name not yet chosen' : 'Loading identity…'}
            </h2>
            {mind && !mind.identity?.name && <p className="text-xs text-port-text-muted">A name to choose on the next enabled wake. Free to change later.</p>}
            <p className="truncate text-xs text-port-text-muted">
              {mind ? `${mind.profile?.model || 'No model'} · ${mind.profile?.providerId || 'No provider'} · machine-local` : 'Loading profile…'}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2" role="group" aria-label="Persistent mind lifecycle">
          <PersistentMindThoughtStatus
            state={state}
            progress={turnProgress}
            model={mindTurnRuntimeSnapshot(state, runtime)?.model || mind?.profile?.model}
          />
          {!state?.started && <ActionButton label={profileReady ? 'Start' : 'Configure'} icon={profileReady ? CirclePlay : Settings2} pending={profileReady && lifecyclePending === 'start'} disabled={loading || setupSaving} onClick={() => (profileReady ? runLifecycle('start') : openPanel('settings'))} />}
          <ActionButton label="Wake now" icon={CirclePlay} pending={lifecyclePending === 'wake'} disabled={loading || setupSaving || !profileReady || Boolean(lifecyclePending) || Boolean(state?.activeTurn)} onClick={() => runLifecycle('wake')} />
          {state?.started && !isPaused && <ActionButton label="Pause" icon={CirclePause} pending={lifecyclePending === 'pause'} onClick={() => runLifecycle('pause')} />}
          {state?.started && isPaused && <ActionButton label="Resume" icon={CirclePlay} pending={lifecyclePending === 'resume'} onClick={() => runLifecycle('resume')} />}
          {state?.started && <ActionButton label="Stop" icon={Square} pending={lifecyclePending === 'stop'} onClick={() => runLifecycle('stop')} />}
          <ActionButton label="Settings" icon={Settings2} onClick={() => openPanel('settings')} />
          <ActionButton label="Tools & permissions" icon={Wrench} onClick={() => openPanel('tools')} />
          <ActionButton label="Reload" icon={RefreshCw} pending={loading || runtimeLoading || visibilityLoading} onClick={() => {
            void loadHistory({ reset: true });
            void loadRuntime();
            void loadVisibility({ refresh: true });
          }} />
        </div>
      </header>

      {callState?.active && (
        <Banner
          tone="info"
          icon={PhoneCall}
          title="On a FaceTime Audio call"
          actions={
            <button
              type="button"
              onClick={hangUpCall}
              disabled={hangingUp}
              className="flex min-h-[36px] items-center gap-1.5 rounded border border-port-border px-3 text-xs text-port-text hover:bg-port-border/50 disabled:opacity-50"
            >
              <PhoneOff size={14} aria-hidden="true" />{hangingUp ? 'Hanging up…' : 'Hang up'}
            </button>
          }
        >
          {callState.turns > 0 ? `${callState.turns} turn${callState.turns === 1 ? '' : 's'} so far.` : 'Just connected.'}
        </Banner>
      )}

      {gap && <Banner tone="warning" title="History gap detected">The saved cursor is no longer retained. The visible trace was reloaded from the newest bounded snapshot.</Banner>}
      {loadError && <Banner tone="error" title="Conversation unavailable">{loadError}. Existing messages are preserved; retry when the connection recovers.</Banner>}
      {lifecycleError && <Banner tone="error" title="Action failed">{lifecycleError}</Banner>}
    </>
  );
}
