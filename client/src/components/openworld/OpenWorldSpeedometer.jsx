import { useMemo } from 'react';
import { TOTAL_SHARDS } from '../../utils/openWorldCollectibles';

export default function OpenWorldSpeedometer({
  playerPose,
  collectedCount = 0,
  totalShards = TOTAL_SHARDS,
}) {
  const speed = playerPose?.speed || 0;
  const kmh = Math.round(Math.abs(speed) * 3.6);
  const speedRatio = Math.min(1, Math.abs(speed) / 38);

  const modeBadge = useMemo(() => {
    if (playerPose?.airborne) return { label: 'AIRBORNE', color: 'text-purple-400 border-purple-500/40 bg-purple-500/10' };
    if (playerPose?.skid > 0.4 && Math.abs(speed) > 5) return { label: 'DRIFT', color: 'text-amber-400 border-amber-500/40 bg-amber-500/10' };
    if (playerPose?.boosting || Math.abs(speed) > 26) return { label: 'BOOST', color: 'text-cyan-300 border-cyan-400/50 bg-cyan-400/20 animate-pulse' };
    if (speed < -0.2) return { label: 'REVERSE', color: 'text-rose-400 border-rose-500/40 bg-rose-500/10' };
    if (Math.abs(speed) > 0.2) return { label: 'DRIVE', color: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' };
    return { label: 'PARK', color: 'text-slate-400 border-slate-500/30 bg-slate-500/10' };
  }, [playerPose, speed]);

  return (
    <div className="openworld-hud-panel px-3.5 py-2 flex items-center gap-3.5 select-none pointer-events-auto">
      {/* Speedometer Digital Readout */}
      <div className="flex flex-col items-start min-w-[3.6rem]">
        <div className="flex items-baseline gap-1">
          <span className="font-pixel text-lg font-bold tracking-tight text-[rgb(var(--port-text))]">
            {kmh}
          </span>
          <span className="font-pixel text-[8px] text-[rgb(var(--port-text-muted))]">
            KM/H
          </span>
        </div>
        {/* Speed Bar Gauge */}
        <div className="w-full h-1 bg-[rgb(var(--port-accent)/.15)] rounded-full overflow-hidden mt-0.5">
          <div
            className="h-full bg-[rgb(var(--port-accent))] transition-all duration-75 rounded-full"
            style={{ width: `${Math.round(speedRatio * 100)}%` }}
          />
        </div>
      </div>

      {/* Drive Mode Pill */}
      <span
        className={`font-pixel text-[8px] px-2 py-0.5 rounded-md border tracking-wider uppercase ${modeBadge.color}`}
      >
        {modeBadge.label}
      </span>

      {/* Cyber Shards Counter */}
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[rgb(var(--port-accent)/.08)] border border-[rgb(var(--port-accent)/.2)]">
        <span className="font-pixel text-[10px] text-cyan-400">⯁</span>
        <span className="font-pixel text-[8px] tracking-wider text-[rgb(var(--port-text))]">
          {collectedCount}/{totalShards}
        </span>
      </div>
    </div>
  );
}
