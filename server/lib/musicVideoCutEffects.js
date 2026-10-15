/**
 * Music Video cut effects: configurable effects that play across a cut between
 * two shots, set on the outgoing shot (`scene.cutEffect`) and switched on or
 * off without losing their settings. Like the cut transitions
 * (musicVideoTransitions.js) they never add time or move a cut.
 *
 * `beat-toggle`: over the last moments of the outgoing shot both clips play and
 * the picture flips between them on the song's beats, incoming first
 * (incoming, outgoing, incoming, …), then the incoming shot carries on. Its
 * clip runs on the song's clock: during the flips it shows the footage just
 * before its in-point (as its speed and offset place it), so beat-timed motion
 * and a lip-sync stay on the song, and the shot itself starts exactly where it
 * would without the toggle.
 *
 * `dissolve`: over the last moments of the outgoing shot the incoming clip fades
 * in over it, on the song's clock like the toggle's, and is fully in on the cut.
 *
 * `fade-black`: the outgoing shot fades to black and the incoming one fades in
 * from it, half the length on each side of the cut. On the last shot it fades
 * the video out to black.
 *
 * One definition serves both players: the final render paints exactly the
 * frames `cutEffectCuts` names, and the storyboard animatic shows the same.
 */

export const MUSIC_VIDEO_CUT_EFFECTS = Object.freeze(['beat-toggle', 'dissolve', 'fade-black']);

export const MUSIC_VIDEO_CUT_EFFECT_LABELS = Object.freeze({ 'beat-toggle': 'Beat toggle', dissolve: 'Dissolve', 'fade-black': 'Fade through black' });

// How often the picture flips: on every beat, or on every half beat (twice as fast).
export const BEAT_TOGGLE_RATES = Object.freeze(['beat', 'half']);
export const BEAT_TOGGLE_RATE_LABELS = Object.freeze({ beat: 'Every beat', half: 'Every half beat' });

// How long a cut effect plays, in seconds: before the cut for a toggle or dissolve, across it for a fade.
export const BEAT_TOGGLE_OVERLAP = Object.freeze({ min: 0.25, max: 4, default: 1 });

// With no beat grid the overlap is split into this many even steps.
const FALLBACK_STEPS = 4;
// A beat this close to the cut is the cut itself, not a flip before it.
const CUT_GUARD_SEC = 0.02;

/**
 * A scene's cut effect with its settings filled in (`{ style, enabled,
 * overlapSec, rate }`), or null when it has none. A switched-off effect keeps
 * its settings, so turning it back on restores them. `planned` (a storyboard
 * row's transition, see `plannedCutEffect`) stands in while the shot has never
 * set one.
 */
export function sceneCutEffect(scene, planned = null) {
  const effect = scene?.cutEffect === undefined ? plannedCutEffect(planned) : scene?.cutEffect;
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
 * The cut effects on a cut timeline. `pieces` are its sections in order,
 * `{ sceneId, startFrame, endFrame, partner?, cutEffect? }` on one frame grid
 * (`cutEffect` as `sceneCutEffect` returns it). An effect plays on the cut out
 * of a shot's last piece into the next shot's first (a fade to black also at
 * the end of the last shot); an intercut partner piece on either side carries
 * none. Returns, per effect, `{ style, index, cutFrame }` with `index` the
 * outgoing piece, plus:
 * - beat toggle and dissolve: `windowFrames`, how many frames before the cut the
 *   incoming clip is read, and `incoming`, the frames (on the timeline) it shows
 *   on: the toggle's flips, or the whole window for a dissolve, which fades it in;
 * - fade through black: `outFrames` fading out before the cut and `inFrames`
 *   fading in after it.
 */
export function cutEffectCuts(pieces, { fps, beats = [] }) {
  const list = Array.isArray(pieces) ? pieces : [];
  const lastOf = new Map();
  const firstOf = new Map();
  list.forEach((p, i) => {
    if (!p || p.partner) return;
    if (!firstOf.has(p.sceneId)) firstOf.set(p.sceneId, i);
    lastOf.set(p.sceneId, i);
  });
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const from = list[i];
    const to = list[i + 1];
    const effect = from?.cutEffect;
    if (!effect?.enabled || from.partner || lastOf.get(from.sceneId) !== i) continue;
    const intoNext = !!to && !to.partner && to.sceneId !== from.sceneId && firstOf.get(to.sceneId) === i + 1;
    const cutFrame = to ? to.startFrame : from.endFrame;
    const lengthFrames = Math.max(1, Math.round(effect.overlapSec * fps));
    if (effect.style === 'fade-black') {
      if (to && !intoNext) continue;
      const before = to ? Math.ceil(lengthFrames / 2) : lengthFrames;
      const outFrames = Math.min(before, cutFrame - from.startFrame);
      const inFrames = to ? Math.min(lengthFrames - before, to.endFrame - to.startFrame) : 0;
      if (outFrames + inFrames > 0) out.push({ style: effect.style, index: i, cutFrame, outFrames, inFrames });
      continue;
    }
    if (!intoNext) continue;
    if (effect.style === 'dissolve') {
      // It starts after the outgoing shot's first frame, so that shot always shows.
      const windowFrames = Math.min(lengthFrames, cutFrame - from.startFrame - 1);
      if (windowFrames > 0) out.push({ style: effect.style, index: i, cutFrame, windowFrames, incoming: [[cutFrame - windowFrames, cutFrame]] });
      continue;
    }
    if (effect.style !== 'beat-toggle') continue;
    const switches = beatToggleSwitches({ cutSec: cutFrame / fps, overlapSec: effect.overlapSec, rate: effect.rate, beats })
      .map((sec) => Math.round(sec * fps))
      // A flip keeps to the outgoing shot, after its first frame.
      .filter((f, k, all) => f > from.startFrame && f < cutFrame && f !== all[k - 1]);
    if (!switches.length) continue;
    const incoming = [];
    for (let k = 0; k < switches.length; k += 2) incoming.push([switches[k], k + 1 < switches.length ? switches[k + 1] : cutFrame]);
    out.push({ style: effect.style, index: i, cutFrame, windowFrames: cutFrame - switches[0], incoming });
  }
  return out;
}

