import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import ShotColorMatchFrame from './ShotColorMatchFrame.jsx';
import { musicVideoBlenderMediaUrl } from '../../services/apiMusicVideo.js';
import { cameraFrameCss, musicVideoOverscan, shotCamera, shotFilmLook } from '../../../../server/lib/musicVideo/musicVideoFilmLook.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import EndingCanvas from './EndingCanvas.jsx';
import PreviewVideo from './PreviewVideo.jsx';
import { sceneFrameFit } from './SceneFrameFit.jsx';
import TransitionGlitch from './TransitionGlitch.jsx';
import WipeOverlay from './WipeOverlay.jsx';
import ExactDocumentFrame from './ExactDocumentFrame.jsx';
import { DocumentFootageMove, DocumentTemplateFinish } from './DocumentTemplateLayers.jsx';
import DocumentTemplateCanvas from './DocumentTemplateCanvas.jsx';
import ImageEffectStill from './ImageEffectStill.jsx';
import { shotImageUrl } from './sceneImageTreatmentUrls.js';
import { clipOffsetSec, clipReversed, clipSpeedRate, isSelfDrawnLayer, sceneVisualLayer, stillFrameTransform } from '../../lib/musicVideoLayers.js';
import { sceneImageEffect, scenePhotoSequence } from '../../../../server/lib/musicVideo/musicVideoImageEffects.js';
import { ANIMATIC_FPS, clipTimeAt, playedScene, releaseVideo, useSongFrames } from './animaticTiming.js';

// How far a playing shot's clip may drift from the song before it is put back in step.
// Paused (frame stepping, scrubbing), the clip must show the exact frame, so any gap
// wider than a fraction of a frame re-seeks it.
const CLIP_DRIFT_SEC = 0.25;
const CLIP_PAUSED_DRIFT_SEC = 0.01;
// A clip still fetching after a seek gets this long before it is moved again: each seek
// restarts its download, so on a slow phone link re-seeking on every time update never lets
// it catch up.
const CLIP_RESEEK_WAIT_MS = 1500;
// A clip that fails to load is tried again this many times, a little later each time.
const CLIP_LOAD_RETRIES = 2;
const CLIP_RETRY_MS = 1500;
// A playing shot's clip whose download stalls is restarted at most this often.
const CLIP_STALL_RELOAD_MS = 5000;

/**
 * A shot's selected video clip, muted under the master song and kept in step
 * with it while its shot is `current`.
 */
