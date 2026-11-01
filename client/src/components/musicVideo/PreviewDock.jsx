import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, ChevronUp, Maximize2, Minimize2, MonitorPlay } from 'lucide-react';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';
import StoryboardAnimatic from './StoryboardAnimatic.jsx';
import ShotStepper, { shotSteps } from './ShotStepper.jsx';
import FrameStepper, { captureMediaFrame } from './FrameStepper.jsx';

// A rendered file (the final render or a draft excerpt). Its clock starts at
// the clip's own start, so a seek to song time `t` lands at `t - startSec` and
// is ignored outside it. Back and Next step through the shots inside it.
function VideoPreview({ source, scenes, projectName, seekRequest, collapsed, onEditShot = null }) {
  const videoRef = useRef(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(null);
  const pending = useRef(null);
  const applied = useRef(null);
  const seekTo = (t, play = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 1) video.currentTime = Math.min(t, video.duration || t);
    else pending.current = t;
    if (play) video.play?.()?.catch?.(() => {});
  };
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n) return;
    applied.current = seekRequest.n;
    const t = seekRequest.t - source.startSec;
    if (t >= 0 && (source.endSec == null || t <= source.endSec - source.startSec)) seekTo(t, !!seekRequest.play);
  }, [seekRequest, source.startSec, source.endSec]);
  const startSec = source.startSec || 0;
  const range = { startSec, endSec: source.endSec ?? null };
  const songTime = startSec + time;
  const shot = shotSteps(scenes, songTime, range).index;
  const stepFrame = (t) => {
    videoRef.current?.pause?.();
    seekTo(t - startSec);
    setTime(t - startSec);
  };
  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      {/* The height limit caps the width, not the height alone: a capped height
          over a full-width box made it wider than 16:9 and pillarboxed the video. */}
      <video
        ref={videoRef}
        src={source.src}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={() => { if (pending.current != null) { seekTo(pending.current); pending.current = null; } }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedData={(e) => setDuration(e.currentTarget.duration)}
        aria-label={source.id === 'final' ? 'Final render preview' : 'Draft excerpt preview'}
        className="mx-auto block aspect-video w-full max-w-[calc(50vh*16/9)] rounded border border-port-border bg-black object-contain"
      />
      <ShotStepper
        scenes={scenes}
        time={songTime}
        onSeek={(t) => { seekTo(t - startSec); setTime(t - startSec); }}
        onEditShot={onEditShot ? (sceneId) => { videoRef.current?.pause?.(); onEditShot(sceneId); } : null}
        range={range}
        keys
      />
      <FrameStepper
        time={songTime}
        onSeek={stepFrame}
        maxSec={source.endSec ?? (Number.isFinite(duration) ? startSec + duration : null)}
        capture={() => captureMediaFrame(videoRef.current)}
        label={[projectName, shot ? `Shot ${shot}` : null].filter(Boolean).join(' · ')}
        keys
      />
    </div>
  );
}

/**
 * The docked preview card, on every watched step (not Story, Plan or Assets). `MusicVideoLayout` places it: a
 * right-hand column from `xl` up; below it, a folded row above the step that
 * opens into the player. `sources` is `listPreviewSources(…)`; the picked one is the
 * `?play=` param, defaulting to the first (final render, then the live
 * composition, then the newest draft, then the storyboard animatic). With
 * nothing to play yet it says what makes something playable. `seekRequest`
 * (`{ t, n }`) is the scene-card seek.
 */
export default function PreviewDock({ project, sources, audioUrl, seekRequest, collapsed, onToggleCollapsed, expanded = false, onToggleExpanded, onEditShot = null }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('play');
  const source = sources.find((entry) => entry.id === requested) || sources[0] || null;
  const pick = (id) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === sources[0].id) next.delete('play');
    else next.set('play', id);
    return next;
  }, { replace: true });
  // The folded row sits in the page, so it opens downward.
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const SizeIcon = expanded ? Minimize2 : Maximize2;
  const pickerId = `mv-preview-source-${project.id}`;
  return (
    // A flex gap, not space-y: space-y puts a margin under the header row even
    // when everything after it is hidden, so the folded dock sat off-center.
    <aside aria-label="Preview" className="@container/mv-preview flex min-w-0 flex-col gap-2 rounded-lg border border-port-border bg-port-card p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-text-muted">
        <MonitorPlay size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
        <span className="text-sm font-medium text-port-text">Preview</span>
        {sources.length > 1 ? (
          <>
            <label htmlFor={pickerId} className="sr-only">Preview source</label>
            <select
              id={pickerId}
              value={source.id}
              onChange={(e) => pick(e.target.value)}
              className="order-last min-h-[44px] min-w-0 basis-full truncate rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-port-text sm:min-h-[28px] @min-[32rem]/mv-preview:order-none @min-[32rem]/mv-preview:basis-auto @min-[32rem]/mv-preview:flex-1"
            >
              {sources.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </>
        ) : (
          <span className="order-last min-w-0 basis-full truncate @min-[32rem]/mv-preview:order-none @min-[32rem]/mv-preview:basis-auto">{source ? source.label : 'Nothing to play yet'}</span>
        )}
        {onToggleExpanded && (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-pressed={expanded}
            aria-label={expanded ? 'Return preview to sidebar' : 'Expand preview into main area'}
            title={expanded ? 'Return preview to sidebar' : 'Expand preview into main area'}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 ml-auto hidden min-h-[28px] min-w-[28px] shrink-0 items-center justify-center rounded border border-port-border text-port-text hover:border-port-accent xl:flex"
          >
            <SizeIcon size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
          className="ml-auto flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded xl:hidden"
        >
          <Chevron size={16} aria-hidden="true" />
        </button>
      </div>
      {!source && (
        <p className={`text-xs text-port-text-muted ${collapsed ? 'max-xl:hidden' : ''}`}>
          {project.trackId || project.uploadedAudioFilename
            ? 'The lyric timing playthrough plays here once the song is analyzed and its words are aligned; the storyboard, drafts and final render join it as you make them.'
            : 'Attach a track to watch the lyric timing playthrough here; the storyboard, drafts and final render join it as you make them.'}
        </p>
      )}
      {/* Folded below xl, the dock is one row: the player and its controls wait for the expand. */}
      {source?.kind === 'document' && <div className={collapsed ? 'max-xl:hidden' : ''}><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} shotNav onEditShot={onEditShot} /></div>}
      {source?.kind === 'lyrics' && <div className={collapsed ? 'max-xl:hidden' : ''}><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} lyrics shotNav onEditShot={onEditShot} /></div>}
      {source?.kind === 'animatic' && <StoryboardAnimatic project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} />}
      {source?.kind === 'video' && <VideoPreview key={source.id} source={source} scenes={project.scenes} projectName={project.name} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} />}
    </aside>
  );
}
