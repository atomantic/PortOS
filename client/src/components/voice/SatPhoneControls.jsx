import { useEffect, useRef, useState } from 'react';
import {
  Gauge, Mic, MicOff, Monitor, MonitorOff, PhoneOff, Square, Volume2, VolumeX,
} from 'lucide-react';
import MediaImage from '../MediaImage';
import portraitUrl from './call-portrait.webp';
import { avatarImageSrc } from './useAvatarLibrary';
import SatPhoneRotaryDial from './SatPhoneRotaryDial';
import useVoiceTurnProgress from './useVoiceTurnProgress';
import { isPushToTalkKey } from '../../lib/a11yKeyboard';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { voiceLlmResidencyBadge } from './voiceLlmResidencyBadge';

const keyBase = 'satphone-key inline-flex min-h-9 pointer-coarse:min-h-11 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider disabled:opacity-45';

const SPECTRUM_BAR_COUNT = 12;
const EMPTY_WAVE = Array.from({ length: SPECTRUM_BAR_COUNT }, () => 0);
const PIPELINE_STEPS = [
  { id: 'stt', label: 'STT', activeTone: 'bg-port-accent-2 shadow-[0_0_6px_rgb(var(--port-accent-2)/0.8)] animate-pulse' },
  { id: 'llm', label: 'LLM', activeTone: 'bg-port-warning shadow-[0_0_6px_rgb(var(--port-warning)/0.8)] animate-pulse' },
  { id: 'tts', label: 'TTS', activeTone: 'bg-port-success shadow-[0_0_6px_rgb(var(--port-success)/0.8)] animate-pulse' },
];

export const TTS_RATE_STEPS = [0.9, 1, 1.25, 1.5];

export function nextTtsRate(current) {
  const numeric = Number(current);
  if (!Number.isFinite(numeric)) return 1;
  const next = TTS_RATE_STEPS.find((step) => step > numeric + 0.01);
  return next ?? TTS_RATE_STEPS[0];
}

export function formatTtsRate(rate) {
  const numeric = Number.isFinite(Number(rate)) ? Number(rate) : 1;
  return Number.isInteger(numeric) ? `${numeric.toFixed(1)}×` : `${numeric}×`;
}

function formatHotkeyBadge(hotkey) {
  if (!hotkey || typeof hotkey !== 'string') return '';
  return hotkey.replace(/\bSpace\b/i, 'SPACE').toUpperCase();
}

function AudioSpectrumMeter({ level, spectrum, stage, muted }) {
  const active = stage === 'speaking'
    ? 'rx'
    : (stage === 'capturing' || stage === 'listening' || stage === 'handsfree')
      ? 'tx'
      : 'idle';
  const waveRef = useRef(EMPTY_WAVE);
  const lastSampleRef = useRef({ level: 0, active: 'idle' });

  // Advance the rolling TX/fallback envelope whenever live audio level updates.
  if (active === 'idle' || (muted && active === 'rx')) {
    waveRef.current = EMPTY_WAVE;
    lastSampleRef.current = { level: 0, active };
  } else if (
    !Array.isArray(spectrum)
    && (lastSampleRef.current.level !== level || lastSampleRef.current.active !== active)
  ) {
    const scaled = Math.max(0.14, Math.min(1, level * 4.5));
    waveRef.current = [...waveRef.current.slice(1), scaled];
    lastSampleRef.current = { level, active };
  }

  const bars = (active === 'rx' && !muted && Array.isArray(spectrum) && spectrum.length === SPECTRUM_BAR_COUNT)
    ? spectrum
    : waveRef.current;

  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0" aria-hidden="true">
      <div className="flex items-end gap-[2px] h-5">
        {bars.map((amp, idx) => {
          const isQuiet = active === 'idle' || (muted && active === 'rx') || amp <= 0.02;
          const heightPct = isQuiet ? 16 : Math.round(18 + Math.min(1, amp) * 82);
          const barColor = isQuiet
            ? 'bg-port-border/45'
            : amp >= 0.85
              ? 'bg-port-warning'
              : active === 'tx'
                ? 'bg-port-accent-2'
                : 'bg-port-accent';
          return (
            <span
              key={idx}
              style={{ height: `${heightPct}%` }}
              className={`w-[2.5px] rounded-xs transition-[height,background-color] duration-75 motion-reduce:transition-none ${barColor}`}
            />
          );
        })}
      </div>
      <span className="font-mono text-[8px] uppercase tracking-[0.14em] opacity-70">
        {active === 'tx' ? 'TX WAVE' : active === 'rx' ? 'RX SPEC' : 'SIGNAL'}
      </span>
    </div>
  );
}

