import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { normalizeTitleCard } from '../../../../server/lib/musicVideoTitleCard.js';
import useGeneratedPreview from '../../hooks/useGeneratedPreview.js';
import ShotStepper, { shotSteps } from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

// What the lyric playthrough page is built from: the song length, the word times,
// the sheet's sections and the shots' timing and text zones. A change rebuilds it.
export const playthroughVersion = (project) => JSON.stringify([
  project.audioAnalysis?.durationSec ?? null,
  (project.lyricCues || []).map((cue) => [cue.text, cue.startSec, cue.endSec, (cue.words || []).map((w) => [w.startSec, w.endSec])]),
  (project.lyricMarkers || []).map((m) => [m.type, m.label, m.line]),
  (project.scenes || []).map((s) => [s.startSec, s.endSec, s.textZone, s.lyricRole]),
]);

/** The lyric line sung at song time `t`, from the project's timed cues. */
const lyricAt = (cues, t) => {
  const line = (cues || []).find((cue) => typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && t >= cue.startSec && t < cue.endSec);
  return line?.text || '';
};

// A phone's collapsed mini-player has no picture to show, so it must not start
// the isolated renderer up front. Without matchMedia, load eagerly.
const DESKTOP_QUERY = '(min-width: 1024px)';
const startsDeferred = (collapsed) => collapsed && window.matchMedia?.(DESKTOP_QUERY).matches === false;

/**
 * Live preview of a composition document or lyric playthrough. The generated
 * page runs in the OS-isolated preview worker. This component shows JPEG
 * frames only — it does not fetch private media and it does not mount an iframe.
 *
 * `seekRequest` (`{ t, n }`) moves the player from outside. `collapsed` hides
 * the picture below `lg` until the dock is expanded or the viewport is desktop.
 * `lyrics` previews timed lyrics instead of the document. `draft` previews the
 * candidate document. `shotNav` adds Back and Next shot buttons (and the arrow
 * keys) and frame-by-frame stepping for the docked player.
 */
