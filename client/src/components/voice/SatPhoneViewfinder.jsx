import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';

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

export default function SatPhoneViewfinder({
  avatarFilename = null,
  channel,
  agentName = '',
  runningAvatar,
  connecting = false,
  stage,
  capturing,
}) {
  // Connecting wins over the idle states: the call is not usable yet. A turn in progress still shows its own stage.
  const shownStage = connecting && (stage === 'idle' || !STATUS_LABELS[stage]) ? 'connecting' : stage;
  const statusText = STATUS_LABELS[shownStage] || STATUS_LABELS.idle;
  const channelBadge = `CH${(channel?.index ?? 0) + 1}`;
  const trimmedName = agentName?.trim();
  const screenBadge = trimmedName ? `${channelBadge} · ${trimmedName}` : channelBadge;

  return (
    <div className="satphone-bezel relative isolate w-full min-w-0 overflow-hidden rounded-xl border">
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
    </div>
  );
}
