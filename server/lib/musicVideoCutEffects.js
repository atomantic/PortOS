/**
 * Music Video cut effects: configurable effects that play across a cut between
 * two shots, set on the outgoing shot (`scene.cutEffect`) and switched on or
 * off without losing their settings. Like the cut transitions
 * (musicVideoTransitions.js) they never add time or move a cut.
 *
 * `beat-toggle`: over the last moments of the outgoing shot both clips play and
 * the picture flips between them on the song's beats, incoming first
 * (incoming, outgoing, incoming, …), then the incoming shot carries on. Its
 * clip keeps running from where the toggle started it, so the cut lands mid-
 * motion; a lip-synced (performance) shot instead starts from its in-point at
 * the cut, so its mouth stays on the words.
 *
 * One definition serves both players: the final render overlays the incoming
 * clip on exactly the frames `beatToggleCuts` names, and the storyboard
 * animatic shows it on the same frames.
 */

export const MUSIC_VIDEO_CUT_EFFECTS = Object.freeze(['beat-toggle']);

export const MUSIC_VIDEO_CUT_EFFECT_LABELS = Object.freeze({ 'beat-toggle': 'Beat toggle' });

// How often the picture flips: on every beat, or on every half beat (twice as fast).
export const BEAT_TOGGLE_RATES = Object.freeze(['beat', 'half']);
export const BEAT_TOGGLE_RATE_LABELS = Object.freeze({ beat: 'Every beat', half: 'Every half beat' });

// The overlap before the cut the toggle plays over, in seconds.
export const BEAT_TOGGLE_OVERLAP = Object.freeze({ min: 0.25, max: 4, default: 1 });

// With no beat grid the overlap is split into this many even steps.
const FALLBACK_STEPS = 4;
// A beat this close to the cut is the cut itself, not a flip before it.
const CUT_GUARD_SEC = 0.02;

/**
 * A scene's cut effect with its settings filled in (`{ style, enabled,
 * overlapSec, rate }`), or null when it has none. A switched-off effect keeps
 * its settings, so turning it back on restores them.
 */
export function sceneCutEffect(scene) {
  const effect = scene?.cutEffect;
  if (!effect || !MUSIC_VIDEO_CUT_EFFECTS.includes(effect.style)) return null;
  const overlap = Number(effect.overlapSec);
  return {
    style: effect.style,
    enabled: effect.enabled !== false,
    overlapSec: Number.isFinite(overlap) ? Math.min(BEAT_TOGGLE_OVERLAP.max, Math.max(BEAT_TOGGLE_OVERLAP.min, overlap)) : BEAT_TOGGLE_OVERLAP.default,
    rate: BEAT_TOGGLE_RATES.includes(effect.rate) ? effect.rate : 'beat',
  };
}

/**
 * The song times (seconds) where a beat toggle flips the picture before a cut
 * at `cutSec`: the beats (or half beats) in the `overlapSec` before it, else
 * even steps when the song has no beat grid. The incoming shot shows from the
 * first flip to the second, the third to the fourth, and so on; a flip left
 * open runs to the cut.
 */
export function beatToggleSwitches({ cutSec, overlapSec, rate = 'beat', beats = [] }) {
  const start = cutSec - overlapSec;
  const end = cutSec - CUT_GUARD_SEC;
  const grid = (Array.isArray(beats) ? beats : []).filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
  const points = [];
  grid.forEach((b, i) => {
    if (b >= start - 0.001 && b < end) points.push(b);
    if (rate === 'half' && i + 1 < grid.length) {
      const half = (b + grid[i + 1]) / 2;
      if (half >= start - 0.001 && half < end) points.push(half);
    }
  });
  if (!points.length) {
    for (let k = 0; k < FALLBACK_STEPS; k++) points.push(start + (k * overlapSec) / FALLBACK_STEPS);
  }
  return [...new Set(points)].sort((a, b) => a - b);
}

