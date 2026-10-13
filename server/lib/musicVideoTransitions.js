/**
 * Music Video cut transitions: short VHS glitches that ride on top of a cut
 * between two shots. A glitch never adds time or moves a cut: it repaints a
 * few frames around the cut (the outgoing shot's last frames and the incoming
 * shot's first) and every clip keeps its timing.
 *
 * A shot sets `transitionOut` (the cut to the next shot) and/or
 * `transitionIn` (the cut from the previous one); both name the same cut, so
 * the outgoing shot's choice wins when both are set. The first shot's "in"
 * glitches the video's opening frames and the last shot's "out" its closing ones.
 *
 * One definition serves both players: the final render turns each glitch
 * frame into ffmpeg filters enabled on exactly that frame
 * (`musicVideoTransitionFilter`), and the storyboard animatic paints the same
 * frame parameters on a canvas over the picture. Every distance is a fraction
 * of the frame's width or height, so a glitch reads the same at any size.
 */

import { IMAGE_EFFECT_GLITCH_STYLE, imageEffectChangeFrame, sceneImageEffect } from './musicVideoImageEffects.js';

export const MUSIC_VIDEO_TRANSITIONS = Object.freeze(['vhs-glitch', 'channel-change', 'vhs-tracking', 'vhs-dropout', 'camera-flash']);

export const MUSIC_VIDEO_TRANSITION_LABELS = Object.freeze({
  'vhs-glitch': 'VHS glitch',
  'channel-change': 'Channel change',
  'vhs-tracking': 'Tracking roll',
  'vhs-dropout': 'Dropout flash',
  'camera-flash': 'Camera flash',
});

// Each style's frames, in order, and how many of them come before the cut
// (`lead`, the outgoing shot's last frames). Per frame:
//   shift   whole-frame horizontal slip (signed fraction of width)
//   roll    whole-frame vertical roll (signed fraction of height), a TV losing vertical hold
//   tears   bands slipped sideways: { y, h } fractions of height, shift of width
//   chroma  colour fringe width (fraction of width)
//   bright  brightness multiplier; sat a saturation multiplier
//   noise   snow strength: 0..1 over the picture, up to 1.6 for a dead channel's static
//   lines   scanline darkness, 0..1
//   bar     a bright tracking band { y, h, alpha }
export const MUSIC_VIDEO_TRANSITION_STYLES = Object.freeze({
  'vhs-glitch': {
    lead: 1,
    frames: [
      { tears: [{ y: 0.58, h: 0.14, shift: 0.05 }], chroma: 0.008, bright: 1.05, sat: 1.2, noise: 0.25, lines: 0.25 },
      { shift: 0.03, tears: [{ y: 0.12, h: 0.1, shift: -0.08 }, { y: 0.7, h: 0.18, shift: 0.1 }], chroma: 0.016, bright: 1.25, sat: 1.4,
        noise: 0.45, lines: 0.4, bar: { y: 0.66, h: 0.035, alpha: 0.7 } },
      { tears: [{ y: 0.4, h: 0.08, shift: 0.04 }], chroma: 0.006, sat: 1.1, noise: 0.2, lines: 0.2 },
    ],
  },
  // A classic TV changing channels: the old picture rolls and breaks into
  // static, a frame of dead air, and the new one rolls in and settles.
  'channel-change': {
    lead: 3,
    frames: [
      { roll: 0.12, shift: 0.02, chroma: 0.006, bright: 1.1, noise: 0.4, lines: 0.3 },
      { roll: 0.38, shift: -0.04, chroma: 0.012, bright: 0.8, sat: 0.6, noise: 0.9, lines: 0.4, bar: { y: 0.36, h: 0.06, alpha: 0.5 } },
      // Dead air: the picture all but gone under a grey wash of static.
      { bright: 0.35, sat: 0, bar: { y: 0, h: 1, alpha: 0.45 }, noise: 1.6, lines: 0.5 },
      { bright: 0.3, sat: 0, bar: { y: 0, h: 1, alpha: 0.5 }, noise: 1.6, lines: 0.5 },
      { roll: -0.3, shift: 0.03, chroma: 0.012, bright: 0.85, sat: 0.6, noise: 0.85, lines: 0.4, bar: { y: 0.68, h: 0.06, alpha: 0.5 } },
      { roll: -0.08, chroma: 0.008, bright: 1.15, sat: 1.1, noise: 0.35, lines: 0.3 },
      { chroma: 0.003, noise: 0.15, lines: 0.15 },
    ],
  },
  'vhs-tracking': {
    lead: 2,
    frames: [
      { tears: [{ y: 0.86, h: 0.1, shift: 0.03 }], chroma: 0.004, noise: 0.2, lines: 0.25, bar: { y: 0.88, h: 0.05, alpha: 0.55 } },
      { tears: [{ y: 0.64, h: 0.12, shift: -0.04 }], chroma: 0.008, bright: 1.1, noise: 0.35, lines: 0.3, bar: { y: 0.66, h: 0.06, alpha: 0.65 } },
      { tears: [{ y: 0.42, h: 0.12, shift: 0.05 }], chroma: 0.01, bright: 1.15, sat: 1.2, noise: 0.4, lines: 0.35, bar: { y: 0.44, h: 0.06, alpha: 0.7 } },
      { tears: [{ y: 0.2, h: 0.1, shift: -0.03 }], chroma: 0.006, noise: 0.3, lines: 0.3, bar: { y: 0.22, h: 0.05, alpha: 0.55 } },
      { chroma: 0.003, noise: 0.15, lines: 0.2, bar: { y: 0.02, h: 0.04, alpha: 0.4 } },
    ],
  },
  // A camera flash on the cut: white rises over the outgoing shot's last two
  // frames, peaks on the cut and fades off the incoming one (a still flashing into a clip).
  'camera-flash': {
    lead: 2,
    frames: [0.35, 0.8, 1, 0.75, 0.5, 0.3, 0.15].map((alpha) => ({ bar: { y: 0, h: 1, alpha } })),
  },
  'vhs-dropout': {
    lead: 1,
    frames: [
      { bright: 1.6, sat: 0.3, noise: 0.7, lines: 0.5 },
      { tears: [{ y: 0.3, h: 0.06, shift: 0.03 }], chroma: 0.01, bright: 1.2, sat: 0.6, noise: 0.5, lines: 0.35 },
    ],
  },
});

