import { formatDateTime, timeAgo } from '../../utils/formatters';

// Timeline-scrubber HUD overlay (roadmap 3.6, issue #967). When playback mode is
// active it draws a bottom transport bar: play/pause, speed, a draggable timeline
// slider, frame-step buttons, the current frame's timestamp, and a note that the
// landmarks the snapshot can't replay are showing LIVE data (frozen during scrub).
// Mirrors CityPhotoOverlay's bottom-bar styling. All transport logic lives in the
// useCityPlayback hook; this is presentation only.

export default function CityPlaybackOverlay({
  active,
  loading,
  snapshots = [],
  frameIndex,
  currentFrame,
  playing,
  speed,
  onSeek,
  onStep,
  onTogglePlay,
  onCycleSpeed,
  onExit,
}) {
  if (!active) return null;

  const frameCount = snapshots.length;
  const hasFrames = frameCount > 0;
  const ts = currentFrame?.ts;

  return (
    <div className="absolute inset-0 z-30 pointer-events-none cybercity-themed">
      {/* Top-right: title + exit */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4">
        <div className="font-pixel text-[11px] text-cyan-400 tracking-widest" style={{ textShadow: '0 0 10px rgba(6,182,212,0.5)' }}>
          ⟲ CITY HISTORY {hasFrames ? `— ${frameIndex + 1}/${frameCount}` : ''}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="font-pixel text-[10px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-3 py-1.5 hover:bg-cyan-500/10 transition-all pointer-events-auto"
          title="Exit playback (Esc)"
        >
          [ EXIT ]
        </button>
      </div>

      {/* Bottom transport bar */}
      <div className="absolute bottom-0 left-0 right-0 px-6 pb-5 pt-3 bg-gradient-to-t from-black/70 to-transparent">
        {loading && (
          <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider text-center pb-2">LOADING HISTORY…</div>
        )}

        {!loading && !hasFrames && (
          <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider text-center pb-2">
            NO SNAPSHOTS YET — the city records its state every few minutes. Check back later.
          </div>
        )}

        {!loading && hasFrames && (
          <div className="flex flex-col gap-2">
            {/* Timestamp + live-data note */}
            <div className="flex items-center justify-between font-pixel text-[10px] text-cyan-300/90 tracking-wider">
              <span title={ts ? formatDateTime(ts) : ''}>{ts ? formatDateTime(ts) : '—'}</span>
              <span className="text-amber-400/80" title="Buildings, agents, health, backup, tasks & counts are historical. Memory, goals, Jira & activity show current live data.">
                ⚠ some districts show LIVE data
              </span>
              <span className="text-cyan-500/60">{ts ? timeAgo(ts) : ''}</span>
            </div>

            {/* Timeline slider */}
            <input
              type="range"
              min={0}
              max={frameCount - 1}
              step={1}
              value={frameIndex}
              onChange={(e) => onSeek?.(Number(e.target.value))}
              aria-label="Timeline position"
              className="w-full accent-cyan-400 pointer-events-auto cursor-pointer"
            />

            {/* Transport controls */}
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => onStep?.(-1)}
                disabled={frameIndex <= 0}
                className="font-pixel text-cyan-400 text-lg px-2 hover:text-cyan-300 transition-colors pointer-events-auto disabled:opacity-30"
                title="Previous frame (←)"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={onTogglePlay}
                className="font-pixel text-[11px] text-black bg-cyan-400 tracking-wider rounded px-4 py-2 hover:bg-cyan-300 transition-all pointer-events-auto"
                title="Play / pause (Space)"
              >
                {playing ? '❚❚ PAUSE' : '▶ PLAY'}
              </button>
              <button
                type="button"
                onClick={() => onStep?.(1)}
                disabled={frameIndex >= frameCount - 1}
                className="font-pixel text-cyan-400 text-lg px-2 hover:text-cyan-300 transition-colors pointer-events-auto disabled:opacity-30"
                title="Next frame (→)"
              >
                ▶
              </button>
              <button
                type="button"
                onClick={onCycleSpeed}
                className="font-pixel text-[10px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-3 py-1.5 hover:bg-cyan-500/10 transition-all pointer-events-auto"
                title="Playback speed"
              >
                {speed}×
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