/**
 * The beat toggles on a cut timeline. `pieces` are its sections in order,
 * `{ sceneId, startFrame, endFrame, partner?, cutEffect?, performance? }` on one
 * frame grid (`cutEffect` as `sceneCutEffect` returns it). A toggle plays on the
 * cut out of a shot's last piece into the next shot's first; an intercut
 * partner piece on either side carries none. Returns, per toggle:
 * `{ index, cutFrame, windowFrames, incoming: [[from, to)], leadFrames }` with
 * `index` the outgoing piece, `incoming` the frames (on the timeline) that show
 * the incoming clip, `windowFrames` how many frames before the cut the incoming
 * clip starts playing, and `leadFrames` how far its clip has run by the cut
 * (0 for a performance shot, which starts again at its in-point).
 */
export function beatToggleCuts(pieces, { fps, beats = [] }) {
  const list = Array.isArray(pieces) ? pieces : [];
  const lastOf = new Map();
  const firstOf = new Map();
  list.forEach((p, i) => {
    if (!p || p.partner) return;
    if (!firstOf.has(p.sceneId)) firstOf.set(p.sceneId, i);
    lastOf.set(p.sceneId, i);
  });
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    const from = list[i];
    const to = list[i + 1];
    const effect = from?.cutEffect;
    if (!effect?.enabled || effect.style !== 'beat-toggle' || from.partner || to?.partner || from.sceneId === to.sceneId) continue;
    if (lastOf.get(from.sceneId) !== i || firstOf.get(to.sceneId) !== i + 1) continue;
    const cutFrame = to.startFrame;
    const switches = beatToggleSwitches({ cutSec: cutFrame / fps, overlapSec: effect.overlapSec, rate: effect.rate, beats })
      .map((sec) => Math.round(sec * fps))
      // A flip keeps to the outgoing shot, after its first frame.
      .filter((f, k, all) => f > from.startFrame && f < cutFrame && f !== all[k - 1]);
    if (!switches.length) continue;
    const incoming = [];
    for (let k = 0; k < switches.length; k += 2) incoming.push([switches[k], k + 1 < switches.length ? switches[k + 1] : cutFrame]);
    const windowFrames = cutFrame - switches[0];
    out.push({ index: i, cutFrame, windowFrames, incoming, leadFrames: to.performance ? 0 : windowFrames });
  }
  return out;
}

/**
 * The storyboard's beat toggles in song seconds (the animatic's counterpart of
 * the render's): `[{ fromSceneId, toSceneId, windowStartSec, cutSec, incoming:
 * [[fromSec, toSec)], leadSec }]`. `isPerformance(scene)` says whether a shot
 * plays a lip-synced edit.
 */
export function sceneBeatToggles(scenes, { fps, beats = [], endSec = null, isPerformance = () => false }) {
  const timed = (Array.isArray(scenes) ? scenes : []).filter((s) => Number.isFinite(s?.startSec)).sort((a, b) => a.startSec - b.startSec);
  const pieces = timed.map((scene, i) => {
    const next = timed[i + 1];
    const stop = next ? next.startSec : (Number.isFinite(endSec) ? endSec : scene.endSec);
    return {
      sceneId: scene.sceneId, startFrame: Math.round(scene.startSec * fps), endFrame: Math.round((stop ?? scene.startSec) * fps),
      cutEffect: sceneCutEffect(scene), performance: !!isPerformance(scene),
    };
  });
  return beatToggleCuts(pieces, { fps, beats }).map((t) => ({
    fromSceneId: pieces[t.index].sceneId,
    toSceneId: pieces[t.index + 1].sceneId,
    windowStartSec: (t.cutFrame - t.windowFrames) / fps,
    cutSec: t.cutFrame / fps,
    incoming: t.incoming.map(([a, b]) => [a / fps, b / fps]),
    leadSec: t.leadFrames / fps,
  }));
}
