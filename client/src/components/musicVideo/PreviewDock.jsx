import { hasTemplateBeatReaction } from '../../../../server/lib/musicVideo/musicVideoTemplateEffects.js';
import { coldOpenScenes } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import useAudioLayerPlayback from './useAudioLayerPlayback.js';
import usePreviewSounds from './usePreviewSounds.js';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, ChevronUp, Maximize2, Minimize2, MonitorPlay } from 'lucide-react';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';
import StoryboardAnimatic from './StoryboardAnimatic.jsx';
import DraftCoverageNote from './DraftCoverageNote.jsx';
import ShotStepper, { shotSteps } from './ShotStepper.jsx';
import FrameStepper, { captureMediaFrame } from './FrameStepper.jsx';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import { getMusicVideoCompositionPlayback } from '../../services/apiMusicVideo.js';
import { hashString } from '../../utils/hashString.js';
import useSoloPlayback from '../../hooks/useSoloPlayback.js';
import './PreviewDock.css';

// Three.js loads only when the greybox previz is the source being watched.
const PrevizPlayer = lazy(() => import('./PrevizPlayer.jsx'));

// A rendered file (the final render or a draft excerpt). Its clock starts at
// the clip's own start, so a seek to song time `t` lands at `t - startSec` and
// is ignored outside it. Back and Next step through the shots inside it.
function VideoPreview({ source, scenes, projectName, seekRequest, collapsed, onEditShot = null }) {
  const videoRef = useRef(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(null);
  const pending = useRef(null);
  const applied = useRef(null);
  const seekTo = (t, play = false, pause = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState >= 1) video.currentTime = Math.min(t, video.duration || t);
    else pending.current = t;
    if (play) video.play?.()?.catch?.(() => {});
    else if (pause) video.pause?.();
  };
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n) return;
    applied.current = seekRequest.n;
    const t = seekRequest.t - source.startSec;
    if (t >= 0 && (source.endSec == null || t <= source.endSec - source.startSec)) seekTo(t, !!seekRequest.play, !!seekRequest.pause);
  }, [seekRequest, source.startSec, source.endSec]);
  const startSec = source.startSec || 0;
  const range = { startSec, endSec: source.endSec ?? null };
  const songTime = startSec + time;
  const shotStep = shotSteps(scenes, songTime, range);
  const shot = shotStep.index;
  const activeShot = shotStep.scene;
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
        data-preview-picture
        ref={videoRef}
        src={source.src}
        controls
        playsInline
        preload="metadata"
        data-song-clock={startSec}
        data-song-end={source.endSec ?? undefined}
        onLoadedMetadata={() => { if (pending.current != null) { seekTo(pending.current); pending.current = null; } }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedData={(e) => setDuration(e.currentTarget.duration)}
        aria-label={source.id === 'final' ? 'Final render preview' : 'Draft excerpt preview'}
        className="mx-auto block aspect-video w-full max-w-[calc(50vh*16/9)] rounded border border-port-border bg-black object-contain"
      />
      <div data-preview-controls className="space-y-2">
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
          label={[projectName, activeShot ? sceneShotName(activeShot, { number: shot }) : null].filter(Boolean).join(' · ')}
          keys
        />
      </div>
    </div>
  );
}

// Rebuild the drawing data when its inputs change; switching sources alone does not ask again.
function useDocumentPlayback(project) {
  const directory = (project.composition?.mode === 'document' && project.composition?.document?.directory) || '';
  const target = `${project.id}|${directory}`;
  const revision = hashString(JSON.stringify([directory, project.composition, project.scenes, project.audioAnalysis,
    project.lyricCues, project.lyricMarkers, project.titleCard, project.lyricOverlayEnabled, project.productionReview, project.cameras, project.colorMatch, project.treatment, project.templateEffects]));
  const [playback, setPlayback] = useState(null);
  useEffect(() => {
    if (!directory) { setPlayback(null); return undefined; }
    let active = true;
    // A drawing edit keeps the audio/player mounted while its new data arrives.
    setPlayback(previous => previous?.target === target ? previous : null);
    getMusicVideoCompositionPlayback(project.id, { silent: true })
      .then((result) => { if (active) setPlayback({ target, native: result?.native === true, data: result?.data, reason: result?.reason, file: result?.file }); })
      .catch(() => { if (active) setPlayback({ target, native: false }); });
    return () => { active = false; };
  }, [project.id, directory, target, revision]);
  return playback?.target === target ? playback : null;
}