const isTransition = (value) => MUSIC_VIDEO_TRANSITIONS.includes(value);

/** A scene's chosen transitions, only the ones that are set: `{ transitionIn?, transitionOut? }`. */
export function sceneTransitions(scene) {
  return {
    ...(isTransition(scene?.transitionIn) ? { transitionIn: scene.transitionIn } : {}),
    ...(isTransition(scene?.transitionOut) ? { transitionOut: scene.transitionOut } : {}),
  };
}

/**
 * Every glitched frame of a cut timeline. `sections` are the cut pieces in
 * order, each `{ sceneId, startFrame, endFrame, transitionIn?, transitionOut? }`
 * on one frame grid. A piece that only borrows another shot's footage (an
 * intercut partner, `partner: true`) carries no transitions, and a shot cut
 * into several pieces glitches in before its first piece and out after its
 * last. Returns `[{ frame, style, index }]` sorted by frame, at most one per
 * frame (an earlier cut keeps a frame two close cuts both reach).
 */
export function transitionGlitchFrames(sections, { totalFrames = null } = {}) {
  const list = (Array.isArray(sections) ? sections : []).filter((s) => s && Number.isFinite(s.startFrame) && Number.isFinite(s.endFrame));
  if (!list.length) return [];
  const end = Number.isFinite(totalFrames) ? totalFrames : list[list.length - 1].endFrame;
  const firstOf = new Map();
  const lastOf = new Map();
  list.forEach((s, i) => {
    if (s.partner) return;
    if (!firstOf.has(s.sceneId)) firstOf.set(s.sceneId, i);
    lastOf.set(s.sceneId, i);
  });
  const outAt = (i) => (!list[i].partner && lastOf.get(list[i].sceneId) === i && isTransition(list[i].transitionOut) ? list[i].transitionOut : null);
  const inAt = (i) => (!list[i].partner && firstOf.get(list[i].sceneId) === i && isTransition(list[i].transitionIn) ? list[i].transitionIn : null);
  const taken = new Map();
  const place = (style, firstFrame) => {
    MUSIC_VIDEO_TRANSITION_STYLES[style].frames.forEach((_, index) => {
      const frame = firstFrame + index;
      if (frame >= 0 && frame < end && !taken.has(frame)) taken.set(frame, { frame, style, index });
    });
  };
  // The opening shot's glitch in starts on the video's first frame.
  if (inAt(0)) place(inAt(0), list[0].startFrame);
  for (let i = 0; i < list.length - 1; i++) {
    const style = outAt(i) || inAt(i + 1);
    if (style) place(style, list[i + 1].startFrame - MUSIC_VIDEO_TRANSITION_STYLES[style].lead);
  }
  // The closing shot's glitch out ends on the video's last frame.
  const last = list.length - 1;
  if (outAt(last)) place(outAt(last), list[last].endFrame - MUSIC_VIDEO_TRANSITION_STYLES[outAt(last)].frames.length);
  return [...taken.values()].sort((a, b) => a.frame - b.frame);
}

