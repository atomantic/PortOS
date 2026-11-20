import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uuidv4 } from '../../lib/uuid.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { getMusicVideoLyricOverlayPreview, mixMusicVideoColdOpenAudio, musicVideoColdOpenAudioUrl } from '../../services/apiMusicVideo.js';
import { coldOpenPlan, songScenes } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { normalizeTitleCard, titleCardSteady, titleCardSteadySupported, titleCardVisible, titleCardWindows } from '../../../../server/lib/musicVideo/musicVideoTitleCard.js';
import { endingParts } from '../../../../server/lib/musicVideo/musicVideoEnding.js';
import { scenePlayableClipId } from '../../../../server/lib/musicVideo/musicVideoSourceTake.js';
import toast from '../ui/Toast';
import useMusicVideoStatsOutro from '../../hooks/useMusicVideoStatsOutro.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { playthroughVersion } from './CompositionPreviewPlayer.jsx';
import { usePreviewFilmLook } from './PreviewFilmLook.jsx';
import { lyricFrameCaptureBridge } from '../../lib/musicVideoFrameCapture.js';
import { useDocumentCamera } from './DocumentTemplateLayers.jsx';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { sceneImageEffect } from '../../lib/musicVideoImageEffects.js';
import { plannedTransitions, sceneCutEffect, sceneCutEffects } from '../../lib/musicVideoCutEffects.js';
import { blenderSceneClips } from '../../lib/musicVideoBlender.js';
import {
  ANIMATIC_FPS, CLIP_PRELOAD_SHOTS, filmScene, hasTimedLyrics,
  playedScene, shotAt, timedShots, useShotClock, withFilmGaps,
} from './animaticTiming.js';

// How long a seek may wait for its `portos-mv:seeked` reply before the next one goes anyway.
const SEEK_REPLY_MS = 1000;

/**
 * The sung words over the animatic: the server's words-only page (the final
 * render's lyric type, in each shot's text zone, on a transparent frame) in a
 * sandboxed iframe laid over the picture.
 */