/**
 * The live composition document. The unmodified shipped template has no
 * authored code, so its scenes play in this browser (smooth on a phone) and
 * the isolated worker only draws paused frames. Any other document, and any
 * the server cannot vouch for, plays in the worker as before. Nothing mounts
 * until the server has answered, so the worker is not started just to be dropped.
 */
function DocumentPreview({ project, playback, audioUrl, seekRequest, collapsed, onEditShot, onProject }) {
  if (!playback) return <p className={`text-xs text-port-text-muted ${collapsed ? 'max-xl:hidden' : ''}`}>Loading the composition…</p>;
  return playback.native && (playback.data || !hasTemplateBeatReaction(project))
    ? <StoryboardAnimatic project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} variant="document" nativeData={playback.data} />
    : <div className={collapsed ? 'max-xl:hidden' : ''}><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} shotNav onEditShot={onEditShot} onProject={onProject} /></div>;
}

/**
 * The docked preview card, on every watched step (not Story, Plan or Assets). `MusicVideoLayout` places it: a
 * right-hand column from `xl` up; below it, a folded row above the step that
 * opens into the player. `sources` is `listPreviewSources(…)`; the picked one is the
 * `?play=` param, defaulting to the first playable source (final render, then
 * the live composition, then the newest draft, then the storyboard animatic).
 * A source the current render style cannot play stays in the picker, disabled,
 * with its reason. With nothing to play yet it says what makes something
 * playable. `seekRequest` (`{ t, n }`) is the scene-card seek. `blender` is a
 * Blender film's `useMusicVideoBlender` reading: its live composite plays the
 * shots' renders from that state, so a render that lands shows without a reload.
 * `clockRef` reads the playing source's time and coverage on the song.
 * `compact` drops the title for a page that frames the player itself (the editor).
 * `controlsBeside` keeps the play bar under the picture and stacks the other
 * controls in a column to its right, for a short, wide space (the editor). Each
 * player marks its picture (`data-preview-picture`), its play bar
 * (`data-preview-scrub`) and its other controls (`data-preview-controls`);
 * `.mv-preview-beside` in PreviewDock.css places them.
 */
