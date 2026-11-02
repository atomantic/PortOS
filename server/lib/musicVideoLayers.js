/**
 * Music Video — per-scene visual layers (#8985, part of #8966).
 *
 * In a composed render a scene can show its generated footage (the default,
 * and every scene saved before the field existed), its selected still frame
 * with a deterministic camera move, a code-rendered title card (a solid
 * colour whose text the typography layer draws), or a code shot (#10297) that
 * the composition's own code draws. A composition document is handed the
 * `code` layer and no media; whatever its section code draws is the shot (the
 * stock layered template draws nothing extra, leaving the ground and the type).
 * A composed render has no code to run, so it lays a black ground under its
 * typography. Cards and code shots need no frame or clip. A plain concat render always
 * uses footage. Pure and dependency-free: the server render and the client
 * board read the same rules, so the Render button's readiness matches what the
 * render preflight accepts.
 */

export const MUSIC_VIDEO_VISUAL_LAYERS = ['footage', 'still', 'card', 'code'];

/** Layers the composition draws itself: no reference frame and no clip to generate. */
export const isSelfDrawnLayer = (layer) => layer === 'card' || layer === 'code';
export const MUSIC_VIDEO_STILL_MOVES = ['hold', 'push', 'pan'];
// Shared by the composed render and storyboard playback.
export const STILL_PUSH_ZOOM = 0.12;
export const STILL_PAN_TRAVEL = 0.15;

/**
 * How a footage clip whose shape is not the video's fills the frame:
 * `fill` zooms it to fill (the default, and every shot saved before the field
 * existed), the others keep it whole and cover the side gaps with the shot's
 * still, a VHS-style blur of the clip itself, or black bars.
 */
export const MUSIC_VIDEO_FRAME_FITS = ['fill', 'still', 'vhs', 'black'];

/**
 * Kinetic lyric type per shot (#10583), read by the shared lyricType.js document
 * module: `textZone` is where the shot's words may sit so they never cover the
 * subject (`none` keeps the shot clear), and `lyricRole` overrides the role of the
 * lines sung over it. Both are optional; a shot without them takes the sheet's roles
 * and the module's default zone.
 */
export const MUSIC_VIDEO_TEXT_ZONES = ['lower-left', 'upper-right', 'upper', 'lower', 'center', 'none', 'lower-right', 'upper-left'];
// A shot's lyric size: a step down or up from the type's own size (null is normal).
export const MUSIC_VIDEO_LYRIC_SIZES = ['small', 'large'];
export const MUSIC_VIDEO_LYRIC_ROLES = ['line', 'hook', 'stamp', 'data'];

/**
 * Whether a composed render draws the sung lyrics itself, in the shared lyric
 * type the storyboard animatic shows: a composed project with timed lyrics and
 * no subtitle text cues (subtitle cues stand in for the lyrics; a hero cue is a
 * title over them).
 */
export function composedDrawsLyrics(project) {
  const composition = project?.composition;
  if (project?.lyricOverlayEnabled === false || composition?.mode !== 'composed') return false;
  const timed = (cue) => cue?.text && Number.isFinite(cue.startSec) && Number.isFinite(cue.endSec);
  if ((composition.textCues || []).some((cue) => timed(cue) && cue.emphasis !== 'hero')) return false;
  return (Array.isArray(project.lyricCues) ? project.lyricCues : [])
    .some((cue) => typeof cue?.text === 'string' && cue.text.trim() && Number.isFinite(cue.startSec));
}

/**
 * Whether a composition honours per-scene layers: a composed render cuts
 * stills and cards itself, and a composition document (mode `document`) is
 * handed each scene's layer in `window.PORTOS_MV` and draws still/card/code
 * scenes itself — neither needs a clip for them, and a card or code shot needs
 * no frame either.
 * Plain concat and code renders play footage only.
 */
export const LAYERED_COMPOSITION_MODES = Object.freeze(['composed', 'document']);
export const isLayeredComposition = (project) => LAYERED_COMPOSITION_MODES.includes(project?.composition?.mode);

/** The layer a scene contributes; `layered` is true only for a layered composition (see isLayeredComposition). */
export function sceneVisualLayer(scene, { layered = false } = {}) {
  const layer = scene?.visualLayer;
  return layered && (layer === 'still' || isSelfDrawnLayer(layer)) ? layer : 'footage';
}

/** A generated document executes the explicit code-first medium plan. */
export function documentSceneVisualLayer(project, scene, { generated = false } = {}) {
  if (!generated || project?.productionPolicy?.strategy !== 'code-first') return sceneVisualLayer(scene, { layered: true });
  const direction = (project?.treatment?.shotDirections || []).find((entry) => entry.sceneId === scene.sceneId)
    || scene?.direction;
  // A director's code shot stays code; only a planned procedural span becomes the template's card.
  if (direction?.medium === 'procedural') return scene?.visualLayer === 'code' ? 'code' : 'card';
  if (direction?.medium === 'still') return 'still';
  if (direction?.medium === 'existing-footage' || direction?.medium === 'generated-footage') return 'footage';
  return sceneVisualLayer(scene, { layered: true });
}

