import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, MonitorPlay } from 'lucide-react';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';
import { resolvePreviewSource } from '../../lib/musicVideoStages.js';
import { formatTimecode } from '../../utils/formatters.js';

// The fallback when the project has no composition document: the newest
// finished draft excerpt. Its clock starts at the excerpt's own start, so a
// seek to song time `t` lands at `t - startSec` and is ignored outside it.
function ExcerptPreview({ excerpt, seekRequest, collapsed }) {
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
    const t = seekRequest.t - excerpt.startSec;
    if (t >= 0 && t <= excerpt.endSec - excerpt.startSec) seekTo(t);
  }, [seekRequest, excerpt.startSec, excerpt.endSec]);
  return (
    <video
      ref={videoRef}
      src={`/data/videos/${excerpt.filename}`}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={() => { if (pending.current != null) { seekTo(pending.current); pending.current = null; } }}
      aria-label="Latest draft excerpt preview"
      className={`aspect-video max-h-[50vh] w-full rounded border border-port-border bg-black object-contain ${collapsed ? 'max-lg:hidden' : ''}`}
    />
  );
}

/**
 * The docked preview card. `MusicVideoLayout` places it: a right-hand column
 * beside the Board, Compose and Review tabs from `lg` up, a collapsible
 * mini-player pinned above the bottom tab bar below it. Plays the composition
 * document when there is one, else the latest draft excerpt; renders nothing
 * when there is neither. `seekRequest` (`{ t, n }`) is the scene-card seek.
 */
export default function PreviewDock({ project, audioUrl, seekRequest, collapsed, onToggleCollapsed }) {
  const source = resolvePreviewSource(project);
  if (!source) return null;
  const subtitle = source.kind === 'document'
    ? 'Composition document'
    : `Draft ${formatTimecode(source.excerpt.startSec)}–${formatTimecode(source.excerpt.endSec)}`;
  const Chevron = collapsed ? ChevronUp : ChevronDown;
  return (
    <aside aria-label="Preview" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2 max-lg:rounded-b-none">
      <div className="flex items-center gap-2 text-xs text-port-text-muted">
        <MonitorPlay size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
        <span className="text-sm font-medium text-port-text">Preview</span>
        <span className="min-w-0 truncate">{subtitle}</span>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
          className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded lg:hidden"
        >
          <Chevron size={16} aria-hidden="true" />
        </button>
      </div>
      {source.kind === 'document'
        ? <CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} />
        : <ExcerptPreview excerpt={source.excerpt} seekRequest={seekRequest} collapsed={collapsed} />}
    </aside>
  );
}
