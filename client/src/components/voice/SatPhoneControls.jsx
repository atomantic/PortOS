import {
  Mic, MicOff, Monitor, MonitorOff, PhoneOff, Radio, ScanFace, Square, Volume2, VolumeX,
} from 'lucide-react';
import SatPhoneRotaryDial from './SatPhoneRotaryDial';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { voiceLlmResidencyBadge } from './voiceLlmResidencyBadge';

const keyBase = 'satphone-key inline-flex min-h-10 pointer-coarse:min-h-11 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider disabled:opacity-45';

const SIGNAL_BARS = [0.1, 0.2, 0.32, 0.44, 0.56, 0.68, 0.78, 0.88, 0.95, 1];

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

export function SatPhoneTalkButton({
  isFloating,
  capturing,
  handsFree,
  canChangeMicMode,
  hotkey,
  onMic,
}) {
  const openMic = handsFree || !canChangeMicMode;
  const MicIcon = capturing ? MicOff : Mic;
  const buttonAriaLabel = isFloating
    ? (handsFree
      ? (capturing ? 'Stop hands-free listening' : 'Start hands-free listening')
      : (capturing ? 'Send voice message' : 'Start listening'))
    : (capturing ? (openMic ? 'Close mic' : 'Send voice') : (openMic ? 'Open mic' : 'Talk'));

  const buttonTitle = handsFree
    ? (capturing ? `Click or press ${hotkey} to close mic` : `Click or press ${hotkey} to open hands-free mic`)
    : (capturing ? `Click or press ${hotkey} to send voice` : `Click or press ${hotkey} to talk`);

  const buttonLegend = capturing ? (openMic ? 'LIVE' : 'SEND') : 'TALK';

  return (
    <button
      type="button"
      onClick={onMic}
      aria-pressed={capturing}
      aria-label={buttonAriaLabel}
      title={buttonTitle}
      className="satphone-paddle inline-flex min-h-10 pointer-coarse:min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${
          capturing
            ? 'bg-port-on-accent-2 shadow-[0_0_8px_currentColor] animate-pulse'
            : 'bg-port-accent-2/70'
        }`}
      />
      <MicIcon size={14} aria-hidden="true" />
      <span
        aria-hidden="true"
        className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
      >
        {buttonLegend}
      </span>
    </button>
  );
}

export function SatPhoneTelemetry({
  isFloating,
  stage,
  capturing,
  handsFree,
  canChangeMicMode,
  hotkey,
  onMic,
  onMode,
  channel,
  channelCount = 0,
  onNextChannel,
  volume,
  muted,
  voiceLabel,
  llmProvider,
  llmModel,
  llmResidency = null,
  signalLevel,
  onVolumeChange,
  onToggleMute,
}) {
  const llmDisplay = llmModel && llmModel !== 'auto'
    ? voiceModelDisplayName(llmModel)
    : (llmProvider ? `${llmProvider} · auto` : null);
  const residencyShort = voiceLlmResidencyBadge(llmResidency)?.short;
  const llmLine = [llmDisplay, llmDisplay && residencyShort].filter(Boolean).join(' · ');
  const voiceDisplay = voiceLabel || 'Saved voice';
  const channelNumber = (channel?.index ?? 0) + 1;
  const channelName = channel?.label || `Channel ${channelNumber}`;

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex flex-1 flex-col gap-1.5 min-w-0">
          {/* Digital LCD readout — active brain, voice, and live audio signal level */}
          <div className="satphone-lcd flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 min-w-0">
            <div className="flex flex-col gap-0.5 min-w-0">
              {llmLine && (
                <span className="font-mono text-[10px] font-semibold truncate" title={llmLine}>
                  {llmLine}
                </span>
              )}
              <span className="font-mono text-[10px] opacity-75 truncate" title={voiceDisplay}>
                {voiceDisplay}
              </span>
            </div>
            <SignalMeter level={signalLevel} stage={stage} muted={muted} />
          </div>

          <SatPhoneTalkButton
            isFloating={isFloating}
            capturing={capturing}
            handsFree={handsFree}
            canChangeMicMode={canChangeMicMode}
            hotkey={hotkey}
            onMic={onMic}
          />
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

      {/* Mode & channel keys */}
      <div className={`grid gap-1.5 ${canChangeMicMode ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {canChangeMicMode && (
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
        )}
        <button
          type="button"
          onClick={onNextChannel}
          disabled={!onNextChannel || channelCount < 2}
          aria-label={`Channel ${channelNumber}, ${channelName}. Switch to the next channel`}
          title={`CH${channelNumber} · ${channelName} — click for the next channel's avatar`}
          className={`${keyBase} min-w-0`}
        >
          <ScanFace size={13} aria-hidden="true" className="shrink-0" />
          <span className="shrink-0">{`CH${channelNumber}`}</span>
          <span aria-hidden="true" className="truncate opacity-70 normal-case">{channelName}</span>
        </button>
      </div>
    </div>
  );
}

export function SatPhoneActionKeys({
  stage,
  sfxEnabled,
  onToggleSfx,
  muted,
  onToggleMute,
  visionEnabled,
  onToggleVision,
  onInterrupt,
  onEnd,
}) {
  return (
    <>
      <div className={`grid gap-1.5 ${onToggleVision ? 'grid-cols-2 min-[340px]:grid-cols-4' : 'grid-cols-3'}`}>
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

        {onToggleVision && (
          <button
            type="button"
            onClick={onToggleVision}
            aria-pressed={visionEnabled}
            data-active={visionEnabled ? 'true' : 'false'}
            aria-label={visionEnabled ? 'Disable screen vision for voice' : 'Enable screen vision for voice'}
            title={visionEnabled
              ? 'Vision ON — the assistant sees your shared tab with each message. Click to stop.'
              : 'Share a tab so the assistant sees it with each message'}
            className={keyBase}
          >
            {visionEnabled ? <Monitor size={12} aria-hidden="true" /> : <MonitorOff size={12} aria-hidden="true" />}
            Vision
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
    </>
  );
}
