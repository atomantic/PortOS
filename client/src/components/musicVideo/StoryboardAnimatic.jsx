import { useRef } from 'react';
import useAnimaticPlayback from './useAnimaticPlayback.jsx';
import { captureAnimaticFrame } from './animaticCapture.js';
import AnimaticStage from './AnimaticStage.jsx';
import AnimaticTransportBar from './AnimaticTransportBar.jsx';

/**
 * Something to watch before anything is rendered: the master song under the
 * storyboard, showing each shot's selected video clip (muted, in step with the
 * song) or else its selected frame (or, without either, its label, time and
 * intent) as the song reaches it, with the aligned lyrics drawn over
 * it once the words are timed (a toggle hides them). `seekRequest`
 * (`{ t, n }`) is the scene-card seek the other preview sources honour too.
 *
 * The composite of a Blender film (`blender`: the film state) plays each
 * shot's render straight out of Blender instead of a take, black with a label
 * where a shot has none, and draws what a cut paints over the joined shots:
 * the video's film look, the shots' cut and in-shot effects and the title card.
 * The film letters its own lyrics, so the words are never laid over it.
 */
export default function StoryboardAnimatic({ project, audioUrl, seekRequest, collapsed, onEditShot = null, variant = 'animatic', nativeData = null, blender = null }) {
  const figureRef = useRef(null);
  const exactRef = useRef(null);
  const captureBasis = useRef(null);

  const playback = useAnimaticPlayback({ project, seekRequest, onEditShot, variant, nativeData, blender });

  captureBasis.current = {
    project,
    lyricsOn: playback.lyricsOn,
    lookOn: playback.lookOn,
    outro: playback.outro.active,
    outroTime: playback.outro.t,
    outroStats: playback.outro.stats,
  };

  const captureFrame = () => captureAnimaticFrame({
    captureBasis,
    audioRef: playback.audioRef,
    figureRef,
    exactRef,
    outro: playback.outro,
    cold: playback.cold,
    documentVariant: playback.documentVariant,
    film: playback.film,
    filmClips: playback.filmClips,
    layered: playback.layered,
    scenes: playback.scenes,
    fps: playback.fps,
    project,
    lyricsAvailable: playback.lyricsAvailable,
    lyricsOn: playback.lyricsOn,
    cardOnly: playback.cardOnly,
    cardOverWords: playback.cardOverWords,
    lyricLayer: playback.lyricLayer,
    cardLayer: playback.cardLayer,
    lyricLayerSteady: playback.lyricLayerSteady,
    setTime: playback.setTime,
    setPlaying: playback.setPlaying,
    setTouched: playback.setTouched,
  });

  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      {/* The source picker names what plays; only a preview missing part of the composition says so. */}
      {playback.documentVariant && !playback.nativeDrawing && (
        <p className="text-xs text-port-text-muted">The template's beat reactions, cards and HUD show only in the paused frame for now.</p>
      )}
      <AnimaticStage
        project={project}
        playback={playback}
        nativeData={nativeData}
        blender={blender}
        figureRef={figureRef}
        exactRef={exactRef}
      />
      <AnimaticTransportBar
        project={project}
        audioUrl={audioUrl}
        playback={playback}
        captureFrame={captureFrame}
      />
    </div>
  );
}