function PipelineProgressStrip({ stage }) {
  const { activeStep, sttDone, llmDone, latencyLabel } = useVoiceTurnProgress(stage);
  const doneMap = { stt: sttDone, llm: llmDone, tts: false };

  return (
    <div
      aria-hidden="true"
      className="mt-1.5 flex items-center justify-between gap-2 border-t border-port-border/35 pt-1"
    >
      <div className="flex flex-1 items-center gap-1 min-w-0">
        {PIPELINE_STEPS.map((step) => {
          const isActive = activeStep === step.id;
          const isDone = doneMap[step.id];
          const barTone = isActive
            ? step.activeTone
            : isDone
              ? 'bg-port-accent/70'
              : 'bg-port-border/45';
          return (
            <span key={step.id} className="flex flex-1 items-center gap-1 min-w-0">
              <span className={`h-1 flex-1 rounded-full transition-colors ${barTone}`} />
              <span className={`font-mono text-[7px] font-semibold tracking-wider ${isActive ? 'opacity-100' : isDone ? 'opacity-85' : 'opacity-75'}`}>
                {step.label}
              </span>
            </span>
          );
        })}
      </div>
      <span className="shrink-0 tabular-nums font-mono text-[8px] opacity-75">
        {latencyLabel || '—'}
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
  const [hotkeyDown, setHotkeyDown] = useState(false);

  useEffect(() => {
    if (!hotkey) return undefined;
    const onKeyDown = (event) => {
      if (isPushToTalkKey(event, hotkey)) setHotkeyDown(true);
    };
    const release = () => setHotkeyDown(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', release);
    };
  }, [hotkey]);

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
  const keycap = formatHotkeyBadge(hotkey);

  return (
    <button
      type="button"
      onClick={onMic}
      aria-pressed={capturing}
      aria-label={buttonAriaLabel}
      title={buttonTitle}
      data-hotkey-down={hotkeyDown ? 'true' : 'false'}
      className="satphone-paddle inline-flex min-h-9 pointer-coarse:min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${
          capturing
            ? 'bg-port-on-accent-2 shadow-[0_0_8px_currentColor] animate-pulse'
            : 'bg-port-accent-2/70'
        }`}
      />
      <MicIcon size={14} aria-hidden="true" className="shrink-0" />
      <span
        aria-hidden="true"
        className="font-mono text-[11px] font-bold uppercase tracking-[0.16em]"
      >
        {buttonLegend}
      </span>
      {keycap && (
        <kbd
          className={`pointer-coarse:hidden ml-0.5 rounded border border-current/25 bg-current/10 px-1 py-0.5 font-mono text-[8px] font-semibold leading-none tracking-wider opacity-75 ${
            canChangeMicMode ? 'hidden min-[400px]:inline-block' : 'inline-block'
          }`}
        >
          {keycap}
        </kbd>
      )}
    </button>
  );
}

function channelTooltip(ch, number, displayName, isActive, canTune) {
  const header = `CH${number}${displayName ? ` · ${displayName}` : ''}${isActive ? ' (on air)' : ''}`;
  const details = [];
  const voice = ch?.agent?.voiceId?.split(':').slice(1).join(':');
  if (voice) details.push(`voice: ${voice}`);
  if (ch?.agent?.provider) {
    const model = ch.agent.model && ch.agent.model !== 'auto'
      ? voiceModelDisplayName(ch.agent.model)
      : `${ch.agent.provider} (auto)`;
    details.push(`brain: ${model}`);
  }
  if (ch?.agent?.role) details.push(ch.agent.role);
  const summary = details.length ? ` — ${details.join(' · ')}` : '';
  const hint = canTune ? ' (double-click to tune)' : '';
  return `${isActive ? header : `Switch to ${header}`}${summary}${hint}`;
}

export function SatPhoneChannelStrip({
  channels = [],
  activeIndex = 0,
  globalAgentName = '',
  onSelectChannel,
  onTuneChannel,
}) {
  if (!channels.length) return null;

  return (
    <div
      role="group"
      aria-label="Channel selector"
      className="grid grid-cols-3 min-[340px]:grid-cols-6 gap-1 min-w-0"
    >
      {channels.map((ch, index) => {
        const number = index + 1;
        const isActive = index === activeIndex;
        const ownName = ch?.agent?.name?.trim() || ch?.label?.trim() || '';
        const displayName = ownName || (isActive ? globalAgentName?.trim() : '') || '';
        const tileLabel = displayName || `CH${number}`;
        const isTuned = Object.keys(ch?.agent || {}).filter((field) => field !== 'model').length > 0;

        return (
          <button
            key={index}
            type="button"
            onClick={() => { if (!isActive) onSelectChannel?.(index); }}
            onDoubleClick={() => onTuneChannel?.(index)}
            aria-pressed={isActive}
            aria-label={displayName ? `Channel ${number}, ${displayName}` : `Channel ${number}`}
            title={channelTooltip(ch, number, displayName, isActive, Boolean(onTuneChannel))}
            className={`group relative aspect-square min-h-11 w-full min-w-0 overflow-hidden rounded-lg border transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${
              isActive
                ? 'border-port-accent ring-1 ring-port-accent shadow-[0_0_10px_-2px_rgb(var(--port-accent)/0.65)]'
                : 'border-port-border opacity-80 hover:opacity-100 hover:border-port-accent/60'
            }`}
          >
            {ch?.avatar ? (
              <MediaImage
                src={avatarImageSrc(ch.avatar)}
                fallbackSrc={portraitUrl}
                thumbnail
                alt=""
                className="block size-full object-cover transition-transform duration-150 group-hover:scale-105"
              />
            ) : (
              <img
                src={portraitUrl}
                alt=""
                className="block size-full object-cover transition-transform duration-150 group-hover:scale-105"
              />
            )}
            {isTuned && (
              <span
                aria-hidden="true"
                data-channel-tuned="true"
                className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-port-warning shadow-[0_0_5px_rgb(var(--port-warning))]"
              />
            )}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent))]"
              />
            )}
            <span
              aria-hidden="true"
              className="port-media-overlay-strong pointer-events-none absolute inset-x-0 bottom-0 truncate px-0.5 py-0.5 text-center font-mono text-[8px] font-semibold leading-none uppercase tracking-tight"
            >
              {tileLabel}
            </span>
          </button>
        );
      })}
    </div>
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
  channels = [],
  activeChannelIndex = 0,
  globalAgentName = '',
  onSelectChannel,
  onTuneChannel,
  onOpenBrain,
  brainExpanded,
  brainControlsId,
  volume,
  muted,
  voiceLabel,
  llmProvider,
  llmModel,
  llmResidency = null,
  signalLevel,
  signalSpectrum = null,
  onVolumeChange,
  onToggleMute,
}) {
  const llmDisplay = llmModel && llmModel !== 'auto'
    ? voiceModelDisplayName(llmModel)
    : (llmProvider ? `${llmProvider} · auto` : null);
  const residencyBadge = voiceLlmResidencyBadge(llmResidency);
  const llmLine = [llmDisplay, llmDisplay && residencyBadge?.short].filter(Boolean).join(' · ');
  const voiceDisplay = voiceLabel || 'Saved voice';
  const lcdTitle = [llmDisplay && residencyBadge?.label ? `${llmDisplay} (${residencyBadge.label})` : llmLine, voiceDisplay, onOpenBrain ? 'Click to switch voice brain' : null]
    .filter(Boolean)
    .join(' — ');

  const lcdBody = (
    <>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          {llmLine && (
            <span className="flex items-center gap-1.5 min-w-0 font-mono text-[10px] font-semibold">
              {residencyBadge?.led && (
                <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${residencyBadge.led}`} />
              )}
              <span className="truncate">{llmLine}</span>
            </span>
          )}
          <span className="font-mono text-[10px] opacity-75 truncate">
            {voiceDisplay}
          </span>
        </div>
        <AudioSpectrumMeter level={signalLevel} spectrum={signalSpectrum} stage={stage} muted={muted} />
      </div>
      <PipelineProgressStrip stage={stage} />
    </>
  );

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex flex-1 flex-col gap-1.5 min-w-0">
          {/* Interactive digital LCD readout — active brain, residency, voice, spectrum, and stage progress */}
          {onOpenBrain ? (
            <button
              type="button"
              onClick={onOpenBrain}
              aria-expanded={typeof brainExpanded === 'boolean' ? brainExpanded : undefined}
              aria-controls={brainExpanded && brainControlsId ? brainControlsId : undefined}
              aria-label={`Voice telemetry: ${llmLine || voiceDisplay}. Open voice brain settings`}
              title={lcdTitle}
              className="satphone-lcd block w-full min-w-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors cursor-pointer hover:border-port-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
            >
              {lcdBody}
            </button>
          ) : (
            <div title={lcdTitle} className="satphone-lcd rounded-lg border px-2.5 py-1.5 min-w-0">
              {lcdBody}
            </div>
          )}

          <div className={`grid gap-1.5 ${canChangeMicMode ? 'grid-cols-1 min-[360px]:grid-cols-2' : 'grid-cols-1'}`}>
            <SatPhoneTalkButton
              isFloating={isFloating}
              capturing={capturing}
              handsFree={handsFree}
              canChangeMicMode={canChangeMicMode}
              hotkey={hotkey}
              onMic={onMic}
            />
            {canChangeMicMode && (
              <button
                type="button"
                onClick={onMode}
                aria-pressed={handsFree}
                data-active={handsFree ? 'true' : 'false'}
                title={handsFree
                  ? 'Hands-free (VOX) ON — mic stays open, auto-submits on pause. Click for push-to-talk.'
                  : 'Push-to-talk (PTT) ON — press TALK to record, press again to send. Click for hands-free.'}
                className={`${keyBase} min-w-0`}
              >
                <span className="truncate">{isFloating ? (handsFree ? 'hands-free' : 'push-to-talk') : 'Hands-free'}</span>
              </button>
            )}
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

      <SatPhoneChannelStrip
        channels={channels}
        activeIndex={activeChannelIndex}
        globalAgentName={globalAgentName}
        onSelectChannel={onSelectChannel}
        onTuneChannel={onTuneChannel}
      />
    </div>
  );
}

