import { useId } from 'react';
import { Pause, Play, Square } from 'lucide-react';

/**
 * Timeline controls for the declarative clips a Three.js model spec may declare
 * (`server/lib/threejsModel.js`). Presentation only: the playhead, the clip
 * selection, and the cue callback all live in the preview, so this stays a pure
 * render of the transport state and never owns a clock.
 */
export const CLIP_SPEEDS = [0.25, 0.5, 1, 2];

export default function ThreejsClipTransport({
  clips,
  clip,
  duration,
  time,
  playing,
  speed,
  activeSequenceNames = [],
  onSelectClip,
  onTogglePlay,
  onStop,
  onScrub,
  onSpeedChange,
}) {
  const clipSelectId = useId();
  const scrubId = useId();
  const speedSelectId = useId();
  if (!clip) return null;
  return (
    <div className="port-media-overlay pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px]">
      <label htmlFor={clipSelectId} className="whitespace-nowrap text-port-text-muted">Clip</label>
      <select
        id={clipSelectId}
        value={clip.id}
        onChange={(event) => onSelectClip(event.target.value)}
        className="port-media-overlay-item rounded px-1.5 py-1 text-[10px]"
      >
        {clips.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
      <button
        type="button"
        aria-label={playing ? 'Pause clip' : 'Play clip'}
        aria-pressed={playing}
        onClick={onTogglePlay}
        className="port-media-overlay-item rounded px-1.5 py-1"
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
      <button
        type="button"
        aria-label="Stop clip"
        disabled={!playing && time === 0}
        onClick={onStop}
        className="port-media-overlay-item rounded px-1.5 py-1 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Square className="h-3 w-3" />
      </button>
      {/* Dragging this never fires a cue — scrubbing is the silent mode, and the
          preview only collects cues from the play loop. */}
      <label htmlFor={scrubId} className="whitespace-nowrap text-port-text-muted">Time</label>
      <input
        id={scrubId}
        type="range"
        min="0"
        max={duration}
        step="0.01"
        value={Math.min(time, duration)}
        onChange={(event) => onScrub(Number(event.target.value))}
        className="h-1 w-24 cursor-pointer accent-port-accent sm:w-36"
      />
      <span className="w-16 tabular-nums text-port-text-muted">
        {time.toFixed(2)}/{duration.toFixed(2)}s
      </span>
      <label htmlFor={speedSelectId} className="whitespace-nowrap text-port-text-muted">Speed</label>
      <select
        id={speedSelectId}
        value={speed}
        onChange={(event) => onSpeedChange(Number(event.target.value))}
        className="port-media-overlay-item rounded px-1.5 py-1 text-[10px]"
      >
        {CLIP_SPEEDS.map((option) => <option key={option} value={option}>{option}×</option>)}
      </select>
      <span className="max-w-full truncate text-port-text-muted">
        {activeSequenceNames.length > 0 ? activeSequenceNames.join(' · ') : 'no sequence at this time'}
      </span>
    </div>
  );
}