/** The glitch parameters to paint on `frame`, or null when that frame plays clean. */
export function transitionFrameAt(glitches, frame) {
  const hit = (glitches || []).find((g) => g.frame === frame);
  return hit ? { ...hit, params: MUSIC_VIDEO_TRANSITION_STYLES[hit.style].frames[hit.index] } : null;
}

/**
 * The storyboard's cut timeline on `fps`: each timed shot runs from its start
 * to the next shot's start (the last to `endSec`, else its own end).
 */
export function sceneTransitionSections(scenes, fps, { endSec = null } = {}) {
  const timed = (Array.isArray(scenes) ? scenes : []).filter((s) => Number.isFinite(s?.startSec)).sort((a, b) => a.startSec - b.startSec);
  return timed.map((scene, i) => {
    const next = timed[i + 1];
    const stop = next ? next.startSec : (Number.isFinite(endSec) ? endSec : scene.endSec);
    return { sceneId: scene.sceneId, startFrame: Math.round(scene.startSec * fps), endFrame: Math.round((stop ?? scene.startSec) * fps), ...sceneTransitions(scene) };
  });
}

const even = (n) => Math.round(n / 2) * 2;
const num = (n) => String(Math.round(n * 10000) / 10000);

// A horizontal slip of the band [y, y+h) by `px` (+ right, - left) as one
// swaprect: the band moves over and the edge it uncovers shows the strip next to it.
function slip(px, y, h, width) {
  const a = Math.min(Math.abs(even(px)), width - 2);
  if (a < 2 || h < 2) return null;
  const [x1, x2] = px > 0 ? [0, a] : [a, 0];
  return `swaprect=w=${width - a}:h=${h}:x1=${x1}:y1=${y}:x2=${x2}:y2=${y}`;
}

// A vertical roll by `px` (+ down, - up) as one swaprect over the full width.
function roll(px, width, height) {
  const a = Math.min(Math.abs(even(px)), height - 2);
  if (a < 2) return null;
  const [y1, y2] = px > 0 ? [0, a] : [a, 0];
  return `swaprect=w=${width}:h=${height - a}:x1=0:y1=${y1}:x2=0:y2=${y2}`;
}

/** Inclusive frame runs as a timeline expression: `between(n,4,6)+between(n,90,90)`. */
function framesExpr(frames) {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const runs = [];
  for (const f of sorted) {
    const run = runs[runs.length - 1];
    if (run && f === run[1] + 1) run[1] = f;
    else runs.push([f, f]);
  }
  return runs.map(([a, b]) => `between(n,${a},${b})`).join('+');
}

/**
 * The ffmpeg filter chain (comma-joined, no labels) that paints `glitches` on
 * a `width`x`height` yuv420p stream counting frames from 0, or null when there
 * are none. Each filter is enabled only on its frames, so every other frame
 * passes through untouched and the stream keeps its length.
 */
