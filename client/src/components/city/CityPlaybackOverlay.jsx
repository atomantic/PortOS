import { formatDateTime, timeAgo } from '../../utils/formatters';

// Timeline-scrubber HUD overlay (roadmap 3.6, issue #967). When playback mode is
// active it draws a bottom transport bar: play/pause, speed, a draggable timeline
// slider, frame-step buttons, the current frame's timestamp, and a note that the
// landmarks the snapshot can't replay are showing LIVE data (frozen during scrub).
// Mirrors CityPhotoOverlay's bottom-bar styling. All transport logic lives in the
// useCityPlayback hook; this is presentation only.

// One historical stat chip; renders a null value as "—" so an unavailable
// capture reads distinctly from a real zero.
function Stat({ label, value, suffix = '' }) {
  return (
    <span className="text-cyan-300/80">
      <span className="text-cyan-500/60">{label}</span>{' '}
      {value == null ? '—' : `${value}${suffix}`}
    </span>
  );
}

export default function CityPlaybackOverlay({
  active,
  loading,
  error,
  snapshots = [],
  frameIndex,
  currentFrame,
  stats,
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

        {!loading && error && (
          <div className="font-pixel text-[10px] text-port-warning/80 tracking-wider text-center pb-2">
            COULDN'T LOAD HISTORY — the snapshot service didn't respond. Try again later.
          </div>
        )}

        {!loading && !error && !hasFrames && (
          <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider text-center pb-2">
            NO SNAPSHOTS YET — the city records its state every few minutes. Check back later.
          </div>
        )}

        {!loading && !error && hasFrames && (
          <div className="flex flex-col gap-2">
            {/* Timestamp + live-data note */}
            <div className="flex items-center justify-between font-pixel text-[10px] text-cyan-300/90 tracking-wider">
              <span title={ts ? formatDateTime(ts) : ''}>{ts ? formatDateTime(ts) : '—'}</span>
              <span className="text-port-warning/80" title="Buildings, agents, health, backup, tasks & counts are historical. Memory, goals, Jira & activity show current live data.">
                ⚠ some districts show LIVE data
              </span>
              <span className="text-cyan-500/60">{ts ? timeAgo(ts) : ''}</span>
            </div>

            {/* Captured-at-this-moment stats whose 3D landmarks stay live (so the
                historical numbers are still visible while scrubbing). */}
            {stats && (
              <div className="flex items-center justify-center flex-wrap gap-x-4 gap-y-1 font-pixel text-[9px] tracking-wider">
                <Stat label="CPU" value={stats.cpuPercent} suffix="%" />
                <Stat label="MEM" value={stats.memPercent} suffix="%" />
                <Stat label="DISK" value={stats.diskPercent} suffix="%" />
                <Stat label="AGENTS" value={stats.agentsActive} />
                <Stat label="TASKS" value={stats.tasksPending == null && stats.tasksInProgress == null ? null : (stats.tasksPending ?? 0) + (stats.tasksInProgress ?? 0)} />
                <Stat label="PEERS" value={stats.peersOnline == null ? null : `${stats.peersOnline}/${stats.peersTotal ?? '?'}`} />
                <Stat label="REVIEW" value={stats.reviewTotal} />
              </div>
            )}

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