export default function CompositionPreviewPlayer({ project, audioUrl, seekRequest = null, collapsed = false, draft = false, lyrics = false, shotNav = false, scrubId: givenScrubId = null }) {
  const doc = lyrics ? { playthrough: true } : (draft ? project.composition?.documentDraft : project.composition?.document) || null;
  const scrubId = givenScrubId || (lyrics ? 'mv-lyrics-scrub' : draft ? 'mv-doc-draft-scrub' : 'mv-doc-scrub');
  const [wanted, setWanted] = useState(() => !startsDeferred(collapsed));
  useEffect(() => {
    if (!collapsed) { setWanted(true); return undefined; }
    const desktop = window.matchMedia?.(DESKTOP_QUERY);
    const reveal = () => { if (!desktop || desktop.matches) setWanted(true); };
    reveal();
    desktop?.addEventListener?.('change', reveal);
    return () => desktop?.removeEventListener?.('change', reveal);
  }, [collapsed]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const wasPlaying = useRef(false);
  const appliedSeek = useRef(null);
  const filmLook = lyrics ? null : (project.filmLook ?? null);
  const titleCard = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  const revision = lyrics ? playthroughVersion(project) : doc ? `${doc.directory}|${doc.updatedAt || ''}` : null;
  const request = useMemo(() => {
    if (!wanted || !revision || !doc) return null;
    return {
      kind: 'music-video', projectId: project.id, draft: !!draft, lyrics: !!lyrics, revision,
    };
  }, [wanted, revision, doc, project.id, draft, lyrics]);
  const controls = useMemo(() => ({ look: filmLook, card: titleCard }), [filmLook, titleCard]);
  const preview = useGeneratedPreview({ active: !!request, request, controls });

  const duration = preview.durationSec || 0;
  const fps = preview.fps || 24;
  const seek = useCallback((time) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    setT(next);
    preview.seek(next);
    if (audioRef.current && Math.abs((audioRef.current.currentTime || 0) - next) > 0.05) audioRef.current.currentTime = next;
  }, [duration, fps, preview.seek]);

  useEffect(() => {
    if (!seekRequest || duration <= 0 || appliedSeek.current === seekRequest.n) return;
    appliedSeek.current = seekRequest.n;
    seek(seekRequest.t);
    if (seekRequest.play && audioRef.current) { audioRef.current.play?.()?.catch?.(() => {}); setPlaying(true); }
    else { audioRef.current?.pause?.(); setPlaying(false); }
  }, [seekRequest, duration, seek]);

  useEffect(() => {
    if (!playing) return undefined;
    let handle = 0;
    let posted = -1;
    const tick = () => {
      const time = audioRef.current?.currentTime || 0;
      const frameIndex = Math.floor(time * fps + 1e-9);
      if (frameIndex !== posted) { posted = frameIndex; setT(time); preview.seek(time, { playing: true }); }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, fps, preview.seek]);

  // Pause/end repaints the current frame with the exact render filter.
  useEffect(() => {
    if (wasPlaying.current && !playing && preview.ready) seek(audioRef.current?.currentTime || 0);
    wasPlaying.current = playing;
  }, [playing, preview.ready, seek]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); return; }
    audio.play?.()?.catch?.(() => {});
    setPlaying(true);
  };

  if (!doc) return null;
  const title = lyrics ? 'Lyric timing playthrough' : draft ? 'Composition candidate preview' : 'Composition document preview';
  const aspect = preview.width && preview.height ? `${preview.width} / ${preview.height}` : '16 / 9';
  const lyric = lyricAt(project.lyricCues, t);
  const shotIndex = shotNav ? shotSteps(project.scenes, t).index : 0;
  const failed = preview.status === 'error' || preview.status === 'unavailable';
  const timeLabel = failed
    ? 'Preview unavailable'
    : preview.ready
      ? `${t.toFixed(2)}s / ${duration.toFixed(1)}s`
      : !wanted ? 'Expand to load preview' : 'Loading preview…';
  return (
    <div className="space-y-2" aria-label={lyrics ? 'Lyric timing playthrough' : 'Composition preview'}>
      {failed && <p className="text-xs text-port-error" role="alert">{preview.reason || 'Preview unavailable'}</p>}
      <div title={title} className={`overflow-hidden rounded border border-port-border bg-black mx-auto ${collapsed ? 'max-xl:hidden' : ''}`}
        style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
        {preview.frameUrl ? (
          <img alt="" src={preview.frameUrl} className="h-full w-full object-contain" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{failed ? '' : wanted ? 'Building the preview…' : ''}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview.ready || !audioUrl || (failed && !playing)}>
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={scrubId} className="sr-only">{lyrics ? 'Scrub the lyric playthrough' : draft ? 'Scrub the composition candidate' : 'Scrub the composition preview'}</label>
        <input disabled={!preview.ready || failed} id={scrubId} type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
          onChange={(e) => { audioRef.current?.pause(); setPlaying(false); seek(Number(e.target.value)); }}
          className="min-w-0 flex-1" />
        <span className="text-xs text-port-text-muted tabular-nums">{timeLabel}</span>
      </div>
      {shotNav && <ShotStepper scenes={project.scenes} time={t} onSeek={seek} disabled={!preview.ready || failed} keys />}
      {shotNav && (
        <FrameStepper
          time={t}
          fps={fps}
          maxSec={duration || null}
          onSeek={(time) => { audioRef.current?.pause?.(); setPlaying(false); seek(time); }}
          disabled={!preview.ready || failed}
          capture={() => (preview.frameUrl ? fetch(preview.frameUrl).then((res) => res.blob()) : Promise.resolve(null))}
          label={[project.name, shotIndex ? `Shot ${shotIndex}` : null].filter(Boolean).join(' · ')}
          keys
        />
      )}
      {lyric && !lyrics && <p className="text-xs italic break-words" aria-live="off" data-testid="preview-lyric">♪ {lyric}</p>}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => setPlaying(false)} />}
    </div>
  );
}