/**
 * The storyboard's cut effects in song seconds (the animatic's counterpart of
 * the render's): `[{ style, fromSceneId, toSceneId, cutSec, ... }]`, with
 * `windowStartSec` and `incoming: [[fromSec, toSec)]` for a toggle or dissolve,
 * and `outStartSec` / `inEndSec` for a fade through black (`toSceneId` null on
 * the last shot). `planned` maps a scene id to its storyboard row's transition.
 */
export function sceneCutEffects(scenes, { fps, beats = [], endSec = null, planned = null }) {
  const timed = (Array.isArray(scenes) ? scenes : []).filter((s) => Number.isFinite(s?.startSec)).sort((a, b) => a.startSec - b.startSec);
  const pieces = timed.map((scene, i) => {
    const next = timed[i + 1];
    const stop = next ? next.startSec : (Number.isFinite(endSec) ? endSec : scene.endSec);
    return {
      sceneId: scene.sceneId, startFrame: Math.round(scene.startSec * fps), endFrame: Math.round((stop ?? scene.startSec) * fps),
      cutEffect: sceneCutEffect(scene, planned?.get?.(scene.sceneId)),
    };
  });
  return cutEffectCuts(pieces, { fps, beats }).map((t) => ({
    style: t.style,
    fromSceneId: pieces[t.index].sceneId,
    toSceneId: pieces[t.index + 1]?.sceneId ?? null,
    cutSec: t.cutFrame / fps,
    ...(t.incoming ? { windowStartSec: (t.cutFrame - t.windowFrames) / fps, incoming: t.incoming.map(([a, b]) => [a / fps, b / fps]) }
      : { outStartSec: (t.cutFrame - t.outFrames) / fps, inEndSec: (t.cutFrame + t.inFrames) / fps }),
  }));
}

// A storyboard row's transition, in its own words, as a cut effect out of its shot:
// a fade to black, or a dissolve or plain fade into the next shot. An "Entry:" part
// describes the cut into the shot, as does a fade in, so only the rest is read.
const FADE_BLACK = /\b(fades?|dips?)\b[^.;]*\bblack\b|\bfade[sd]? out\b/i;
const DISSOLVE = /\b(dissolves?|cross-?fades?|fades?)\b/i;

/** The cut effect a storyboard row's `transition` text plans out of its shot, or null (a plain cut). */
export function plannedCutEffect(transition) {
  if (typeof transition !== 'string') return null;
  const exit = transition.replace(/\bentry:[^.;]*[.;]?/i, '').replace(/\bfades? in\b[^.;]*/gi, '');
  const style = FADE_BLACK.test(exit) ? 'fade-black' : DISSOLVE.test(exit) ? 'dissolve' : null;
  return style ? { style, enabled: true, overlapSec: BEAT_TOGGLE_OVERLAP.default } : null;
}

/** Each storyboard row's transition by scene id (`rows`: `project.productionReview.draft.storyboard`), for `sceneCutEffect` and `sceneCutEffects`. */
export function plannedTransitions(rows) {
  return new Map((Array.isArray(rows) ? rows : []).filter((row) => row?.sceneId && typeof row.transition === 'string').map((row) => [row.sceneId, row.transition]));
}
