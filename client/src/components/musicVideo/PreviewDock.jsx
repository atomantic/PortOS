import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, ChevronUp, MonitorPlay } from 'lucide-react';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';

// A rendered file (the final render or a draft excerpt). Its clock starts at
// the clip's own start, so a seek to song time `t` lands at `t - startSec` and
// is ignored outside it.
function VideoPreview({ source, seekRequest, collapsed }) {
  const videoRef = useRef(null);
  const pending = useRef(null);
  const applied = useRef(null);
  const seekTo = (t) => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 1) video.currentTime = Math.min(t, video.duration || t);
    else pending.current = t;
  };
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n) return;
    applied.current = seekRequest.n;
    const t = seekRequest.t - source.startSec;
    if (t >= 0 && (source.endSec == null || t <= source.endSec - source.startSec)) seekTo(t);
  }, [seekRequest, source.startSec, source.endSec]);
  return (
    <video
      ref={videoRef}
      src={source.src}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={() => { if (pending.current != null) { seekTo(pending.current); pending.current = null; } }}
      aria-label={source.id === 'final' ? 'Final render preview' : 'Draft excerpt preview'}
      className={`aspect-video max-h-[50vh] w-full rounded border border-port-border bg-black object-contain ${collapsed ? 'max-lg:hidden' : ''}`}
    />
  );
}

/**
 * The docked preview card. `MusicVideoLayout` places it: a right-hand column
 * beside every stage from `lg` up, a collapsible mini-player pinned above the
 * bottom tab bar below it. `sources` is `listPreviewSources(…)` (never empty —
 * the page passes no dock when there is nothing to play); the picked one is
 * the `?play=` param, defaulting to the first (final render, then the live
 * composition, then the newest draft). `seekRequest` (`{ t, n }`) is the
 * scene-card seek.
 */
export default function PreviewDock({ project, sources, audioUrl, seekRequest, collapsed, onToggleCollapsed }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('play');
  const source = sources.find((entry) => entry.id === requested) || sources[0];
  const pick = (id) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === sources[0].id) next.delete('play');
    else next.set('play', id);
    return next;
  }, { replace: true });
  const Chevron = collapsed ? ChevronUp : ChevronDown;
  const pickerId = `mv-preview-source-${project.id}`;
  return (
    <aside aria-label="Preview" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2 max-lg:rounded-b-none">
      <div className="flex min-w-0 items-center gap-2 text-xs text-port-text-muted">
        <MonitorPlay size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
        <span className="text-sm font-medium text-port-text">Preview</span>
        {sources.length > 1 ? (
          <>
            <label htmlFor={pickerId} className="sr-only">Preview source</label>
            <select
              id={pickerId}
              value={source.id}
              onChange={(e) => pick(e.target.value)}
              className="min-h-[44px] min-w-0 flex-1 truncate rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-port-text sm:min-h-0"
            >
              {sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </>
        ) : (
          <span className="min-w-0 truncate">{source.label}</span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
          className="ml-auto flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded lg:hidden"
        >
          <Chevron size={16} aria-hidden="true" />
        </button>
      </div>
      {source.kind === 'document'
        ? <CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} />
        : <VideoPreview key={source.id} source={source} seekRequest={seekRequest} collapsed={collapsed} />}
    </aside>
  );
}