export function musicVideoTransitionFilter(glitches, { width, height }) {
  if (!Array.isArray(glitches) || glitches.length === 0) return null;
  const groups = new Map();
  for (const g of glitches) {
    const key = `${g.style}:${g.index}`;
    if (!groups.has(key)) groups.set(key, { params: MUSIC_VIDEO_TRANSITION_STYLES[g.style].frames[g.index], frames: [] });
    groups.get(key).frames.push(g.frame);
  }
  const chain = [];
  const rows = (fraction) => Math.max(0, Math.min(height, even(fraction * height)));
  for (const { params: p, frames } of groups.values()) {
    const enable = `:enable='${framesExpr(frames)}'`;
    const add = (filter) => { if (filter) chain.push(`${filter}${enable}`); };
    if (p.roll) add(roll(p.roll * height, width, height));
    if (p.shift) add(slip(p.shift * width, 0, height, width));
    for (const tear of p.tears || []) {
      const y = rows(tear.y);
      add(slip(tear.shift * width, y, Math.min(rows(tear.h), height - y), width));
    }
    const fringe = Math.min(255, Math.round((p.chroma || 0) * width / 2));
    if (fringe > 0) add(`chromashift=cbh=${fringe}:crh=${-fringe}`);
    const bright = p.bright ?? 1;
    const sat = p.sat ?? 1;
    if (bright !== 1 || sat !== 1) {
      const chroma = `'clip((val-128)*${num(bright * sat)}+128,0,255)'`;
      add(`lutyuv=y='clip(val*${num(bright)},0,255)':u=${chroma}:v=${chroma}`);
    }
    if (p.bar) add(`drawbox=x=0:y=${rows(p.bar.y)}:w=iw:h=${Math.max(2, rows(p.bar.h))}:color=white@${num(p.bar.alpha)}:t=fill`);
    if (p.lines) {
      const gap = Math.max(2, Math.round(height / 270));
      add(`drawgrid=w=iw:h=${gap}:t=${Math.max(1, Math.floor(gap / 2))}:c=black@${num(p.lines)}`);
    }
    if (p.noise) add(`noise=alls=${Math.min(100, Math.round(p.noise * 60))}:allf=t`);
  }
  return chain.length ? chain.join(',') : null;
}

/**
 * The glitched frames end-frame glitch effects play on their cuts, in the cut
 * transitions' shape (`[{ frame, style, index }]`, see above)
 * so both players paint them with the transitions' own code. `pieces` are
 * timeline sections `{ startFrame, endFrame, effect?, effectAtSec? }`; a
 * glitch keeps to its own section.
 */
export function imageEffectGlitchFrames(pieces, fps) {
  const style = MUSIC_VIDEO_TRANSITION_STYLES[IMAGE_EFFECT_GLITCH_STYLE];
  const out = [];
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (piece?.effect?.effect !== 'end-glitch') continue;
    const change = piece.startFrame + imageEffectChangeFrame(piece.effect, fps) - Math.round(Math.max(0, piece.effectAtSec || 0) * fps);
    style.frames.forEach((_, index) => {
      const frame = change - style.lead + index;
      if (frame >= piece.startFrame && frame < piece.endFrame) out.push({ frame, style: IMAGE_EFFECT_GLITCH_STYLE, index });
    });
  }
  return out;
}

/** The storyboard's end-frame glitch frames on `fps` (the animatic's counterpart of the render's pieces). */
export function sceneImageEffectGlitchFrames(scenes, fps, { layered = false, endSec = null } = {}) {
  const byId = new Map((Array.isArray(scenes) ? scenes : []).map((scene) => [scene?.sceneId, scene]));
  return imageEffectGlitchFrames(sceneTransitionSections(scenes, fps, { endSec })
    .map((section) => ({ ...section, effect: sceneImageEffect(byId.get(section.sceneId), { layered }) })), fps);
}

/** Cut-transition glitches and image-effect glitches as one list, a transition keeping a frame both reach. */
export function mergeGlitchFrames(transitions, effects) {
  const taken = new Set((transitions || []).map((g) => g.frame));
  return [...(transitions || []), ...(effects || []).filter((g) => !taken.has(g.frame))].sort((a, b) => a.frame - b.frame);
}
