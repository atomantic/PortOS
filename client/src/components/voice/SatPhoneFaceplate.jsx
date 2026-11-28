import { useState } from 'react';
import { Link } from 'react-router';
import { AudioLines, Brain, EyeOff, Maximize2, PanelBottomClose, ScanFace, SlidersHorizontal, Video, Volume2, VolumeX, X } from 'lucide-react';
import RealtimeCallPanel from './RealtimeCallPanel';
import AvatarRuntimeSettings from './AvatarRuntimeSettings';
import ChannelBrainPicker from './ChannelBrainPicker';
import TabPills from '../ui/TabPills';
import useMediaQuery from '../../hooks/useMediaQuery';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const utilityBtn = 'inline-flex items-center justify-center rounded-md border border-transparent p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:border-port-border hover:bg-port-bg/60 hover:text-port-text transition-colors';

function CornerScrew() {
  return (
    <span
      aria-hidden="true"
      className="satphone-screw inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full"
    >
      <span className="h-[1px] w-1.5 rotate-45 bg-port-border/80" />
    </span>
  );
}

function StatusLed({ label, state }) {
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
    <span className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-port-text-muted">
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
  showAvatarSetup,
  onToggleAvatarSetup,
  onCompactMode,
  onMinimizeMobile,
  onHideWidget,
}) {
  const linkLedState = runningAvatar
    ? 'accent'
    : (avatarData?.phase === 'starting' || avatarData?.phase === 'installing')
      ? 'warn'
      : 'on';

  const rxLedState = stage === 'speaking' ? 'rx' : (stage === 'thinking' || stage === 'loading') ? 'warn' : 'off';

  return (
    <header className="flex items-center justify-between gap-1.5 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <CornerScrew />
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-port-text shrink-0">
            PortOS
          </span>
          {!isFloating && (
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-port-text-muted truncate" title="Transceiver">
              Sat-Comm
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <StatusLed label="PWR" state="on" />
          <StatusLed label="LNK" state={linkLedState} />
          <StatusLed label="TX" state={capturing ? 'tx' : 'off'} />
          <StatusLed label="RX" state={rxLedState} />
        </div>

        {isFloating && (
          <div className="flex items-center gap-0.5 pl-1 border-l border-port-border/70">
            <button
              type="button"
              onClick={onToggleAvatarSetup}
              aria-expanded={showAvatarSetup}
              aria-label="Voice LLM and avatar setup"
              title="Voice LLM & AvatarForcing setup"
              className={`${utilityBtn} ${showAvatarSetup ? 'text-port-accent border-port-accent/40' : ''}`}
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
  { id: 'setup-avatar', label: 'Avatar', icon: Video },
];

/**
 * The floating handset's setup tray. On a phone the sections stack; on a desktop pointer they sit behind compact tabs,
 * one at a time, so the tray stays short. Every section stays mounted when hidden, so switching tabs never ends a
 * realtime call or resets a form.
 */
export function SatPhoneSetup({
  llmProvider,
  llmModel,
  llmResidency = null,
  onLlmSaved,
  avatarData,
  avatarError,
  onUpdateAvatarData,
  onRefetchAvatar,
}) {
  const tabbed = useMediaQuery('(min-width: 768px) and (pointer: fine)');
  const [tab, setTab] = useState(() => {
    const saved = safeReadStorage(SETUP_TAB_KEY);
    return SETUP_TABS.some((t) => t.id === saved) ? saved : 'setup-brain';
  });
  const choose = (id) => { safeWriteStorage(SETUP_TAB_KEY, id); setTab(id); };
  const shown = (id) => !tabbed || tab === id;
  return (
    <div className="space-y-2">
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
      <div id="satphone-setup-avatar" role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? 'tab-setup-avatar' : undefined} hidden={!shown('setup-avatar')} className="space-y-2">
        <AvatarRuntimeSettings
          compact
          data={avatarData}
          error={avatarError}
          updateData={onUpdateAvatarData}
          refetch={onRefetchAvatar}
        />
        <Link
          to="/voice/call"
          className="satphone-key inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border px-3 font-mono text-[10px] font-semibold uppercase tracking-wider"
        >
          <ScanFace size={12} aria-hidden="true" />
          Avatars & channels
        </Link>
      </div>
    </div>
  );
}

export function SatPhoneSpeaker({
  isFloating,
  isVoiceOutputTab,
  onClaimVoiceOutput,
}) {
  return (
    <div className="flex items-center justify-between gap-2 pt-0.5">
      <CornerScrew />
      <div aria-hidden="true" className="satphone-grille h-2.5 flex-1 rounded-sm opacity-80" />
      {isFloating && onClaimVoiceOutput ? (
        <button
          type="button"
          onClick={onClaimVoiceOutput}
          aria-pressed={isVoiceOutputTab}
          title={isVoiceOutputTab
            ? 'This tab plays proactive alerts & reminders. Only one tab speaks at a time.'
            : 'Proactive alerts play on another tab. Click to make this tab the speaker.'}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 pointer-coarse:min-h-11 font-mono text-[9px] font-semibold uppercase tracking-wider transition-colors ${
            isVoiceOutputTab
              ? 'border-port-success/40 bg-port-success/10 text-port-success-text'
              : 'border-port-border bg-port-bg/60 text-port-text-muted hover:text-port-text'
          }`}
        >
          {isVoiceOutputTab ? <Volume2 size={10} aria-hidden="true" /> : <VolumeX size={10} aria-hidden="true" />}
          {isVoiceOutputTab ? 'speaker' : 'claim speaker'}
        </button>
      ) : (
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-port-text-muted border border-port-border/80 rounded px-1.5 py-0.5 bg-port-bg/60">
          PT-01
        </span>
      )}
    </div>
  );
}