/** A still/card/code section has no clip to measure, so it needs an authored span. */
export function sceneHasAuthoredSpan(scene) {
  return typeof scene?.startSec === 'number' && typeof scene?.endSec === 'number' && scene.endSec > scene.startSec;
}

/** Fixed shot timing is independent of whether its boundaries landed on beats. */
export const sceneUsesAuthoredTiming = (scene) => Boolean(scene?.pacingCut || scene?.beatAligned
  || (Number.isInteger(scene?.sectionIndex) && scene.sectionIndex >= 0));

/**
 * Whether the render can include this scene as-is: footage needs its clip, a
 * still needs its reference frame and a span, and a card or code shot needs only a span.
 */
export function sceneRenderReady(scene, { layered = false } = {}) {
  const layer = sceneVisualLayer(scene, { layered });
  if (layer === 'footage') return Boolean(scene?.videoHistoryId);
  if (!sceneHasAuthoredSpan(scene)) return false;
  if (layer === 'still' && scene.photoSequence && scene.photoSequence.enabled !== false) return !!scene.photoSequence.imageIds?.length;
  return isSelfDrawnLayer(layer) || Boolean(scene.referenceImageId);
}

// A footage shot's playback timing, set by hand on its card: `speedFps` plays
// the clip that many frames a second faster (or slower) on the 24 fps grid, and
// `offsetFrames` slides it against the song (positive starts that many frames
// into the clip, negative holds its first frame that long). Both are applied
// at playback and render, never by writing another copy of the clip.
export const CLIP_TIMING_FPS = 24;
export const CLIP_SPEED_FPS_RANGE = Object.freeze({ min: -18, max: 48 });
export const CLIP_OFFSET_FRAMES_RANGE = Object.freeze({ min: -240, max: 240 });
const whole = (value, { min, max }) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : 0);
/** How fast a shot's clip plays: 1 is as rendered, 26/24 is two frames a second faster. */
export const clipSpeedRate = (scene) => (CLIP_TIMING_FPS + whole(scene?.speedFps, CLIP_SPEED_FPS_RANGE)) / CLIP_TIMING_FPS;
/** How far a shot's clip slides against the song, in seconds: positive skips in, negative holds the first frame. */
export const clipOffsetSec = (scene) => whole(scene?.offsetFrames, CLIP_OFFSET_FRAMES_RANGE) / CLIP_TIMING_FPS;
// A footage shot's clip set to play backwards. A lip-sync performance never reverses: its mouth follows the song.
export const clipReversed = (scene) => scene?.reverse === true && scene?.shotMode !== 'performance';

export const COVERAGE_TOLERANCE_SEC = 0.25;

/** Performance edits and reversed clips read their source once. */
export const clipCanLoop = (scene, edit = null) => !edit && !clipReversed(scene);
// An absent loop preserves playback for projects saved before shot planning.
export const clipLoops = (scene, edit = null) => clipCanLoop(scene, edit) && scene?.loop !== false;

/**
 * Source trim on the render's output clock, shared with card coverage. Only
 * retimed clips round to milliseconds; untouched performance edits retain
 * their original precision. sourceSec includes footage after the edit out-point.
 */
export function clipPlaybackWindow(scene, edit, duration) {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const sourceInSec = edit ? Math.min(edit.inSec, duration) : 0;
  const sourceOutSec = edit ? Math.min(edit.outSec, duration) : duration;
  const rate = clipSpeedRate(scene);
  const offsetSourceInSec = sourceInSec + clipOffsetSec(scene);
  const retimed = rate !== 1 || offsetSourceInSec !== sourceInSec;
  const leadSec = retimed ? round3(Math.max(0, -offsetSourceInSec)) : 0;
  const clampedSourceInSec = Math.min(duration, Math.max(0, offsetSourceInSec));
  return {
    rate,
    leadSec,
    inSec: retimed ? round3(clampedSourceInSec / rate) : sourceInSec,
    outSec: retimed ? round3(leadSec + Math.max(clampedSourceInSec, sourceOutSec) / rate) : sourceOutSec,
    sourceSec: retimed ? round3(leadSec + (duration - clampedSourceInSec) / rate) : duration - sourceInSec,
  };
}

/** Unknown measurements cannot establish a shortfall; an authored hold covers any gap. */
export function clipNeedsMoreFootage({ loop, holdLastFrame, spanSec, clipSec }, toleranceSec = COVERAGE_TOLERANCE_SEC) {
  return loop === false && !holdLastFrame && Number.isFinite(spanSec) && Number.isFinite(clipSec)
    && spanSec - clipSec > toleranceSec;
}
