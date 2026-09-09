/**
 * Timeline scrubber under the graph: drag (or play) to see the universe as it
 * stood at any issue. `null` is the whole universe — the far right of the
 * track — so the default view is everything, not issue zero.
 */

import { useEffect, useMemo } from 'react';
import { Pause, Play } from 'lucide-react';

// How long each issue holds while playing.
const PLAY_STEP_MS = 700;
const LANE_COLORS = ['#ec4899', '#f472b6', '#fb7185'];

export default function GraphTimeline({
  index, timeIndex, onTimeChange, playing, onPlayingChange, entriesIntroduced,
}) {
  const total = index.totalIssues;

  // Playback walks one issue per tick and stops by returning to "whole
  // universe" at the end, so the strip always lands somewhere meaningful.
  useEffect(() => {
    if (!playing || total === 0) return undefined;
    const timer = setInterval(() => {
      const next = timeIndex == null ? 0 : timeIndex + 1;
      if (next >= total) {
        onTimeChange(null);
        onPlayingChange(false);
      } else onTimeChange(next);
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, timeIndex, total, onTimeChange, onPlayingChange]);

  // Lane bounds + colour per series, derived once instead of re-scanning every
  // issue for every series (and again for every tick).
  const lanes = useMemo(() => index.series.map((s, i) => {
    const own = index.issues.filter((x) => x.seriesId === s.id);
    return {
      id: s.id,
      name: s.name,
      color: LANE_COLORS[i % LANE_COLORS.length],
      first: own[0]?.index ?? null,
      count: own.length,
    };
  }).filter((lane) => lane.count > 0), [index]);
  const laneColorBySeries = useMemo(
    () => new Map(lanes.map((lane) => [lane.id, lane.color])),
    [lanes],
  );

  if (total === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg px-4 py-3 text-xs text-gray-500">
        No series link to this universe yet — the timeline appears once an issue references its canon.
      </div>
    );
  }

  const current = timeIndex == null ? null : index.issues[timeIndex];
  const seriesName = current
    ? (index.byId.get(current.seriesId)?.name || '')
    : `${total} issues across ${index.series.length} series`;

  return (
    <div className="bg-port-card border border-port-border rounded-lg px-4 pt-2.5 pb-3 flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          aria-label={playing ? 'Pause timeline' : 'Play timeline'}
          className="w-8 h-8 flex items-center justify-center rounded-lg bg-port-accent/20 border border-port-accent/30 text-port-accent"
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <div className="text-xs text-white font-medium min-w-[220px]">
          {current ? current.name : 'Whole universe'}
          <span className="font-normal text-gray-500"> · {current ? `${seriesName} · ${entriesIntroduced} entries so far` : seriesName}</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { onTimeChange(null); onPlayingChange(false); }}
          className={`px-2.5 py-1 text-[11px] rounded-lg border ${
            timeIndex == null
              ? 'bg-port-accent/20 text-port-accent border-port-accent/30'
              : 'bg-transparent text-gray-400 border-port-border'
          }`}
        >
          Whole universe
        </button>
        <span className="hidden sm:inline text-[11px] text-gray-500">
          Drag to see the universe as it stood at any issue
        </span>
      </div>
      <div className="relative h-[38px]">
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className="absolute top-0 h-3.5 pl-1.5 text-[10px] leading-[14px] whitespace-nowrap overflow-hidden text-ellipsis"
            style={{
              left: `${(lane.first / total) * 100}%`,
              width: `${(lane.count / total) * 100}%`,
              borderLeft: `1px solid ${lane.color}`,
              color: lane.color,
            }}
          >
            {lane.name}
          </div>
        ))}
        <div className="absolute left-0 right-0 top-5 h-3">
          {index.issues.map((issue) => {
            const past = timeIndex == null || issue.index <= timeIndex;
            return (
              <span
                key={issue.id}
                title={issue.name}
                className="absolute top-0 h-3 rounded-sm"
                style={{
                  left: `calc(${(issue.index / total) * 100}% + 1px)`,
                  width: `calc(${(1 / total) * 100}% - 2px)`,
                  background: laneColorBySeries.get(issue.seriesId) || LANE_COLORS[0],
                  opacity: past ? (timeIndex == null ? 0.45 : 0.85) : 0.18,
                }}
              />
            );
          })}
        </div>
        <label htmlFor="universe-graph-time" className="sr-only">Timeline position</label>
        <input
          id="universe-graph-time"
          type="range"
          min={0}
          max={total}
          step={1}
          value={timeIndex == null ? total : timeIndex}
          onChange={(e) => {
            const value = Number(e.target.value);
            onTimeChange(value >= total ? null : value);
            onPlayingChange(false);
          }}
          className="absolute left-0 right-0 top-[22px] w-full m-0 h-2 bg-transparent accent-port-accent"
          style={{ background: 'transparent' }}
        />
      </div>
    </div>
  );
}
