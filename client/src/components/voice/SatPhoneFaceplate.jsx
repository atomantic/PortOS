import { useState } from 'react';
import { Link } from 'react-router';
import { AudioLines, Brain, EyeOff, Maximize2, PanelBottomClose, SlidersHorizontal, VolumeX, X } from 'lucide-react';
import RealtimeCallPanel from './RealtimeCallPanel';
import ChannelBrainPicker from './ChannelBrainPicker';
import TabPills from '../ui/TabPills';
import useMediaQuery from '../../hooks/useMediaQuery';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const utilityBtn = 'inline-flex items-center justify-center rounded-md border border-transparent p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:border-port-border hover:bg-port-bg/60 hover:text-port-text transition-colors';

function StatusLed({ label, state, title }) {
  const tone = state === 'tx'
    ? 'bg-port-accent-2 shadow-[0_0_7px_rgb(var(--port-accent-2)/0.95)] ring-port-accent-2/60 animate-pulse'
    : state === 'rx'
      ? 'bg-port-success shadow-[0_0_7px_rgb(var(--port-success)/0.95)] ring-port-success/60 animate-pulse'
      : state === 'warn'
        ? 'bg-port-warning shadow-[0_0_7px_rgb(var(--port-warning)/0.85)] ring-port-warning/60 animate-pulse'
        : state === 'on'
          ? 'bg-port-success shadow-[0_0_6px_rgb(var(--port-success)/0.8)] ring-port-success/50'
          : state === 'accent'
            ? 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent)/0.85)] ring-port-accent/50'
            : 'bg-port-text/15 ring-port-text/25';

  return (
    <span title={title} className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-port-text-muted">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ring-1 transition-colors ${tone}`} />
      {label}
    </span>
  );
}

export function SatPhoneFaceplate({
  isFloating,
  stage,
  capturing,
  runningAvatar,
  avatarData,
  showSetup,
  setupControlsId,
  onToggleSetup,
  onCompactMode,
  onMinimizeMobile,
  onHideWidget,
}) {
  const linkLedState = runningAvatar
    ? 'accent'
    : (avatarData?.phase === 'starting' || avatarData?.phase === 'installing')
      ? 'warn'
      : 'on';
  const linkTitle = runningAvatar
    ? 'Live animated avatar active'
    : (avatarData?.phase === 'starting' || avatarData?.phase === 'installing')
      ? 'Avatar runtime starting'
      : 'Portrait ready';

  const rxLedState = stage === 'speaking' ? 'rx' : (stage === 'thinking' || stage === 'loading') ? 'warn' : 'off';

  return (
    <header className="flex items-center justify-between gap-1.5 min-w-0">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-port-text shrink-0">
        PortOS
      </span>

      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <StatusLed label="LNK" state={linkLedState} title={linkTitle} />
          <StatusLed label="TX" state={capturing ? 'tx' : 'off'} title={capturing ? 'Microphone transmitting' : 'Microphone idle'} />
          <StatusLed label="RX" state={rxLedState} title={rxLedState === 'rx' ? 'Receiving voice' : rxLedState === 'warn' ? 'Generating reply' : 'Receiver idle'} />
        </div>

        {isFloating && (
          <div className="flex items-center gap-0.5 pl-1 border-l border-port-border/70">
            <button
              type="button"
              onClick={onToggleSetup}
              aria-expanded={showSetup}
              aria-controls={showSetup && setupControlsId ? setupControlsId : undefined}
              aria-label="Voice setup"
              title="Voice brain & realtime setup"
              className={`${utilityBtn} ${showSetup ? 'text-port-accent border-port-accent/40' : ''}`}
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
            </button>
            <Link
              to="/voice/call"
              aria-label="Open full-page Voice Call"
              title="Open full-page Voice Call station"
              className={utilityBtn}
            >
              <Maximize2 size={13} aria-hidden="true" />
            </Link>
            {onCompactMode && (
              <button
                type="button"
                onClick={onCompactMode}
                aria-label="Switch to compact voice bar"
                title="Hide full handset & use compact bar (saved in preferences)"
                className={utilityBtn}
              >
                <PanelBottomClose size={13} aria-hidden="true" />
              </button>
            )}
            {onMinimizeMobile && (
              <button
                type="button"
                onClick={onMinimizeMobile}
                aria-label="Minimize voice controls"
                title="Minimize voice controls"
                className={`${utilityBtn} md:hidden`}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
            {onHideWidget && (
              <button
                type="button"
                onClick={onHideWidget}
                aria-label="Hide voice widget"
                title="Hide voice widget (restore from the sidebar or Settings → Voice)"
                className={utilityBtn}
              >
                <EyeOff size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

const SETUP_TAB_KEY = 'portos.voice.setupTab';
const SETUP_TABS = [
  { id: 'setup-brain', label: 'Brain', icon: Brain },
  { id: 'setup-realtime', label: 'Realtime', icon: AudioLines },
];

/**
 * The floating handset's setup tray. On a phone the sections stack; on a desktop pointer they sit behind compact tabs,
 * one at a time, so the tray stays short. Every section stays mounted when hidden, so switching tabs never ends a
 * realtime call or resets a form.
 */
export function SatPhoneSetup({
  id,
  llmProvider,
  llmModel,
  llmResidency = null,
  onLlmSaved,
}) {
  const tabbed = useMediaQuery('(min-width: 768px) and (pointer: fine)');
  const [tab, setTab] = useState(() => {
    const saved = safeReadStorage(SETUP_TAB_KEY);
    return SETUP_TABS.some((t) => t.id === saved) ? saved : 'setup-brain';
  });
  const choose = (id) => { safeWriteStorage(SETUP_TAB_KEY, id); setTab(id); };
  const shown = (id) => !tabbed || tab === id;
  return (
    <div id={id} className="space-y-2">
      {tabbed && (
        <TabPills tabs={SETUP_TABS} activeTab={tab} onChange={choose} size="xs" stretch ariaLabel="Voice setup" controlsIdPrefix="satphone" />
      )}
      <div id="satphone-setup-brain" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'tab-setup-brain' : undefined} hidden={!shown('setup-brain')}>
        <ChannelBrainPicker
          compact
          globalProvider={llmProvider}
          globalModel={llmModel}
          residency={llmResidency}
          onGlobalSaved={onLlmSaved}
        />
      </div>
      <div id="satphone-setup-realtime" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'tab-setup-realtime' : undefined} hidden={!shown('setup-realtime')}>
        <RealtimeCallPanel compact />
      </div>
    </div>
  );
}

export function SatPhoneSpeaker({
  isFloating,
  isVoiceOutputTab,
  onClaimVoiceOutput,
}) {
  // Only render when another tab holds proactive audio output and this tab can reclaim it.
  if (!isFloating || !onClaimVoiceOutput || isVoiceOutputTab) return null;
  return (
    <button
      type="button"
      onClick={onClaimVoiceOutput}
      aria-pressed={false}
      title="Proactive alerts play on another tab. Click to make this tab the speaker."
      className="satphone-key inline-flex min-h-9 pointer-coarse:min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-port-text-muted hover:text-port-text"
    >
      <VolumeX size={12} aria-hidden="true" />
      claim speaker
    </button>
  );
}