function useLyricOverlay({ project, enabled, lyricsVisible, withCard = true, cardOnly = false, audioRef, time, title = 'Lyrics over the storyboard animatic', testId = 'animatic-lyrics' }) {
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef(null);
  const captureRef = useRef(null);
  const seekState = useRef({ inFlight: false, pending: null, ready: false, sentAt: 0, resting: false });
  const version = enabled ? playthroughVersion(project) : null;
  const documentClock = project.composition?.mode === 'document';
  const frameTime = (t) => (documentClock ? Math.floor(t * 24 + 1e-6) / 24 : t);
  // The opening title card rides on the lyric layer, posted live so its panel's edits show at once.
  const titleCard = useMemo(() => (withCard ? normalizeTitleCard(project.titleCard) : null), [withCard, project.titleCard]);
  const titleCardRef = useRef(titleCard);
  const restOutside = useMemo(() => (cardOnly ? titleCardWindows(titleCard) : null), [cardOnly, titleCard]);
  const lyricsVisibleRef = useRef(lyricsVisible);
  lyricsVisibleRef.current = lyricsVisible;

  useEffect(() => {
    if (seekState.current.ready) iframeRef.current?.contentWindow?.postMessage({ type: 'portos-mv:lyrics-visible', visible: lyricsVisible }, '*');
  }, [lyricsVisible]);
  useEffect(() => {
    titleCardRef.current = titleCard;
    if (seekState.current.ready) iframeRef.current?.contentWindow?.postMessage({ type: 'portos-mv:title-card', card: titleCard }, '*');
  }, [titleCard]);

  useEffect(() => {
    let active = true;
    captureRef.current?.reject(new Error('Lyric preview changed'));
    setPreview(null);
    setFailed(false);
    seekState.current = { inFlight: false, pending: null, ready: false, sentAt: 0, resting: false };
    if (!version) return () => { active = false; };
    getMusicVideoLyricOverlayPreview(project.id, { silent: true })
      .then((next) => { if (active) setPreview(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; captureRef.current?.reject(new Error('Lyric preview changed')); };
  }, [project.id, version]);

  const postSeek = useCallback((t) => {
    t = documentClock ? Math.floor(t * 24 + 1e-6) / 24 : t;
    const frame = iframeRef.current?.contentWindow;
    const state = seekState.current;
    if (!frame || !state.ready) return;
    // A seek the page never answered stops holding the queue after a second.
    if (state.inFlight && performance.now() - state.sentAt < SEEK_REPLY_MS) { state.pending = t; return; }
    // `resting` is the last seek SENT, so the one that hides the card always goes, and a card edited while
    // the layer rests is redrawn hidden (a moved window rebuilds the page). A frame capture is never skipped.
    const resting = !!restOutside && !restOutside.some((window) => t >= window.startSec && t < window.endSec);
    if (resting && state.resting && !captureRef.current) return;
    state.resting = resting;
    state.inFlight = true;
    state.sentAt = performance.now();
    frame.postMessage({ type: 'portos-mv:seek', t }, '*');
  }, [documentClock, restOutside]);

  useEffect(() => {
    if (!preview) return undefined;
    const onMessage = (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      const state = seekState.current;
      if (message.type === 'portos-mv:loaded') {
        event.source.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*');
        event.source.postMessage({ type: 'portos-mv:title-card', card: titleCardRef.current }, '*');
        event.source.postMessage({ type: 'portos-mv:lyrics-visible', visible: lyricsVisibleRef.current }, '*');
        state.ready = true;
        // A page that just loaded has drawn its card for second 0, whatever this layer last sent,
        // and never saw a seek posted before it was listening (a layer moved in or out of the film look).
        state.resting = false;
        state.inFlight = false;
        postSeek(audioRef.current?.currentTime || 0);
      } else if (message.type === 'portos-mv:request') {
        event.source.postMessage({ type: 'portos-mv:asset', key: String(message.key), blob: null }, '*');
      } else if (message.type === 'portos-mv:seeked') {
        state.inFlight = false;
        if (state.pending != null) { const next = state.pending; state.pending = null; postSeek(next); }
        else if (captureRef.current?.t === message.t) {
          const capture = captureRef.current;
          event.source.postMessage({ type: 'portos-mv:capture-lyrics', id: capture.id, t: capture.t }, '*');
        }
      } else if (message.type === 'portos-mv:captured-lyrics') {
        const capture = captureRef.current;
        if (!capture || message.id !== capture.id || message.t !== capture.t) return;
        if (message.error || typeof message.png !== 'string' || message.png.length > 24000000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(message.png)) capture.reject(new Error('Lyric frame unavailable'));
        else capture.resolve(message.png);
      } else if (message.type === 'portos-mv:error') {
        captureRef.current?.reject(new Error('Lyric frame unavailable'));
        setFailed(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview, postSeek, audioRef]);

  // A scrub, a seek or a pause lands through `time`; playback runs on animation frames,
  // since the audio's timeupdate is far too coarse for words landing on their onsets.
  useEffect(() => { postSeek(time); }, [time, postSeek]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!preview || !audio) return undefined;
    let handle = 0;
    const tick = () => {
      postSeek(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => cancelAnimationFrame(handle);
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      stop();
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [preview, postSeek, audioRef]);

  const capture = (t) => new Promise((resolve, reject) => {
    t = frameTime(t);
    if (!seekState.current.ready || failed || !iframeRef.current) { reject(new Error('Lyric frame unavailable')); return; }
    const id = uuidv4();
    const finish = (done, result) => { clearTimeout(timer); captureRef.current = null; done(result); };
    const timer = setTimeout(() => finish(reject, new Error('Lyric capture timed out')), 5000);
    captureRef.current = { id, t, resolve: (png) => finish(resolve, png), reject: (error) => finish(reject, error) };
    // The existing serialized seek bridge finishes the requested song time first.
    seekState.current.pending = null;
    postSeek(t);
  });
  if (!preview?.html || failed) return { overlay: null, failed, capture, frameRef: iframeRef };
  return {
    failed,
    capture,
    frameRef: iframeRef,
    overlay: (
      <iframe
        ref={iframeRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={`${preview.html}<script>(${lyricFrameCaptureBridge.toString()})();</script>`}
        // `color-scheme: normal` keeps the frame transparent under a dark parent page.
        style={{ colorScheme: 'normal' }}
        className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent"
        data-testid={testId}
      />
    ),
  };
}

/**
 * The cold open (shots before the song): its shots on a clock of their own,
 * laid out as `scenes` timed from 0, and the sound the final render mixes
 * under them, fetched when it is played.
 */
function useColdOpen({ project, songRef }) {
  const audioRef = useRef(null);
  const [active, setActive] = useState(false);
  const [time, setTime] = useState(0);
  const [src, setSrc] = useState(null);
  const plan = useMemo(() => coldOpenPlan(project), [project]);
  const scenes = useMemo(() => plan.map(({ scene, startSec, endSec }) => ({ ...scene, startSec, endSec })), [plan]);
  const seconds = plan.length ? plan[plan.length - 1].endSec : 0;
  useShotClock(audioRef, scenes, setTime);
  // The mix follows the shots' lengths, sound and playback (speed, in-point, reverse, performance
  // edit); the whole shot is the key, and the server returns its cached WAV when nothing it uses changed.
  const mixKey = JSON.stringify(plan.map(({ scene, preMusic }) => [scene, preMusic]));
  // The mix is made ahead (ffmpeg, cached on the server) so Play can start it inside the tap,
  // which a phone requires before it plays sound.
  const mixing = useRef(null);
  const mix = useCallback(() => {
    if (mixing.current) return mixing.current;
    const request = mixMusicVideoColdOpenAudio(project.id, { silent: true })
      .then((mixed) => {
        const url = mixed?.name ? musicVideoColdOpenAudioUrl(project.id, mixed.name) : null;
        // A request superseded by a newer edit must not replace the newer mix.
        if (mixing.current === request) setSrc(url);
        return url;
      })
      .catch((err) => { if (mixing.current === request) mixing.current = null; throw err; });
    mixing.current = request;
    return request;
  }, [project.id]);
  useEffect(() => {
    // A playing cold open stops with its now-stale mix, so it cannot hand over to the song later.
    audioRef.current?.pause?.();
    setSrc(null);
    setActive(false);
    mixing.current = null;
    if (plan.length) mix().catch(() => {});
    // Mixed again only when what it plays changes.
  }, [project.id, mixKey, plan.length, mix]);
  const stop = useCallback(() => { audioRef.current?.pause?.(); setActive(false); }, []);
  const start = useCallback(async () => {
    if (!plan.length) return;
    songRef.current?.pause?.();
    setActive(true);
    setTime(0);
    const url = src || await mix().catch((err) => {
      toast.error(err?.message || 'The sound before the song could not be mixed');
      return null;
    });
    if (!url) { setActive(false); return; }
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.getAttribute('src') !== url) audio.src = url;
    audio.currentTime = 0;
    audio.play?.()?.catch?.(() => {});
  }, [plan.length, mix, songRef, src]);
  // The song's own play from its first note runs the cold open first, except the
  // play the cold open hands over with when it ends.
  const handingOver = useRef(false);
  const onEnded = () => {
    setActive(false);
    const song = songRef.current;
    if (!song) return;
    handingOver.current = true;
    song.currentTime = 0;
    song.play?.()?.catch?.(() => { handingOver.current = false; });
  };
  const claimsPlay = useCallback((song) => {
    if (handingOver.current) { handingOver.current = false; return false; }
    if (!plan.length || (song?.currentTime || 0) > 0.05) return false;
    start();
    return true;
  }, [plan.length, start]);
  const audio = plan.length ? (
    <audio ref={audioRef} preload="none" aria-label="Sound before the song" className="hidden"
      onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onEnded={onEnded} />
  ) : null;
  return { audioRef, scenes, seconds, active, time, audio, start, stop, claimsPlay };
}

function computeFilmCutEffect({ film, picture, filmGap, planned, index, timed, shot, stillFps }) {
  if (!film || !picture || filmGap) return null;
  const effect = sceneCutEffect(picture, planned.get(picture.sceneId));
  if (!effect?.enabled) return null;
  if (effect.style === 'fade-black') return effect;
  const nextShot = index >= 0 ? timed[index + 1] : null;
  const hasNext = Boolean(nextShot && Number.isFinite(shot?.endSec) && Math.round(shot.endSec * stillFps) === Math.round(nextShot.startSec * stillFps));
  return hasNext ? effect : null;
}

/**
 * Playback, timeline sync, lyric/title-card overlays, cold open, outro,
 * and preloaded shot/clip resolution for StoryboardAnimatic.
 */
export default function useAnimaticPlayback({ project, seekRequest, onEditShot, variant, nativeData, blender }) {
  const audioRef = useRef(null);
  const applied = useRef(null);
  const [time, setTime] = useState(0);
  const [lyricsOn, setLyricsOn] = useState(true);
  const [lookOn, toggleLook] = usePreviewFilmLook();
  // While the song plays the look is the light playback version; paused, the exact render filter.
  const [playing, setPlaying] = useState(false);
  // A composition document plays here natively; once the viewer has played or
  // moved the song, a paused frame shows the document's own exact frame.
  const documentVariant = variant === 'document';
  const nativeDrawing = documentVariant && !!nativeData;
  const [touched, setTouched] = useState(false);
  const documentCamera = useDocumentCamera(project, documentVariant);
  const lookAvailable = !isFilmLookNeutral(project.filmLook);
  const composite = variant === 'composite';
  const film = composite && project.composition?.mode === 'blender';
  // Keyed to the shots and renders alone: a job's progress replaces the film state many times a second.
  const filmShots = blender?.manifest?.shots;
  const filmRenders = blender?.renders;
  const filmSceneMap = project.blender?.sceneMap;
  const filmClips = useMemo(() => (film ? blenderSceneClips({ shots: filmShots, renders: filmRenders, sceneMap: filmSceneMap }) : null),
    [film, filmShots, filmRenders, filmSceneMap]);
  // A film's effects and frame steps land on its own frame grid, as its cut paints them.
  const fps = film && blender?.settings?.fps > 0 ? blender.settings.fps : ANIMATIC_FPS;
  // The song's shots; shots before the song play on the cold open's clock (useColdOpen).
  const scenes = useMemo(() => songScenes(project), [project]);
  const clockScenes = useMemo(() => (film ? withFilmGaps(scenes) : scenes), [film, scenes]);
  useShotClock(audioRef, clockScenes, setTime);
  const layered = isLayeredComposition(project);
  // The first footage source sets the composed render's frame rate, even when the current shot is a still.
  const allScenes = project.scenes || [];
  const lead = scenes.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .find((scene) => scenePlayableClipId(scene, allScenes) && sceneVisualLayer(scene, { layered }) === 'footage');
  const leadFile = useVideoFileSrc(layered ? scenePlayableClipId(lead, allScenes) : null, { geometry: true });
  const stillFps = project.composition?.mode === 'document' ? ANIMATIC_FPS : leadFile.fps || ANIMATIC_FPS;
  // A Blender film letters its own lyrics, so its lyric layer carries the title card alone.
  const lyricsAvailable = !film && project.lyricOverlayEnabled !== false && hasTimedLyrics(project);
  const card = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  // The opening title card rides on the lyric layer, so a video with its words switched off still
  // needs that layer for the card; the page itself keeps the words hidden.
  const cardOnly = (!lyricsAvailable || !lyricsOn) && titleCardVisible(card);
  const templateCues = documentVariant && (project.composition?.textCues || []).some((cue) => cue.text && Number.isFinite(cue.startSec) && cue.endSec > cue.startSec);
  const wordsLayer = (lyricsAvailable || templateCues) && lyricsOn;
  // A steady card is drawn over the film look, which covers everything inside its frame, so its
  // layer sits outside that frame: the lyric layer itself when it carries nothing else, otherwise a
  // second, card-only layer while the words stay in the film.
  const steadyCard = titleCardSteady(card) && titleCardSteadySupported(project);
  const cardOverWords = steadyCard && wordsLayer;
  const lyricLayer = useLyricOverlay({
    project, enabled: wordsLayer || cardOnly, lyricsVisible: lyricsOn && !film, withCard: !cardOverWords, audioRef, time,
    ...(film ? { title: 'Title card over the film preview' } : {}),
  });
  const cardLayer = useLyricOverlay({
    project, enabled: cardOverWords, lyricsVisible: false, cardOnly: true, audioRef, time,
    title: 'Title card over the storyboard animatic', testId: 'animatic-title-card',
  });
  const lyricLayerSteady = steadyCard && !wordsLayer;
  const { statsOutro, creditsOutro } = project;
  const endingPlan = useMemo(() => endingParts({ statsOutro, creditsOutro }), [statsOutro, creditsOutro]);
  const outro = useMusicVideoStatsOutro({ projectId: project.id, seconds: endingPlan.reduce((sum, part) => sum + part.durationSec, 0), audioRef });
  const songEndSec = Number(project.audioAnalysis?.durationSec) || 0;
  const cold = useColdOpen({ project, songRef: audioRef });

  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n || !audioRef.current) return;
    applied.current = seekRequest.n;
    audioRef.current.currentTime = seekRequest.t;
    setTime(seekRequest.t);
    if (seekRequest.play) audioRef.current.play?.()?.catch?.(() => {});
    else if (seekRequest.pause) audioRef.current.pause?.();
  }, [seekRequest]);

  // Back and Next move the song; it keeps playing or stays paused as it was.
  const seekTo = useCallback((t) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    setTime(t);
  }, []);
  // Frame steps pause the song first, so the frame stays on screen to check.
  const stepFrame = useCallback((t) => {
    audioRef.current?.pause?.();
    seekTo(t);
  }, [seekTo]);
  // The film look's weave and grain follow the song frame by frame while it plays, as the render steps them.
  const songFrameAt = useCallback(() => Math.round((audioRef.current?.currentTime || 0) * fps), [fps]);
  // Edit shot pauses the song so the shot stays on screen while its card opens.
  const editShot = onEditShot ? (sceneId) => { audioRef.current?.pause?.(); onEditShot(sceneId); } : null;

  // Cut effects (beat toggles, dissolves, fades through black), on the frames the final
  // render paints them (lib/musicVideoCutEffects.js), storyboard-planned ones included.
  const beats = project.audioAnalysis?.beats;
  const storyboardRows = project.productionReview?.draft?.storyboard;
  const planned = useMemo(() => plannedTransitions(storyboardRows), [storyboardRows]);
  // A film's cut paints none of them: each needs the two shots' pictures, and its shots are joined as rendered.
  const cutEffects = useMemo(() => (film ? [] : sceneCutEffects(scenes, { fps: stillFps, beats, endSec: songEndSec || null, planned })),
    [film, scenes, stillFps, beats, songEndSec, planned]);
  // A toggle or dissolve mounts its incoming clip a little ahead, so it has loaded when it starts showing.
  const nearToggles = cold.active ? [] : cutEffects.filter((t) => t.incoming && time >= t.windowStartSec - 3 && time < t.cutSec);
  const nearFades = cold.active ? [] : cutEffects.filter((t) => t.style === 'fade-black' && time >= t.outStartSec - 1 && time < t.inEndSec + 1);
  // While the cold open plays, its shots follow its own sound instead of the song.
  const clock = cold.active ? { ref: cold.audioRef, time: cold.time, scenes: cold.scenes } : { ref: audioRef, time, scenes };
  const shot = shotAt(clock.scenes, clock.time);
  const picture = playedScene(shot, allScenes);
  const timed = timedShots(clock.scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  // A still shot with an image effect plays the effect over its still, as the composed render does, not its clip.
  const shotEffect = picture ? sceneImageEffect(picture, { layered }) : null;
  const stillShot = picture && layered && (sceneVisualLayer(picture, { layered }) === 'still' || !picture.videoHistoryId);
  // The shot on screen and the next few: each keeps one mounted clip, so the cut to the
  // next shot shows a clip that has already loaded and sits on its first frame.
  const loadedShots = timed.slice(Math.max(index, 0), Math.max(index, 0) + 1 + CLIP_PRELOAD_SHOTS);
  const clipShots = film
    ? loadedShots.map((scene, offset) => ({ scene: filmScene(scene), offset, clip: filmClips.get(scene.sceneId) })).filter((item) => item.clip)
    : loadedShots.map((scene, offset) => ({ scene: playedScene(scene, allScenes), offset }))
      .filter((item) => item.scene.videoHistoryId && sceneVisualLayer(item.scene, { layered }) === 'footage');
  // Past its shot's end a film shows black until the next shot starts.
  const filmGap = film && !!shot && Number.isFinite(shot.endSec) && clock.time >= shot.endSec;
  const filmClip = film && shot && !filmGap ? filmClips.get(shot.sceneId) || null : null;
  const filmCutEffect = useMemo(
    () => computeFilmCutEffect({ film, picture, filmGap, planned, index, timed, shot, stillFps }),
    [film, picture, filmGap, planned, index, timed, shot, stillFps],
  );
  const filmEndSec = film ? timed.reduce((end, scene) => (Number.isFinite(scene.endSec) ? Math.max(end, scene.endSec) : end), 0) || null : null;
  const label = shot ? shot.label || `Shot ${index + 1}` : 'No shots yet';

  return {
    audioRef, time, setTime, playing, setPlaying, touched, setTouched,
    lyricsOn, setLyricsOn, lookOn, toggleLook, lookAvailable,
    documentVariant, nativeDrawing, composite, film, filmClips, documentCamera,
    fps, stillFps, scenes, allScenes, layered, beats, planned,
    lyricsAvailable, cardOnly, cardOverWords, lyricLayer, cardLayer, lyricLayerSteady,
    endingPlan, outro, songEndSec, cold,
    seekTo, stepFrame, songFrameAt, editShot,
    nearToggles, nearFades, clock, shot, picture, timed, index,
    shotEffect, stillShot, clipShots, filmGap, filmClip, filmCutEffect, filmEndSec, label,
  };
}
