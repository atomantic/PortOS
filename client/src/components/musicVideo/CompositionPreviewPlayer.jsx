import { compactButtonClass as buttonCls } from './controlClasses.js';
import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import useMounted from '../../hooks/useMounted.js';
import ShotStepper, { shotNumbers, shotSteps } from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';
import PreviewFilmLook from './PreviewFilmLook.jsx';
import toast from '../ui/Toast';
import { upgradeMusicVideoCompositionEngine } from '../../services/apiMusicVideo.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import usePreviewPlaybackEngine from './usePreviewPlaybackEngine.js';
import useCompositionPreview from './useCompositionPreview.js';

export { playthroughVersion, documentPreviewRevision, documentPreviewLook } from './useCompositionPreview.js';

/** The lyric line sung at song time `t`, from the project's timed cues. */
const lyricAt = (cues, t) => {
  const line = (cues || []).find((cue) => typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && t >= cue.startSec && t < cue.endSec);
  return line?.text || '';
};

// Why the server plays this document by exact per-frame seeks instead of smooth native playback.
const FALLBACK_REASONS = {
  'unrecognized-engine': 'its engine was customized',
  'custom-helper': 'a helper file differs from the shipped one',
  'custom-font': 'a font file differs from the shipped one',
  'missing-helper': 'a helper file is missing',
  'unsupported-video-fps': 'a clip has an unknown or very low frame rate',
  'unsupported-capture-protocol': 'the preview browser is too old',
  'unsupported-frame-callbacks': 'the preview browser is too old',
};
export const playbackFallbackSummary = (fallback) => {
  if (!fallback) return '';
  const why = fallback.upgradable ? (fallback.file ? 'this document carries an older shipped file' : 'this document uses an older layered engine') : FALLBACK_REASONS[fallback.reason] || 'the document was customized';
  return `Playing frame by frame, so motion is choppy: ${why}${fallback.file ? ` (${fallback.file})` : ''}.`;
};

const EFFECT_LABELS = { transition: 'glitch transitions', glitch: 'in-shot glitches', end: 'end-frame effects' };
const SHOTS_SHOWN = 6;

/** "glitch transitions (shots 3, 7), end-frame effects (shot 12)" from the preview's unsupported list. */
export function unsupportedEffectsSummary(unsupported, scenes) {
  const numbers = shotNumbers(scenes);
  return Object.entries(EFFECT_LABELS).map(([kind, label]) => {
    const entries = unsupported.filter((entry) => entry.effects?.includes(kind));
    if (!entries.length) return null;
    // A cold-open shot has no number on the song clock.
    const shots = entries.map((entry) => numbers.get(entry.sceneId)).filter(Boolean).sort((a, b) => a - b);
    if (!shots.length) return label;
    const listed = shots.slice(0, SHOTS_SHOWN).join(', ');
    const more = shots.length > SHOTS_SHOWN ? ` +${shots.length - SHOTS_SHOWN} more` : '';
    return `${label} (${shots.length === 1 ? 'shot' : 'shots'} ${listed}${more})`;
  }).filter(Boolean).join(', ');
}