export default function PreviewDock({ project, sources, audioUrl, seekRequest, collapsed, onToggleCollapsed, expanded = false, onToggleExpanded, onEditShot = null, onProject = null, blender = null, clockRef = null, compact = false, controlsBeside = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('play');
  const playable = sources.filter((entry) => !entry.disabled);
  const source = playable.find((entry) => entry.id === requested) || playable[0] || null;
  const pick = (id) => {
    if (!playable.some((entry) => entry.id === id)) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === playable[0].id) next.delete('play');
      else next.set('play', id);
      return next;
    }, { replace: true });
  };
  // The folded row sits in the page, so it opens downward.
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const SizeIcon = expanded ? Minimize2 : Maximize2;
  const pickerId = `mv-preview-source-${project.id}`;
  const documentPlayback = useDocumentPlayback(project);
  const film = project.composition?.mode === 'blender';
  // Whatever source plays here takes turns with any other player on the step that plays the song
  // (the Blender film panel's shot player). Muted media (a shot's clip under the song) has no say.
  const dockRef = useRef(null);
  // The timeline's audio layers and the shots' clip sound play over the song live; a render already has them mixed in.
  const previewSounds = usePreviewSounds(project);
  useAudioLayerPlayback(dockRef, previewSounds, !!source && source.kind !== 'video');
  const solo = useSoloPlayback(() => {
    for (const media of dockRef.current?.querySelectorAll('audio, video') || []) if (!media.muted) media.pause();
  });
  const sounding = (handler) => (event) => { if (!event.target.muted) handler(); };
  // A cold open or edits since rendering can leave a final's song offset unknown.
  const unknownSongOffset = source?.id === 'final'
    && (project.renderDependencyState?.status === 'stale' || coldOpenScenes(project).length > 0);
  // Each player marks the media element that keeps the song's time (`data-song-clock`, its offset on
  // the song), so a reader outside the dock follows whichever source is playing without a re-render.
  useEffect(() => {
    if (!clockRef) return undefined;
    clockRef.current = () => {
      const media = dockRef.current?.querySelector('[data-song-clock]');
      if (!media) return null;
      const start = Number(media.dataset.songClock) || 0;
      const mediaEnd = Number.isFinite(media.duration) ? start + media.duration : Infinity;
      const end = Math.min(mediaEnd, media.dataset.songEnd == null ? Infinity : Number(media.dataset.songEnd));
      return { t: media.currentTime + start, playing: !media.paused && !media.ended, ended: media.ended, start, end, unknownSongOffset };
    };
    return () => { clockRef.current = null; };
  }, [clockRef, unknownSongOffset]);
  return (
    // A flex gap, not space-y: space-y puts a margin under the header row even
    // when everything after it is hidden, so the folded dock sat off-center.
    <aside ref={dockRef} aria-label="Preview" className={`@container/mv-preview flex min-w-0 flex-col gap-2 rounded-lg border border-port-border bg-port-card p-2 ${controlsBeside ? 'mv-preview-beside' : ''}`}
      onPlayCapture={sounding(solo.started)} onPauseCapture={sounding(solo.stopped)} onEndedCapture={sounding(solo.stopped)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-text-muted">
        {/* Compact (the editor): no title row of its own, the source picker is the header. */}
        {!compact && <MonitorPlay size={14} className="shrink-0 text-port-accent" aria-hidden="true" />}
        {!compact && <span className="text-sm font-medium text-port-text">Preview</span>}
        {sources.length > 1 ? (
          <>
            <label htmlFor={pickerId} className="sr-only">Preview source</label>
            <select
              id={pickerId}
              value={source?.id || ''}
              onChange={(e) => pick(e.target.value)}
              className={`${compact ? 'flex-1' : 'order-last basis-full @min-[32rem]/mv-preview:order-none @min-[32rem]/mv-preview:basis-auto @min-[32rem]/mv-preview:flex-1'} min-h-[44px] min-w-0 truncate rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-port-text pointer-fine:sm:min-h-[28px]`}
            >
              {sources.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={!!entry.disabled}>
                  {entry.disabled ? `${entry.label} — ${entry.reason}` : entry.label}
                </option>
              ))}
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
          {sources.filter((entry) => entry.disabled).map((entry) => (
            <span key={entry.id} className="mt-1 block">{entry.label}: {entry.reason}</span>
          ))}
        </p>
      )}
      {/* Folded below xl, the dock is one row: the player and its controls wait for the expand. */}
      {source?.kind === 'document' && <DocumentPreview project={project} playback={documentPlayback} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} onProject={onProject} />}
      {source?.kind === 'composite' && (film && !blender?.state ? (
        // The film's renders are not on the project record: the player waits for its state rather than call every shot unrendered.
        <p role="status" className={`text-xs text-port-text-muted ${collapsed ? 'max-xl:hidden' : ''}`}>
          {blender?.status === 'error' ? 'The Blender film could not be loaded. Retry it in Blender film on Shots.' : 'Loading the Blender film…'}
        </p>
      ) : (
        <>
          <StoryboardAnimatic project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} variant="composite" blender={film ? blender.state : null} />
          {/* A Blender film's shots render from its scripts, not as clip takes. */}
          {!film && <DraftCoverageNote project={project} collapsed={collapsed} onEditShot={onEditShot} />}
        </>
      ))}
      {source?.kind === 'lyrics' && <div className={collapsed ? 'max-xl:hidden' : ''}><CompositionPreviewPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} lyrics shotNav onEditShot={onEditShot} /></div>}
      {source?.kind === 'animatic' && <StoryboardAnimatic project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} />}
      {source?.kind === 'previz' && <Suspense fallback={<p className="text-xs text-port-text-muted">Loading the greybox previz…</p>}>
        <PrevizPlayer project={project} audioUrl={audioUrl} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} />
      </Suspense>}
      {source?.kind === 'video' && <VideoPreview key={source.id} source={source} scenes={project.scenes} projectName={project.name} seekRequest={seekRequest} collapsed={collapsed} onEditShot={onEditShot} />}
    </aside>
  );
}
