import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PrevizCanvas from './PrevizCanvas.jsx';
import ShotStepper, { shotNumbers } from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';
import useMusicVideoGreyboxPlaces from '../../hooks/useMusicVideoGreyboxPlaces.js';
import { previzFrameAt, previzPlaceGreybox } from '../../../../server/lib/musicVideoPreviz.js';
import { aspectRatio } from '../../lib/greybox';
import { sceneShotName } from '../../lib/musicVideoStages.js';

const latestModel = (media = []) => media.filter((row) => row.kind === 'model' && !row.deleted)
  .reduce((latest, row) => (!latest || (row.createdAt || '') > (latest.createdAt || '') ? row : latest), null);

const PREVIZ_FPS = 24;

/**
 * The song over the live Three.js greybox previz: as the song reaches each cut,
 * its set's greybox is drawn through the cut's camera with its people at their
 * marks, every animation frame while it plays. Nothing is rendered to a file,
 * so blocking edits show on the next play. `seekRequest` (`{ t, n }`) is the
 * shot-card seek the other preview sources honour.
 */
export default function PrevizPlayer({ project, audioUrl, seekRequest, collapsed, onEditShot = null }) {
  const audioRef = useRef(null);
  const labelPortal = useRef(null);
  const applied = useRef(null);
  const [time, setTime] = useState(0);
  const places = useMusicVideoGreyboxPlaces(project);
  const scenes = project.scenes || [];

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    let handle = 0;
    const tick = () => { setTime(audio.currentTime || 0); handle = requestAnimationFrame(tick); };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); setTime(audio.currentTime || 0); };
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    return () => {
      cancelAnimationFrame(handle);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, []);
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n || !audioRef.current) return;
    applied.current = seekRequest.n;
    audioRef.current.currentTime = seekRequest.t;
    setTime(seekRequest.t);
    if (seekRequest.play) audioRef.current.play?.()?.catch?.(() => {});
  }, [seekRequest]);
  const seekTo = useCallback((t) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    setTime(t);
  }, []);
  const stepFrame = useCallback((t) => { audioRef.current?.pause?.(); seekTo(t); }, [seekTo]);

  const frame = useMemo(() => previzFrameAt(project, places, time), [project, places, time]);
  const shot = frame?.cut.sceneId ? scenes.find((scene) => scene.sceneId === frame.cut.sceneId) : null;
  const number = shot ? shotNumbers(scenes).get(shot.sceneId) : null;
  const placeName = frame?.cut.placeSubjectId ? (project.concept?.subjects || []).find((s) => s.id === frame.cut.placeSubjectId)?.name : null;
  const ingredientId = frame?.cut.placeSubjectId ? (project.concept?.subjects || []).find((s) => s.id === frame.cut.placeSubjectId)?.ingredientId : null;
  const model = ingredientId ? latestModel(places[ingredientId]?.media) : null;
  const loading = ingredientId && places[ingredientId] === undefined;
  const ratio = aspectRatio(frame?.camera.aspect || '16:9');
  const empty = !frame ? 'No previz cut here'
    : !frame.cut.placeSubjectId ? 'This cut has no set; pick one on the Previz step'
      : loading ? 'Loading the set…'
        : !previzPlaceGreybox(project, frame.cut.placeSubjectId, places) ? `${placeName || 'This set'} has no greybox yet` : null;
  const label = [project.name, shot ? sceneShotName(shot, { number }) : null].filter(Boolean).join(' · ');

  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      <div
        ref={labelPortal}
        data-testid="previz-player"
        className="relative mx-auto w-full max-w-[calc(50vh*16/9)] overflow-hidden rounded border border-port-border bg-black"
        style={{ aspectRatio: ratio }}
      >
        {empty
          ? <p className="flex h-full items-center justify-center p-4 text-center text-xs text-port-text-muted">{empty}</p>
          : <PrevizCanvas frame={frame} modelSrc={model ? `/data/models/${encodeURIComponent(model.mediaKey)}` : null} labelPortal={labelPortal} />}
        {frame && <p className="port-media-overlay-strong pointer-events-none absolute left-1 top-1 max-w-[90%] truncate rounded px-1 text-[10px]">
          {[placeName, frame.actors.find((a) => a.holder)?.name ? `held by ${frame.actors.find((a) => a.holder).name}` : null].filter(Boolean).join(' · ')}
        </p>}
      </div>
      <ShotStepper scenes={scenes} time={time} onSeek={seekTo} onEditShot={onEditShot ? (sceneId) => { audioRef.current?.pause?.(); onEditShot(sceneId); } : null} keys />
      <FrameStepper time={time} fps={PREVIZ_FPS} maxSec={Number(project.audioAnalysis?.durationSec) || null} onSeek={stepFrame} label={label} keys />
      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        preload="metadata"
        aria-label="Song for the greybox previz"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        className="w-full"
      />
    </div>
  );
}