export function SatPhoneActionKeys({
  stage,
  realtimeActive = false,
  muted,
  onToggleMute,
  ttsRate = 1,
  onTtsRateChange,
  visionEnabled,
  onToggleVision,
  onInterrupt,
  onEnd,
}) {
  const showInterrupt = stage === 'speaking';
  const showEnd = realtimeActive;
  const showRate = typeof onTtsRateChange === 'function';
  const rateLabel = formatTtsRate(ttsRate);
  const nextRate = nextTtsRate(ttsRate);
  const actionBtn = `${keyBase} flex-1 whitespace-nowrap px-2`;

  return (
    <div className="flex flex-wrap gap-1.5 min-w-0">
      <button
        type="button"
        onClick={() => onToggleMute?.()}
        aria-pressed={muted}
        data-active={muted ? 'true' : 'false'}
        data-tone="warn"
        title={muted ? 'Audio muted — click to unmute handset output' : 'Mute handset audio output'}
        className={actionBtn}
      >
        {muted ? <VolumeX size={12} aria-hidden="true" className="shrink-0" /> : <Volume2 size={12} aria-hidden="true" className="shrink-0" />}
        {muted ? 'Muted' : 'Mute'}
      </button>

      {showRate && (
        <button
          type="button"
          onClick={() => onTtsRateChange(nextRate)}
          data-active={Math.abs((Number(ttsRate) || 1) - 1) > 0.01 ? 'true' : 'false'}
          aria-label={`Speech speed ${rateLabel}. Click to set ${formatTtsRate(nextRate)}`}
          title={`Speech speed ${rateLabel} — click to switch to ${formatTtsRate(nextRate)}`}
          className={actionBtn}
        >
          <Gauge size={12} aria-hidden="true" className="shrink-0" />
          <span className="tabular-nums">{rateLabel}</span>
        </button>
      )}

      {onToggleVision && (
        <button
          type="button"
          onClick={onToggleVision}
          aria-pressed={visionEnabled}
          data-active={visionEnabled ? 'true' : 'false'}
          aria-label="Screen vision for voice"
          title={visionEnabled
            ? 'Vision ON — the assistant sees your shared tab with each message. Click to stop.'
            : 'Share a tab so the assistant sees it with each message'}
          className={actionBtn}
        >
          {visionEnabled ? <Monitor size={12} aria-hidden="true" className="shrink-0" /> : <MonitorOff size={12} aria-hidden="true" className="shrink-0" />}
          Vision
        </button>
      )}

      {showInterrupt && (
        <button
          type="button"
          onClick={onInterrupt}
          data-tone="danger"
          title="Stop assistant speaking immediately"
          className={actionBtn}
        >
          <Square size={10} aria-hidden="true" className="shrink-0" />
          Interrupt
        </button>
      )}

      {showEnd && (
        <button
          type="button"
          onClick={onEnd}
          data-tone="danger"
          title="End active realtime call"
          className={actionBtn}
        >
          <PhoneOff size={12} aria-hidden="true" className="shrink-0" />
          End
        </button>
      )}
    </div>
  );
}
