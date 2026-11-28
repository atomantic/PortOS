import { useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';
import { getVisionStream, onVisionFrameCaptured } from '../../services/voiceClient';

const STATUS_LABELS = {
  idle: 'Standby',
  listening: 'Listening',
  handsfree: 'Mic open',
  capturing: 'Listening',
  loading: 'Loading model',
  connecting: 'Connecting',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const STATUS_DOTS = {
  idle: 'bg-port-text-muted',
  speaking: 'bg-port-success animate-pulse',
  loading: 'bg-port-warning animate-ping',
  connecting: 'bg-port-warning animate-ping',
  thinking: 'bg-port-warning animate-pulse',
};

function VisionPip({ onStop }) {
  const videoRef = useRef(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const stream = typeof getVisionStream === 'function' ? getVisionStream() : null;
    const video = videoRef.current;
    if (!stream || !video) {
      setHasVideo(false);
      return undefined;
    }
    video.srcObject = stream;
    video.play?.().catch(() => {});
    setHasVideo(true);
    return () => {
      video.srcObject = null;
    };
  }, []);

  useEffect(() => {
    if (typeof onVisionFrameCaptured !== 'function') return undefined;
    let timer;
    const off = onVisionFrameCaptured(() => {
      setFlash(true);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(false), 450);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={onStop}
      aria-label="Screen vision active. Click to stop sharing"
      title={flash ? 'Frame captured for assistant — click to stop sharing' : 'Live screen vision preview — click to stop sharing'}
      className={`group absolute bottom-2 right-2 z-10 w-20 aspect-video pointer-coarse:min-h-11 pointer-coarse:min-w-11 overflow-hidden rounded-md border bg-port-bg/90 shadow-lg transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${
        flash
          ? 'border-port-success ring-2 ring-port-success shadow-[0_0_14px_rgb(var(--port-success)/0.7)]'
          : 'border-port-accent/80 hover:border-port-error'
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        tabIndex={-1}
        className={`block size-full object-cover ${hasVideo ? '' : 'hidden'}`}
      />
      {!hasVideo && (
        <span aria-hidden="true" className="flex size-full items-center justify-center text-port-accent">
          <Monitor size={16} />
        </span>
      )}
      <span
        aria-hidden="true"
        className="port-media-overlay-strong pointer-events-none absolute left-1 top-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[7px] font-bold uppercase leading-none tracking-wider"
      >
        <span className={`h-1 w-1 rounded-full ${flash ? 'bg-port-success' : 'bg-port-accent animate-pulse'}`} />
        {flash ? 'SNAP' : 'VIS'}
      </span>
    </button>
  );
}

export default function SatPhoneViewfinder({
  avatarFilename = null,
  channel,
  agentName = '',
  runningAvatar,
  connecting = false,
  stage,
  capturing,
  signalLevel = 0,
  muted = false,
  visionEnabled = false,
  onToggleVision,
}) {
  // Connecting wins over the idle states: the call is not usable yet. A turn in progress still shows its own stage.
  const shownStage = connecting && (stage === 'idle' || !STATUS_LABELS[stage]) ? 'connecting' : stage;
  const statusText = STATUS_LABELS[shownStage] || STATUS_LABELS.idle;
  const channelBadge = `CH${(channel?.index ?? 0) + 1}`;
  const trimmedName = agentName?.trim();
  const screenBadge = trimmedName ? `${channelBadge} · ${trimmedName}` : channelBadge;
  const audioState = capturing
    ? 'tx'
    : stage === 'speaking'
      ? 'rx'
      : (stage === 'thinking' || stage === 'loading')
        ? 'thinking'
        : 'idle';
  const glow = audioState === 'idle' || (audioState === 'rx' && muted)
    ? 0
    : audioState === 'thinking'
      ? 0.45
      : Math.max(0.2, Math.min(1, signalLevel * 3.5));

  return (
    <div
      data-audio-state={audioState}
      style={{ '--satphone-glow': glow.toFixed(2) }}
      className="satphone-bezel relative isolate w-full min-w-0 overflow-hidden rounded-xl border"
    >
      {/* Remount per face so a channel change restarts the idle stream on the new portrait. */}
      <VoiceCallGenerativePortrait
        key={`${runningAvatar ? 'animated' : 'still'}:${avatarFilename || 'default'}`}
        running={runningAvatar}
        connecting={connecting}
        stage={stage}
        avatarFilename={avatarFilename}
        fill
      />

      {/* Top HUD chips (theme-safe .port-media-overlay-strong over media) */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-1.5 min-w-0">
        <span
          title={screenBadge}
          className="port-media-overlay-strong min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] border border-port-border/70"
        >
          {screenBadge}
        </span>
        <p
          role="status"
          className="port-media-overlay-strong shrink-0 inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider border border-port-border/70"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${capturing ? 'bg-port-accent-2 animate-pulse' : STATUS_DOTS[shownStage] || STATUS_DOTS.idle}`}
          />
          {statusText}
        </p>
      </div>

      {visionEnabled && <VisionPip onStop={onToggleVision} />}
    </div>
  );
}