function ShotClip({ scene, audioRef, time, current, preload = 'auto', src: given = null }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  // -Infinity: no seek or restart yet, so the first one is never held back.
  const recovery = useRef({ errors: 0, timer: 0, lastSeekAt: -Infinity, lastReloadAt: -Infinity });
  const file = useVideoFileSrc(given ? null : scene.videoHistoryId);
  const src = given || file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`);
  const sync = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || video.readyState < 1) return;
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const target = clipTimeAt(scene, current ? audio.currentTime || 0 : scene.startSec || 0, duration);
    // A browser cannot play a clip backwards, so a reversed clip stays paused and is stepped to each frame.
    const reversed = clipReversed(scene);
    const tolerance = current && (audio.paused || reversed) ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    const fetching = current && !audio.paused && !reversed && video.readyState < 3
      && performance.now() - recovery.current.lastSeekAt < CLIP_RESEEK_WAIT_MS;
    const settling = video.seeking || fetching;
    if (Math.abs((video.currentTime || 0) - target) > tolerance && !settling) {
      video.currentTime = target;
      recovery.current.lastSeekAt = performance.now();
    }
    // The shot's hand-set speed; a negative offset's lead holds the first frame.
    video.playbackRate = clipSpeedRate(scene);
    const leading = (scene.startSec || 0) - clipOffsetSec(scene) - (selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0) > (audio.currentTime || 0);
    if (!current || audio.paused || leading || reversed) video.pause?.();
    else if (video.paused) video.play?.()?.catch?.(() => {});
  }, [scene, audioRef, current]);
  const markReady = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && !video.seeking) setReady(true);
  }, []);
  useEffect(() => { sync(); }, [time, sync]);
  useEffect(() => {
    const video = videoRef.current;
    return () => releaseVideo(video);
  }, [src, reload]);
  useEffect(() => () => clearTimeout(recovery.current.timer), []);
  const retryLoad = () => {
    const state = recovery.current;
    if (state.errors >= CLIP_LOAD_RETRIES) return;
    state.errors += 1;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { file.retry(); setReload((n) => n + 1); }, CLIP_RETRY_MS * state.errors);
  };
  const restartStalled = () => {
    const video = videoRef.current;
    const state = recovery.current;
    if (!video || !current || audioRef.current?.paused || video.readyState >= 3) return;
    if (performance.now() - state.lastReloadAt < CLIP_STALL_RELOAD_MS) return;
    state.lastReloadAt = performance.now();
    video.load?.();
  };
  const reversed = clipReversed(scene);
  useEffect(() => {
    if (!current || !reversed) return undefined;
    let handle = 0;
    const tick = () => { sync(); handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [current, reversed, sync]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    return () => { audio.removeEventListener('play', sync); audio.removeEventListener('pause', sync); };
  }, [audioRef, sync]);
  if (!src) return null;
  const fit = sceneFrameFit(scene);
  return (
    <PreviewVideo
      key={`${src}:${reload}`}
      videoRef={videoRef}
      audioRef={audioRef}
      active={current}
      src={src}
      muted
      playsInline
      preload={preload}
      onLoadedMetadata={sync}
      onLoadedData={markReady}
      onSeeked={() => { markReady(); sync(); }}
      onPlaying={markReady}
      onError={retryLoad}
      onStalled={restartStalled}
      aria-label={`Clip for ${scene.label || 'this shot'}`}
      aria-hidden={current ? undefined : true}
      data-ready={ready ? 'true' : 'false'}
      data-document-scene={scene.sceneId}
      className={`pointer-events-none absolute inset-0 h-full w-full ${fit === 'fill' ? 'object-cover' : 'object-contain'} ${fit === 'black' ? 'bg-black' : ''} ${current && ready ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

// `camera` (a composition document's move for the scene) replaces the composed render's still move.
function StillShot({ scene, projectId, audioRef, time, effect = null, fps, beats = [], startSec = scene.startSec, endSec = scene.endSec, camera = null }) {
  const ref = useRef(null);
  const imageUrl = useCallback(id => shotImageUrl(projectId, scene, id), [projectId, scene]);
  const sequence = useMemo(() => scenePhotoSequence(scene, { fps, beats }), [scene, fps, beats]);
  const getTime = useCallback(() => audioRef.current?.currentTime || 0, [audioRef]);
  const apply = useCallback((t) => {
    if (ref.current) ref.current.style.transform = camera ? camera(scene, t, false) : stillFrameTransform(scene, t, { fps, startSec, endSec });
  }, [scene, fps, startSec, endSec, camera]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return (
    <div className="h-full w-full overflow-hidden">
      <div ref={ref} data-testid="animatic-still" className="h-full w-full">
        {effect || sequence ? (
          <ImageEffectStill src={imageUrl(scene.referenceImageId)} imageUrl={imageUrl} effect={effect} sequence={sequence}
            endSrc={scene.endImageId ? imageUrl(scene.endImageId) : null}
            startSec={startSec} time={time} playing={!!audioRef.current && !audioRef.current.paused} getTime={getTime} fps={fps} />
        ) : (
          <img src={shotImageUrl(projectId, scene, scene.referenceImageId)} alt="" className="h-full w-full object-cover" />
        )}
      </div>
    </div>
  );
}

// How much of the incoming clip shows at song time `t`: on a toggle's flips, or a
// dissolve's ramp, which reaches full on the cut as the render's alpha fade does.
const incomingOpacity = (effect, t, fps) => {
  if (effect.style !== 'dissolve') return effect.incoming.some(([a, b]) => t >= a && t < b) ? 1 : 0;
  if (t < effect.windowStartSec || t >= effect.cutSec) return 0;
  return Math.min(1, (t - effect.windowStartSec) / (effect.cutSec - effect.windowStartSec + 1 / fps));
};

function ToggleClip({ scene, projectId, toggle, audioRef, time, layered, fps, beats = [] }) {
  const mediaRef = useRef(null);
  const still = sceneVisualLayer(scene, { layered }) === 'still';
  const file = useVideoFileSrc(!still ? scene.videoHistoryId || null : null);
  const src = !still && scene.videoHistoryId ? file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`) : null;
  const apply = useCallback((t) => {
    const el = mediaRef.current;
    const audio = audioRef.current;
    if (!el) return;
    const surface = el.tagName === 'VIDEO' ? el.parentElement : el;
    surface.style.opacity = String(incomingOpacity(toggle, t, fps));
    if (el.tagName !== 'VIDEO' || el.readyState < 1) return;
    const duration = Number.isFinite(el.duration) ? el.duration : null;
    const target = clipTimeAt(scene, Math.min(Math.max(t, toggle.windowStartSec), toggle.cutSec), duration, { early: true, fromSec: toggle.windowStartSec });
    const tolerance = audio?.paused ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    if (Math.abs((el.currentTime || 0) - target) > tolerance) el.currentTime = target;
    const running = !!audio && !audio.paused && t >= toggle.windowStartSec && t < toggle.cutSec;
    if (!running) el.pause?.();
    else if (el.paused) el.play?.()?.catch?.(() => {});
  }, [toggle, scene, audioRef, fps]);
  useEffect(() => { apply(time); }, [time, apply]);
  useEffect(() => {
    const el = mediaRef.current;
    return () => { if (el?.tagName === 'VIDEO') releaseVideo(el); };
  }, [src]);
  useSongFrames(audioRef, apply);
  const fit = sceneFrameFit(scene);
  const className = `pointer-events-none absolute inset-0 h-full w-full ${src && fit !== 'fill' ? 'object-contain' : 'object-cover'} ${fit === 'black' ? 'bg-black' : ''}`;
  if (src) {
    return (
      <PreviewVideo key={src} videoRef={mediaRef} audioRef={audioRef} active={time >= toggle.windowStartSec && time < toggle.cutSec}
        src={src} muted playsInline preload="auto" onLoadedMetadata={() => apply(audioRef.current?.currentTime || 0)}
        data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className} />
    );
  }
  if (!scene.referenceImageId && !scenePhotoSequence(scene)?.imageIds.length) return null;
  if (layered) {
    return (
      <div ref={mediaRef} data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className}>
        <StillShot scene={scene} projectId={projectId} audioRef={audioRef} time={time} fps={fps} beats={beats} effect={sceneImageEffect(scene, { layered })}
          startSec={toggle.windowStartSec} endSec={toggle.cutSec} />
      </div>
    );
  }
  return <img ref={mediaRef} src={shotImageUrl(projectId, scene, scene.referenceImageId)} alt="" data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className} />;
}

function FadeBlack({ fade, audioRef, time }) {
  const ref = useRef(null);
  const apply = useCallback((t) => {
    const el = ref.current;
    if (!el) return;
    const down = t >= fade.outStartSec && t < fade.cutSec ? (t - fade.outStartSec) / (fade.cutSec - fade.outStartSec) : 0;
    const up = t >= fade.cutSec && t < fade.inEndSec ? 1 - (t - fade.cutSec) / (fade.inEndSec - fade.cutSec) : 0;
    el.style.opacity = String(Math.min(1, Math.max(down, up)));
  }, [fade]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return <div ref={ref} data-testid="fade-black" style={{ opacity: 0 }} className="pointer-events-none absolute inset-0 bg-black" />;
}

function AnimaticBasePicture({ project, film, shot, filmGap, filmClip, picture, stillShot, clock, stillFps, beats, shotEffect, documentCamera, cardInFrame, label }) {
  if (film) {
    if (!shot || filmGap || filmClip) return null;
    // The shot keeps its place on the song, black as a cut shows it.
    return (
      <div className="flex h-full w-full items-center justify-center" data-testid="film-not-rendered">
        <span className="port-media-overlay-strong rounded px-2 py-1 text-xs">Not rendered yet</span>
      </div>
    );
  }
  if ((picture?.referenceImageId || scenePhotoSequence(picture)?.imageIds.length) && stillShot) {
    return (
      <ShotColorMatchFrame key={picture.sceneId} project={project} scene={picture}>
        <StillShot scene={picture} projectId={project?.id} audioRef={clock.ref} time={clock.time} fps={stillFps} beats={beats} effect={shotEffect} camera={documentCamera} />
      </ShotColorMatchFrame>
    );
  }
  if (picture?.referenceImageId) {
    const vhsEdges = !!picture.videoHistoryId && sceneFrameFit(picture) === 'vhs';
    const stillEdges = !!picture.videoHistoryId && sceneFrameFit(picture) === 'still';
    // Behind a VHS-edged clip the still stands in, blurred and faded, for the render's blur of the clip.
    return (
      <ShotColorMatchFrame project={project} scene={picture}>
        <img src={shotImageUrl(project?.id, picture, picture.referenceImageId)} alt=""
          className={`h-full w-full ${vhsEdges ? 'object-cover blur-md saturate-50 brightness-75' : stillEdges ? 'object-cover' : 'object-contain'}`} />
      </ShotColorMatchFrame>
    );
  }
  if (cardInFrame && !picture?.videoHistoryId) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-4 text-center">
        <span className="text-sm font-medium text-port-text">{label}</span>
        {shot?.visualIntent && <span className="line-clamp-3 text-xs text-port-text-muted">{shot.visualIntent}</span>}
      </div>
    );
  }
  return null;
}

function AnimaticPictures({ project, playback }) {
  const {
    film, shot, filmGap, filmClip, picture, stillShot, clock, stillFps, beats, shotEffect,
    documentCamera, lyricLayer, label, clipShots, cold, nearToggles, nearFades, scenes, allScenes,
    audioRef, time, layered,
  } = playback;
  const cardInFrame = !lyricLayer.overlay;

  return (
    <>
      <AnimaticBasePicture
        project={project} film={film} shot={shot} filmGap={filmGap} filmClip={filmClip}
        picture={picture} stillShot={stillShot} clock={clock} stillFps={stillFps} beats={beats}
        shotEffect={shotEffect} documentCamera={documentCamera} cardInFrame={cardInFrame} label={label}
      />
      {clipShots.map(({ scene, offset, clip }) => (clip ? (
        // Keyed by the render too: a shot rendered again writes the same file, and must load anew.
        <ShotClip key={`${scene.sceneId}:${clip.file}:${clip.version}`} scene={scene} src={musicVideoBlenderMediaUrl(project.id, clip.file)}
          audioRef={clock.ref} time={clock.time} current={scene.sceneId === shot?.sceneId && !filmGap} preload={offset <= 1 ? 'auto' : 'metadata'} />
      ) : (
        <ShotColorMatchFrame key={`${cold.active ? 'cold:' : ''}${scene.sceneId}:${scene.videoHistoryId}`} project={project} scene={scene} className="pointer-events-none absolute inset-0 h-full w-full">
          {documentCamera ? (
            <DocumentFootageMove scene={scene} camera={documentCamera} audioRef={clock.ref} time={clock.time}>
              <ShotClip scene={scene} audioRef={clock.ref} time={clock.time} current={scene.sceneId === shot?.sceneId}
                preload={offset <= 1 ? 'auto' : 'metadata'} />
            </DocumentFootageMove>
          ) : (
            <ShotClip scene={scene} audioRef={clock.ref} time={clock.time} current={scene.sceneId === shot?.sceneId}
              preload={offset <= 1 ? 'auto' : 'metadata'} />
          )}
        </ShotColorMatchFrame>
      )))}
      {nearToggles.map((toggle) => {
        const incoming = playedScene(scenes.find((scene) => scene.sceneId === toggle.toSceneId), allScenes);
        return incoming ? (
          <ShotColorMatchFrame key={`toggle:${toggle.toSceneId}:${incoming.videoHistoryId || ''}`} project={project} scene={incoming} className="pointer-events-none absolute inset-0 h-full w-full">
            <ToggleClip scene={incoming} projectId={project?.id} toggle={toggle} audioRef={audioRef} time={time} layered={layered} fps={stillFps} beats={beats} />
          </ShotColorMatchFrame>
        ) : null;
      })}
      {nearFades.map((fade) => <FadeBlack key={`fade:${fade.fromSceneId}`} fade={fade} audioRef={audioRef} time={time} />)}
    </>
  );
}

function resolveStageWindow(project, pictureShot) {
  // Cards and code shots stay full frame, matching the render (a code shot is drawn as a card).
  const inset = !!(pictureShot && !isSelfDrawnLayer(pictureShot.visualLayer));
  const windowCamera = inset ? shotCamera(project, pictureShot) : null;
  const frameCss = windowCamera?.frame?.aspect ? cameraFrameCss(windowCamera.frame.aspect) : null;
  const overscan = inset ? musicVideoOverscan(project) : 0;
  const osdDate = typeof windowCamera?.osd?.date === 'string' ? windowCamera.osd.date : '';
  const osdRecord = windowCamera?.osd?.record === true;
  const showWindow = inset && !!(frameCss || overscan > 0 || osdRecord || osdDate);
  const matte = /^#[0-9a-f]{6}$/i.test(windowCamera?.frame?.matte || '') ? windowCamera.frame.matte : '#000000';
  const pictureZoom = overscan > 0 ? 100 / (100 - 2 * Math.min(8, overscan)) : 1;
  return { showWindow, frameCss, matte, pictureZoom, osdRecord, osdDate };
}

function AnimaticCameraWindow({ windowState, children }) {
  const { showWindow, frameCss, matte, pictureZoom, osdRecord, osdDate } = windowState;
  if (!showWindow) return children;
  return (
    <div className="flex h-full w-full items-center justify-center" style={frameCss ? { background: matte } : undefined}>
      <div className="relative overflow-hidden" style={frameCss || { width: '100%', height: '100%' }} data-testid="animatic-camera-frame">
        <div className="relative h-full w-full" style={pictureZoom > 1 ? { transform: `scale(${pictureZoom})` } : undefined}>
          {children}
        </div>
        {(osdRecord || osdDate) && (
          <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 text-[10px] text-red-500" data-testid="animatic-osd">
            {osdRecord && <span className="inline-block h-2 w-2 bg-red-600" aria-hidden="true" />}
            {osdRecord && <span>REC</span>}
            {osdDate && <span>{osdDate}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The visual preview canvas (`<figure data-preview-picture>`): film look, camera window/OSD,
 * shot stills/clips, cut transitions, glitches/wipes, lyrics, title cards, ending, and exact frame.
 */
export default function AnimaticStage({ project, playback, nativeData, blender, figureRef, exactRef }) {
  const {
    audioRef, time, playing, touched, lookOn, documentVariant, nativeDrawing, composite, film,
    fps, layered, planned, lyricLayer, cardLayer, lyricLayerSteady,
    endingPlan, outro, songEndSec, cold, songFrameAt, clock, picture, filmEndSec,
  } = playback;

  // Outro and title cards stay full frame. A shot uses its own look, then its camera's, then the video's.
  // A film is finished with the video's look alone, over its whole frame.
  const pictureShot = outro.active || film ? null : picture;
  const resolvedLook = lookOn ? shotFilmLook(project, pictureShot) : null;
  const windowState = resolveStageWindow(project, pictureShot);

  const pictureLabel = film ? 'Film preview' : composite || documentVariant ? 'Composition preview' : 'Storyboard animatic';
  // The film's own frame shape; a tall frame is narrowed until it fits the screen.
  const filmFrame = film && blender?.settings?.width > 0 && blender.settings.height > 0
    ? { aspectRatio: `${blender.settings.width} / ${blender.settings.height}`, maxWidth: `calc(75dvh * ${blender.settings.width} / ${blender.settings.height})` }
    : null;
  const exactActive = documentVariant && touched && !playing && !cold.active && !outro.active;
  const lookFrame = Math.round((outro.active ? songEndSec + outro.t : cold.active ? cold.time - cold.seconds : time) * fps);
  const lookPlaying = playing || cold.active || (outro.active && !outro.paused && outro.t < outro.seconds);
  const glitchEndSec = cold.active ? cold.seconds : film ? filmEndSec : Number(project.audioAnalysis?.durationSec) || null;
  const wipeEndSec = cold.active ? cold.seconds : Number(project.audioAnalysis?.durationSec) || null;
  const figureStyle = nativeDrawing ? { aspectRatio: `${nativeData.render.width} / ${nativeData.render.height}` } : filmFrame || undefined;

  return (
    <figure ref={figureRef} data-preview-picture aria-label={pictureLabel}
      className={`relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black ${filmFrame ? 'mx-auto' : ''}`}
      style={figureStyle}>
      {/* The shot's resolved film look over the whole picture, lyrics included. */}
      <FilmLookFrame look={resolvedLook} frame={lookFrame} frameAt={outro.active || cold.active ? null : songFrameAt} playing={lookPlaying} className="h-full w-full">
        <AnimaticCameraWindow windowState={windowState}>
          <AnimaticPictures project={project} playback={playback} />
        </AnimaticCameraWindow>
        {nativeDrawing && !cold.active && !outro.active && (
          <DocumentTemplateCanvas project={project} data={nativeData} figureRef={figureRef} audioRef={audioRef} time={time} />
        )}
        {documentVariant && !nativeDrawing && !outro.active && (
          <DocumentTemplateFinish project={project} audioRef={clock.ref} time={clock.time} fps={ANIMATIC_FPS} />
        )}
        {/* The shots' VHS glitches on their cuts, on the frames the final render repaints. */}
        {(!nativeDrawing || cold.active) && (
          <TransitionGlitch scenes={clock.scenes} cameras={project.cameras} figureRef={figureRef} audioRef={clock.ref} time={clock.time}
            layered={layered && !film} endSec={glitchEndSec} fps={fps} />
        )}
        {/* The shots' wipes on their cuts, on the frames the final render paints them. A film's cut draws none. */}
        {!film && (!nativeDrawing || cold.active) && (
          <WipeOverlay scenes={clock.scenes} figureRef={figureRef} audioRef={clock.ref} time={clock.time} planned={planned}
            endSec={wipeEndSec} fps={ANIMATIC_FPS} />
        )}
        {!cold.active && !lyricLayerSteady && lyricLayer.overlay}
        {outro.active && <EndingCanvas parts={endingPlan} stats={outro.stats} t={outro.t} />}
      </FilmLookFrame>
      {/* A steady title card: over the film look and the shots' effects, not through them. The ending covers the frame, card included. */}
      {!cold.active && !outro.active && (lyricLayerSteady ? lyricLayer.overlay : cardLayer.overlay)}
      {documentVariant && <ExactDocumentFrame ref={exactRef} project={project} time={time} active={exactActive} lookOn={lookOn} />}
    </figure>
  );
}
