import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';
import SatPhoneCaption from './SatPhoneCaption';

const STATUS_LABELS = {
  idle: 'Standby',
  listening: 'Listening',
  handsfree: 'Mic open',
  capturing: 'Listening',
  loading: 'Loading model',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const STATUS_DOTS = {
  idle: 'bg-port-text-muted',
  speaking: 'bg-port-success animate-pulse',
  loading: 'bg-port-warning animate-ping',
  thinking: 'bg-port-warning animate-pulse',
};

export default function SatPhoneViewfinder({
  avatarFilename = null,
  channel,
  runningAvatar,
  stage,
  capturing,
  caption,
}) {
  const statusText = STATUS_LABELS[stage] || STATUS_LABELS.idle;
  const channelBadge = `CH${(channel?.index ?? 0) + 1}`;
  const screenBadge = `${channelBadge} · ${runningAvatar ? 'AVATAR LIVE' : 'PORTRAIT'}`;

  return (
    <div className="satphone-bezel relative isolate flex-1 min-w-0 overflow-hidden rounded-xl border">
      {/* Remount per face so a channel change restarts the idle stream on the new portrait. */}
      <VoiceCallGenerativePortrait
        key={`${runningAvatar ? 'animated' : 'still'}:${avatarFilename || 'default'}`}
        running={runningAvatar}
        stage={stage}
        avatarFilename={avatarFilename}
        fill
      />

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
            className={`h-1.5 w-1.5 rounded-full ${capturing ? 'bg-port-accent-2 animate-pulse' : STATUS_DOTS[stage] || STATUS_DOTS.idle}`}
          />
          {statusText}
        </p>
      </div>

      <SatPhoneCaption caption={caption} />
    </div>
  );
}
