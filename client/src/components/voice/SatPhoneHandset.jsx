import { useState } from 'react';
import { Link } from 'react-router';
import {
  AudioLines, ChevronDown, ChevronUp, EyeOff, Maximize2, Mic, MicOff,
  Monitor, MonitorOff, PanelBottomClose, PhoneOff, Play, Radio, ScanFace,
  Send, SlidersHorizontal, Square, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import AvatarRuntimeSettings from './AvatarRuntimeSettings';
import SatPhoneRotaryDial from './SatPhoneRotaryDial';
import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';
import VoiceLlmQuickPicker from './VoiceLlmQuickPicker';
import { CONVERSATIONAL_GEMMA, isConversationalGemma } from '../../../../server/lib/voiceModelCatalog.js';

const STATUS_LABELS = {
  idle: 'Standby',
  listening: 'Listening',
  handsfree: 'Mic open',
  capturing: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const SIGNAL_BARS = [0.1, 0.2, 0.32, 0.44, 0.56, 0.68, 0.78, 0.88, 0.95, 1];

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

function SignalMeter({ level, stage, muted }) {
  const active = stage === 'speaking'
    ? 'rx'
    : (stage === 'capturing' || stage === 'listening' || stage === 'handsfree')
      ? 'tx'
      : 'idle';
  // Give active audio a gentle minimum floor so live TX/RX clearly registers on the LCD.
  const visualLevel = muted && active === 'rx'
    ? 0
    : active === 'idle'
      ? 0.12
      : Math.max(0.18, Math.min(1, level * 4.5));

  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0" aria-hidden="true">
      <div className="flex items-end gap-[2px] h-5">
        {SIGNAL_BARS.map((threshold, idx) => {
          const lit = visualLevel >= threshold;
          const heightPct = 30 + idx * 7;
          const barColor = !lit
            ? 'bg-port-border/45'
            : idx >= 8
              ? 'bg-port-warning'
              : active === 'tx'
                ? 'bg-port-accent-2'
                : 'bg-port-accent';
          return (
            <span
              key={threshold}
              style={{ height: `${heightPct}%` }}
              className={`w-[3px] rounded-xs transition-colors duration-75 ${barColor}`}
            />
          );
        })}
      </div>
      <span className="font-mono text-[8px] uppercase tracking-[0.14em] opacity-70">
        {active === 'tx' ? 'TX LVL' : active === 'rx' ? 'RX LVL' : 'SIGNAL'}
      </span>
    </div>
  );
}

/**
 * Video-enabled Satellite Phone / Tactical Transceiver Handset.
 *
 * Shared between the bottom-left floating voice agent (`variant="floating"`)
 * and the dedicated full-page Voice Call station (`variant="page"`). Every
 * indicator, dial, paddle, and key maps to real voice/audio functionality.
 */
export default function SatPhoneHandset({
  variant = 'floating',
  stage,
  history,
  scrollRef,
  interimTranscript,
  capturing,
  handsFree,
  canChangeMicMode,
  hotkey = 'Space',
  draft,
  onDraft,
  onSend,
  onMic,
  onMode,
  onInterrupt,
  onEnd,
  onSample,
  onClear,
  voiceLabel,
  llmProvider,
  llmModel,
  onLlmSaved,
  avatar,
  onToggleAvatar,
  avatarData,
  avatarError,
  onUpdateAvatarData,
  onRefetchAvatar,
  runningAvatar,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  sfxEnabled,
  onToggleSfx,
  signalLevel = 0,
  visionEnabled = false,
  onToggleVision,
  isVoiceOutputTab = true,
  onClaimVoiceOutput,
  // Floating-only controls
  collapsed = false,
  onToggleCollapsed,
  conversationId,
  inputRef,
  onCompactMode,
  onHideWidget,
  onMinimizeMobile,
}) {
  const [showFloatingAvatarSetup, setShowFloatingAvatarSetup] = useState(false);
  const isFloating = variant === 'floating';
  const openMic = handsFree || !canChangeMicMode;
  const MicIcon = capturing ? MicOff : Mic;
  const caption = interimTranscript || history.at(-1)?.text;
  const statusText = STATUS_LABELS[stage] || STATUS_LABELS.idle;
  const liveAttr = capturing ? 'tx' : (stage === 'speaking' || stage === 'thinking') ? 'rx' : 'idle';

  const linkLedState = !avatar
    ? 'off'
    : runningAvatar
      ? 'accent'
      : (avatarData?.phase === 'starting' || avatarData?.phase === 'installing')
        ? 'warn'
        : 'on';

  const rxLedState = stage === 'speaking' ? 'rx' : stage === 'thinking' ? 'warn' : 'off';

  const modeBadge = !canChangeMicMode ? 'WEB' : handsFree ? 'VOX' : 'PTT';
  const screenBadge = !avatar
    ? 'AUDIO ONLY'
    : runningAvatar
      ? 'AVATAR LIVE'
      : 'PORTRAIT';

  const paddleAriaLabel = isFloating
    ? (handsFree
      ? (capturing ? 'Stop hands-free listening' : 'Start hands-free listening')
      : (capturing ? 'Send voice message' : 'Start listening'))
    : (capturing ? (openMic ? 'Close mic' : 'Send voice') : (openMic ? 'Open mic' : 'Talk'));

  const paddleTitle = handsFree
    ? (capturing ? `Click or press ${hotkey} to close mic` : `Click or press ${hotkey} to open hands-free mic`)
    : (capturing ? `Click or press ${hotkey} to send voice` : `Click or press ${hotkey} to talk`);

  const paddleLegend = capturing ? (openMic ? 'LIVE' : 'SEND') : 'TALK';
  const llmDisplay = llmModel && llmModel !== 'auto'
    ? (isConversationalGemma(llmModel) ? CONVERSATIONAL_GEMMA.name : llmModel)
    : (llmProvider ? `${llmProvider} · auto` : null);
  const lcdSubline = [voiceLabel || 'Saved voice', llmDisplay].filter(Boolean).join(' · ');

  const keyBase = 'satphone-key inline-flex min-h-10 pointer-coarse:min-h-11 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider disabled:opacity-45';
  const utilityBtn = 'inline-flex items-center justify-center rounded-md border border-transparent p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:border-port-border hover:bg-port-bg/60 hover:text-port-text transition-colors';

  return (
    <div className={`relative flex flex-col ${isFloating ? 'w-[21.25rem] max-w-[calc(100vw-2rem)]' : 'w-full'}`}>
      {/* Sculpted top-right satellite antenna assembly */}
      <div className="flex justify-end pr-6 -mb-[2px] pointer-events-none select-none" aria-hidden="true">
        <div className="relative flex flex-col items-center">
          <div className="satphone-antenna relative h-5 w-4 rounded-t-md border border-b-0">
            <span
              className={`absolute left-1/2 top-1 h-1 w-1.5 -translate-x-1/2 rounded-full transition-colors ${
                capturing
                  ? 'bg-port-accent-2 shadow-[0_0_6px_rgb(var(--port-accent-2))]'
                  : stage === 'speaking'
                    ? 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent))]'
                    : 'bg-port-border'
              }`}
            />
          </div>
          <div className="h-1.5 w-6 rounded-t-sm border border-b-0 border-port-border bg-port-bg" />
        </div>
      </div>

      {/* Main machined transceiver chassis */}
      <div
        data-live={liveAttr}
        className={`satphone-chassis relative flex flex-col rounded-2xl border text-port-text ${
          isFloating ? 'gap-2 p-2.5 max-h-[calc(100dvh-3.5rem)] overflow-y-auto' : 'gap-2.5 p-3 sm:p-3.5'
        }`}
      >
        {/* Top instrument faceplate: branding + real hardware LEDs + floating utilities */}
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
                  onClick={() => setShowFloatingAvatarSetup((v) => !v)}
                  aria-expanded={showFloatingAvatarSetup}
                  aria-label="Voice LLM and avatar setup"
                  title="Voice LLM & AvatarForcing setup"
                  className={`${utilityBtn} ${showFloatingAvatarSetup ? 'text-port-accent border-port-accent/40' : ''}`}
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

        {/* Expandable inline LLM + Avatar setup tray in floating mode */}
        {isFloating && showFloatingAvatarSetup && (
          <div className="space-y-2">
            <VoiceLlmQuickPicker
              compact
              provider={llmProvider}
              model={llmModel}
              onSaved={onLlmSaved}
            />
            <AvatarRuntimeSettings
              compact
              data={avatarData}
              error={avatarError}
              updateData={onUpdateAvatarData}
              refetch={onRefetchAvatar}
            />
          </div>
        )}

        {/* Viewfinder bay + integrated right-edge tactile TALK paddle */}
        <div className="flex items-stretch gap-1.5 min-w-0">
          {/* Recessed video viewfinder */}
          <div className="satphone-bezel relative isolate flex-1 min-w-0 overflow-hidden rounded-xl border">
            {avatar ? (
              <VoiceCallGenerativePortrait
                key={runningAvatar ? 'animated' : 'still'}
                running={runningAvatar}
                stage={stage}
                fill
              />
            ) : (
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-port-bg p-4">
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-port-accent/40 bg-port-accent/10">
                  <AudioLines
                    aria-hidden="true"
                    size={36}
                    className={`text-port-accent ${capturing || stage === 'speaking' ? 'animate-pulse' : ''}`}
                  />
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-port-text-muted">
                  Audio-only link
                </span>
              </div>
            )}

            {/* Subtle CRT/OLED scanlines (disabled under reduced-motion) */}
            <div aria-hidden="true" className="satphone-scanlines pointer-events-none absolute inset-0" />

            {/* Viewfinder corner targeting reticles */}
            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-2 h-[calc(100%-1rem)] w-[calc(100%-1rem)] text-port-accent"
            >
              <path d="M0 9V0H9 M91 0H100V9" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" vectorEffect="non-scaling-stroke" />
              <path d="M0 72V81H9 M91 81H100V72" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" vectorEffect="non-scaling-stroke" />
            </svg>

            {/* Top HUD chips (theme-safe .port-media-overlay-strong over media) */}
            <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-1.5">
              <span className="port-media-overlay-strong rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] border border-port-border/70">
                {screenBadge}
              </span>
              <p
                role="status"
                className="port-media-overlay-strong inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider border border-port-border/70"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    capturing
                      ? 'bg-port-accent-2 animate-pulse'
                      : stage === 'speaking'
                        ? 'bg-port-success animate-pulse'
                        : stage === 'thinking'
                          ? 'bg-port-warning animate-pulse'
                          : 'bg-port-text-muted'
                  }`}
                />
                {statusText}
              </p>
            </div>

            {/* Bottom integrated live subtitle / caption bar */}
            <div className="pointer-events-none absolute inset-x-2 bottom-2">
              <p
                aria-hidden="true"
                className="port-media-overlay line-clamp-2 min-h-9 break-words rounded-md border border-port-border/60 border-l-2 border-l-port-accent px-2.5 py-1.5 font-mono text-[11px] leading-snug"
              >
                {caption || 'Ready when you are.'}
              </p>
            </div>
          </div>

          {/* Side-mounted tactile TALK / PTT paddle */}
          <button
            type="button"
            onClick={onMic}
            aria-pressed={capturing}
            aria-label={paddleAriaLabel}
            title={paddleTitle}
            className="satphone-paddle flex w-9 sm:w-10 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border px-1 py-3 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                capturing
                  ? 'bg-port-on-accent-2 shadow-[0_0_8px_currentColor] animate-pulse'
                  : 'bg-port-accent-2/70'
              }`}
            />
            <MicIcon size={15} aria-hidden="true" />
            <span
              aria-hidden="true"
              className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] [writing-mode:vertical-rl] rotate-180"
            >
              {paddleLegend}
            </span>
          </button>
        </div>

        {/* Instrument telemetry deck: Recessed Digital LCD + Real Rotary Volume Dial */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex flex-1 flex-col gap-1.5 min-w-0">
            {/* Digital LCD readout — real telemetry only, no fake channel changer */}
            <div className="satphone-lcd flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 min-w-0">
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider">
                  <span className="text-port-accent">{modeBadge}</span>
                  <span className="opacity-40" aria-hidden="true">/</span>
                  <span className={muted ? 'text-port-error-text' : ''}>
                    {muted ? 'MUTE' : `${Math.round(volume * 100)}%`}
                  </span>
                </div>
                <span className="font-mono text-[10px] opacity-75 truncate" title={lcdSubline}>
                  {lcdSubline}
                </span>
              </div>
              <SignalMeter level={signalLevel} stage={stage} muted={muted} />
            </div>

            {/* Dual mode keys beneath LCD: Mic mode (VOX/PTT) + Avatar toggle */}
            <div className="grid grid-cols-2 gap-1.5">
              {canChangeMicMode ? (
                <button
                  type="button"
                  onClick={onMode}
                  aria-pressed={handsFree}
                  data-active={handsFree ? 'true' : 'false'}
                  title={handsFree
                    ? 'Hands-free (VOX) ON — mic stays open, auto-submits on pause. Click for push-to-talk.'
                    : 'Push-to-talk (PTT) ON — press TALK to record, press again to send. Click for hands-free.'}
                  className={keyBase}
                >
                  {isFloating ? (handsFree ? 'hands-free' : 'push-to-talk') : 'Hands-free'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSample}
                  disabled={stage !== 'idle'}
                  title="Play a radio-check voice sample"
                  className={keyBase}
                >
                  <Play size={12} aria-hidden="true" />
                  Play sample
                </button>
              )}
              <button
                type="button"
                onClick={onToggleAvatar}
                aria-pressed={avatar}
                data-active={avatar ? 'true' : 'false'}
                title={avatar ? 'Switch to audio-only mode' : 'Show avatar portrait'}
                className={keyBase}
              >
                <ScanFace size={13} aria-hidden="true" />
                Avatar
                <span aria-hidden="true" className="opacity-70">{avatar ? 'on' : 'off'}</span>
              </button>
            </div>
          </div>

          {/* Precision tactile rotary volume dial */}
          <SatPhoneRotaryDial
            volume={volume}
            muted={muted}
            onVolumeChange={onVolumeChange}
            onToggleMute={onToggleMute}
            size={isFloating ? 'sm' : 'md'}
          />
        </div>

        {/* Hardware pushbutton deck — every button wired to real functionality */}
        <div className="grid grid-cols-2 min-[340px]:grid-cols-4 gap-1.5">
          <button
            type="button"
            onClick={onToggleSfx}
            aria-pressed={sfxEnabled}
            data-active={sfxEnabled ? 'true' : 'false'}
            data-tone="warn"
            title={sfxEnabled ? 'Radio cues ON — click to silence squelch & roger beeps' : 'Radio cues OFF — click to enable transceiver cues'}
            className={keyBase}
          >
            <Radio size={12} aria-hidden="true" />
            SFX
          </button>

          <button
            type="button"
            onClick={() => onToggleMute?.()}
            aria-pressed={muted}
            data-active={muted ? 'true' : 'false'}
            data-tone="warn"
            title={muted ? 'Audio muted — click to unmute handset output' : 'Mute handset audio output'}
            className={keyBase}
          >
            {muted ? <VolumeX size={12} aria-hidden="true" /> : <Volume2 size={12} aria-hidden="true" />}
            {muted ? 'Unmute' : 'Mute'}
          </button>

          {onToggleVision ? (
            <button
              type="button"
              onClick={onToggleVision}
              aria-pressed={visionEnabled}
              data-active={visionEnabled ? 'true' : 'false'}
              aria-label={visionEnabled ? 'Disable screen vision for voice' : 'Enable screen vision for voice'}
              title={visionEnabled
                ? 'Screen vision ON — assistant can inspect your shared screen. Click to stop.'
                : 'Share screen so the voice assistant can describe what you see'}
              className={keyBase}
            >
              {visionEnabled ? <Monitor size={12} aria-hidden="true" /> : <MonitorOff size={12} aria-hidden="true" />}
              Vision
            </button>
          ) : (
            <button
              type="button"
              onClick={onSample}
              disabled={stage !== 'idle'}
              title="Play a radio-check voice sample"
              className={keyBase}
            >
              <Play size={12} aria-hidden="true" />
              Play sample
            </button>
          )}

          {stage === 'speaking' ? (
            <button
              type="button"
              onClick={onInterrupt}
              data-tone="danger"
              title="Stop assistant speaking immediately"
              className={keyBase}
            >
              <Square size={11} aria-hidden="true" />
              Interrupt
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnd}
              disabled={stage === 'idle'}
              data-tone="danger"
              title="End active voice session"
              className={keyBase}
            >
              <PhoneOff size={12} aria-hidden="true" />
              End
            </button>
          )}
        </div>

        {/* When speaking, keep End reachable right beside Interrupt */}
        {stage === 'speaking' && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onEnd}
              data-tone="danger"
              className={`${keyBase} w-full`}
            >
              <PhoneOff size={12} aria-hidden="true" />
              End call
            </button>
          </div>
        )}

        {/* Machined acoustic speaker grille + proactive tab speaker status (floating) */}
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

        {/* Floating handset embedded Transmission Log + Composer */}
        {isFloating && (
          <div className="flex flex-col gap-2">
            <div className="satphone-log-well rounded-xl border p-2.5">
              <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-port-border/60">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] opacity-80">
                  Transmission log
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onSample}
                    disabled={stage !== 'idle'}
                    title="Play radio-check sample"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 pointer-coarse:min-h-11 font-mono text-[9px] uppercase tracking-wider text-port-accent-text hover:bg-port-accent/15 disabled:opacity-40"
                  >
                    <Play size={9} aria-hidden="true" />
                    Radio check
                  </button>
                  {history.length > 0 && onClear && (
                    <button
                      type="button"
                      onClick={onClear}
                      title="Clear conversation"
                      aria-label="Clear conversation"
                      className="inline-flex items-center justify-center rounded p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-75 hover:opacity-100 hover:text-port-error-text"
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  )}
                  {history.length > 0 && onToggleCollapsed && (
                    <button
                      type="button"
                      onClick={onToggleCollapsed}
                      aria-expanded={!collapsed}
                      aria-controls={conversationId}
                      title={collapsed ? 'Show conversation' : 'Hide conversation'}
                      aria-label={collapsed ? 'Show conversation' : 'Hide conversation'}
                      className="inline-flex items-center justify-center rounded p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-75 hover:opacity-100"
                    >
                      {collapsed ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                    </button>
                  )}
                </div>
              </div>

              {!collapsed && (
                <div
                  id={conversationId}
                  ref={scrollRef}
                  className="mt-1.5 max-h-28 overflow-y-auto pr-1"
                >
                  <div
                    role="log"
                    aria-live="polite"
                    aria-label="Conversation"
                    className="space-y-1.5 break-words font-mono text-[11px] leading-relaxed"
                  >
                    {history.length === 0 && !interimTranscript && (
                      <p className="opacity-60">Standby — press TALK or type below.</p>
                    )}
                    {history.map((turn, i) => (
                      <p key={i} className={turn.role === 'user' ? 'opacity-75' : ''}>
                        <span className="mr-1.5 text-[9px] font-bold uppercase tracking-wider text-port-accent">
                          {turn.role === 'user' ? 'TX>' : 'RX<'}
                        </span>
                        {turn.text}
                      </p>
                    ))}
                  </div>
                  {interimTranscript && (
                    <p aria-hidden="true" className="mt-1 font-mono text-[11px] italic opacity-65">
                      <span className="mr-1.5 text-[9px] font-bold uppercase tracking-wider text-port-accent-2">TX…</span>
                      {interimTranscript}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Integrated message composer */}
            <form
              onSubmit={(event) => { event.preventDefault(); onSend(); }}
              className="flex min-w-0 items-center gap-1.5"
            >
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(event) => onDraft(event.target.value)}
                placeholder="Transmit text…"
                aria-label="Message to the voice assistant"
                className="min-w-0 flex-1 rounded-lg border border-port-border bg-port-bg px-2.5 py-2 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                title="Send text (Enter)"
                aria-label="Send text"
                className="satphone-key inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border px-2.5 text-port-accent-text disabled:opacity-35"
              >
                <Send size={13} aria-hidden="true" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
