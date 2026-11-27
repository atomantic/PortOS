import { AudioLines } from 'lucide-react';
import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';

const STATUS_LABELS = {
  idle: 'Standby',
  listening: 'Listening',
  handsfree: 'Mic open',
  capturing: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export default function SatPhoneViewfinder({
  avatar,
  runningAvatar,
  stage,
  capturing,
  caption,
}) {
  const statusText = STATUS_LABELS[stage] || STATUS_LABELS.idle;
  const screenBadge = !avatar
    ? 'AUDIO ONLY'
    : runningAvatar
      ? 'AVATAR LIVE'
      : 'PORTRAIT';

  return (
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
  );
}