function PreviewStatus({ preview, audioError, failed, unsupported, project, draft, onProject, upgrading,
  upgradeEngine }) {
  return (
    <>
      {failed && <p className="text-xs text-port-error" role="alert">{audioError || preview.reason || 'Preview unavailable'}</p>}
      {preview.playbackReason && <p className="text-xs text-port-text-muted" role="status">{preview.playbackReason}</p>}
      {preview.ready && preview.playbackFallback && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted" role="status">
          <span className="min-w-0 break-words">{playbackFallbackSummary(preview.playbackFallback)}</span>
          {preview.playbackFallback.upgradable && unsupported.length === 0 && onProject && !draft && (
            <button type="button" className={buttonCls} disabled={upgrading || !!project.composition?.documentDraft} onClick={upgradeEngine}>
              {upgrading ? 'Updating…' : 'Update layered engine'}
            </button>
          )}
        </div>
      )}
      {unsupported.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning" role="status">
          <span className="min-w-0 break-words">Playing without effects this engine can't draw: {unsupportedEffectsSummary(unsupported, project.scenes)}.</span>
          {onProject && !draft && (
            <button type="button" className={buttonCls} disabled={upgrading || !!project.composition?.documentDraft} onClick={upgradeEngine}>
              {upgrading ? 'Updating…' : 'Update layered engine'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function PlaybackControls({ playback, preview, audioUrl, request, failed, scrubId, lyrics, draft, timeLabel, lookAvailable, lookOn, toggleLook }) {
  const { retryPreview, playing, preparing, togglePlay, duration, fps, t, stopPlayback } = playback;
  return (
    <div data-preview-scrub className="flex flex-wrap items-center gap-2">
      {request && (preview.status === 'idle' || failed) && <button type="button" className={buttonCls} onClick={retryPreview}>{failed ? 'Retry preview' : 'Resume preview'}</button>}
      <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview.ready || !audioUrl || (failed && !playing)}>
        {playing || preparing ? <Pause size={14} /> : <Play size={14} />} {playing || preparing ? 'Pause' : 'Play'}
      </button>
      <label htmlFor={scrubId} className="sr-only">{lyrics ? 'Scrub the lyric playthrough' : draft ? 'Scrub the composition candidate' : 'Scrub the composition preview'}</label>
      <input disabled={!preview.ready || failed} id={scrubId} type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
        onChange={(e) => stopPlayback(Number(e.target.value))}
        className="min-w-0 flex-1" />
      <span className="text-xs text-port-text-muted tabular-nums">{timeLabel}</span>
      {lookAvailable && <PreviewFilmLook enabled={lookOn} onToggle={toggleLook} />}
    </div>
  );
}

function PreviewShotControls({ project, shotNav, onEditShot, preview, playback, failed, lyrics }) {
  const { t, fps, duration, playing, seek, stopPlayback } = playback;
  const lyric = lyricAt(project.lyricCues, t);
  // Fallback frames trail the audio clock; while playing, name the shot pictured.
  const shownT = playing && !preview.playback && preview.frameTime != null ? preview.frameTime : t;
  const shotStep = shotNav ? shotSteps(project.scenes, shownT) : null;
  const shotIndex = shotStep?.index || 0;
  const activeShot = shotStep?.scene || null;
  return (
    <div data-preview-controls className="space-y-2 empty:hidden">
      {shotNav && <ShotStepper scenes={project.scenes} time={shownT} onSeek={seek} onEditShot={onEditShot ? (sceneId) => { stopPlayback(); onEditShot(sceneId); } : null} disabled={!preview.ready || failed} keys />}
      {shotNav && (
        <FrameStepper
          time={t}
          fps={fps}
          maxSec={duration || null}
          onSeek={stopPlayback}
          disabled={!preview.ready || failed}
          capture={preview.captureFrame}
          label={[project.name, activeShot ? sceneShotName(activeShot, { number: shotIndex }) : null].filter(Boolean).join(' · ')}
          keys
        />
      )}
      {lyric && !lyrics && <p className="text-xs italic break-words" aria-live="off" data-testid="preview-lyric">♪ {lyric}</p>}
    </div>
  );
}

/**
 * Live preview of a composition document or lyric playthrough. The generated
 * page runs in the OS-isolated preview worker. This component shows JPEG
 * frames only — it does not fetch private media and it does not mount an iframe.
 *
 * `seekRequest` (`{ t, n }`) moves the player from outside. `collapsed` hides
 * the picture below `lg` until the dock is expanded or the viewport is desktop.
 * `lyrics` previews timed lyrics instead of the document. `draft` previews the
 * candidate document. `shotNav` adds Back and Next shot buttons (and the arrow
 * keys) and frame-by-frame stepping for the docked player; `onEditShot(sceneId)`
 * there adds Edit shot, which pauses first. When the document's engine predates
 * selected shot effects, the preview plays without them and names those shots;
 * `onProject(project)` there adds a one-tap engine update.
 */
export default function CompositionPreviewPlayer({ project, audioUrl, seekRequest, collapsed, draft = false, lyrics = false, shotNav, onEditShot, onProject, scrubId: givenScrubId }) {
  const scrubId = givenScrubId || (lyrics ? 'mv-lyrics-scrub' : draft ? 'mv-doc-draft-scrub' : 'mv-doc-scrub');
  const mounted = useMounted();
  const [upgrading, setUpgrading] = useState(false);
  const { doc, wanted, request, preview, lookOn, toggleLook, lookAvailable } = useCompositionPreview({
    project, lyrics, draft, collapsed,
  });
  const playback = usePreviewPlaybackEngine({ preview, audioUrl, seekRequest, mounted });
  const { t, duration, audioError, stopPlayback, audioRef, handleAudioError } = playback;
  const upgradeEngine = async () => {
    setUpgrading(true);
    const result = await upgradeMusicVideoCompositionEngine(project.id, doc.directory, { silent: true })
      .catch((error) => { toast.error(error?.message || 'The layered engine could not be updated'); return null; });
    if (mounted.current) setUpgrading(false);
    if (!result) return;
    if (result.project) onProject(result.project);
    const custom = result.customHelpers?.length ? ` — kept customized ${result.customHelpers.join(', ')}` : '';
    toast.success(`${result.changed ? 'Layered engine updated' : 'Layered engine is already current'}${custom}`);
  };

  if (!doc) return null;
  const unsupported = lyrics ? [] : preview.unsupportedEffects || [];
  const title = lyrics ? 'Lyric timing playthrough' : draft ? 'Composition candidate preview' : 'Composition document preview';
  const aspect = preview.width && preview.height ? `${preview.width} / ${preview.height}` : '16 / 9';
  const failed = preview.status === 'error' || preview.status === 'unavailable' || !!audioError;
  const timeLabel = failed
    ? 'Preview unavailable'
    : preview.ready
      ? `${t.toFixed(2)}s / ${duration.toFixed(1)}s`
      : !wanted ? 'Expand to load preview' : preview.status === 'idle' ? 'Preview paused' : 'Loading preview…';
  return (
    <div className="space-y-2" aria-label={lyrics ? 'Lyric timing playthrough' : 'Composition preview'}>
      <PreviewStatus preview={preview} audioError={audioError} failed={failed} unsupported={unsupported}
        project={project} draft={draft} onProject={onProject} upgrading={upgrading}
        upgradeEngine={upgradeEngine} />
      <div title={title} data-preview-picture className={`overflow-hidden rounded border border-port-border bg-black mx-auto ${collapsed ? 'max-xl:hidden' : ''}`}
        style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
        {preview.frameUrl ? (
          <img ref={preview.imageRef} onLoad={preview.onFrameLoad} alt="" src={preview.frameUrl} className="h-full w-full object-contain" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{failed ? '' : wanted ? 'Building the preview…' : ''}</p>
        )}
      </div>
      <PlaybackControls playback={playback} preview={preview} audioUrl={audioUrl} request={request} failed={failed} scrubId={scrubId}
        lyrics={lyrics} draft={draft} timeLabel={timeLabel} lookAvailable={lookAvailable} lookOn={lookOn} toggleLook={toggleLook} />
      <PreviewShotControls project={project} shotNav={shotNav} onEditShot={onEditShot} preview={preview} playback={playback}
        failed={failed} lyrics={lyrics} />
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" data-song-clock="0" className="hidden" onError={handleAudioError}
        onEnded={(event) => stopPlayback(event.currentTarget.currentTime, { ended: true })} />}
    </div>
  );
}
