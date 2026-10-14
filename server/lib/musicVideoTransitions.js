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

export const MUSIC_VIDEO_TRANSITIONS = Object.freeze(['vhs-glitch', 'channel-change', 'vhs-tracking', 'vhs-dropout', 'camera-flash', 'color-block']);

export const MUSIC_VIDEO_TRANSITION_LABELS = Object.freeze({
  'vhs-glitch': 'VHS glitch',
  'channel-change': 'Channel change',
  'vhs-tracking': 'Tracking roll',
  'vhs-dropout': 'Dropout flash',
  'camera-flash': 'Camera flash',
  'color-block': 'Color blocks',
});

// A shot also carries glitches at any moment inside it (`scene.glitches`):
// `{ atSec, style, lengthSec? }`, `atSec` counted from the shot's start and
// `lengthSec` stretching the style's frames (unset plays them once).
export const MUSIC_VIDEO_SHOT_GLITCH_LIMIT = 8;
export const MUSIC_VIDEO_GLITCH_LENGTHS = Object.freeze([0.125, 0.25, 0.5, 1, 2]);

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
//   swaps   macroblocks traded places: { x1, y1, x2, y2, w, h } fractions of the frame
//   blocks  solid colour macroblocks: { x, y, w, h } fractions, color 'rrggbb', alpha
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
  // A digital decoder losing the stream: macroblocks trade places and some
  // decode as flat green, magenta or grey squares, on a 16 x 9 block grid.
  'color-block': {
    lead: 2,
    frames: [
      { swaps: [{ x1: 0.25, y1: 0.3333, x2: 0.5625, y2: 0.4444, w: 0.125, h: 0.1111 }], chroma: 0.006, sat: 1.2,
        blocks: [{ x: 0.625, y: 0.2222, w: 0.0625, h: 0.1111, color: '2fbf4f', alpha: 0.85 }, { x: 0.3125, y: 0.5556, w: 0.125, h: 0.1111, color: 'c02cc0', alpha: 0.7 }] },
      { swaps: [{ x1: 0.0625, y1: 0.1111, x2: 0.5, y2: 0.6667, w: 0.25, h: 0.2222 }, { x1: 0.6875, y1: 0.3333, x2: 0.375, y2: 0.1111, w: 0.1875, h: 0.1111 }],
        chroma: 0.012, bright: 1.05, sat: 1.4,
        blocks: [
          { x: 0.125, y: 0.4444, w: 0.375, h: 0.1111, color: '808080', alpha: 0.6 },
          { x: 0.75, y: 0.5556, w: 0.0625, h: 0.2222, color: '2fbf4f', alpha: 0.9 },
          { x: 0.5625, y: 0.2222, w: 0.125, h: 0.1111, color: 'c02cc0', alpha: 0.8 },
          { x: 0.25, y: 0.7778, w: 0.0625, h: 0.1111, color: '1fa0a0', alpha: 0.85 },
        ] },
      { swaps: [{ x1: 0.4375, y1: 0.5556, x2: 0.125, y2: 0.2222, w: 0.125, h: 0.2222 }], chroma: 0.008, sat: 1.25,
        blocks: [{ x: 0.75, y: 0.1111, w: 0.125, h: 0.1111, color: '2fbf4f', alpha: 0.75 }, { x: 0.0625, y: 0.6667, w: 0.1875, h: 0.1111, color: '808080', alpha: 0.55 }] },
      { chroma: 0.004, sat: 1.1, blocks: [{ x: 0.5, y: 0.4444, w: 0.0625, h: 0.1111, color: 'c02cc0', alpha: 0.6 }] },
    ],
  },
});

const isTransition = (value) => MUSIC_VIDEO_TRANSITIONS.includes(value);

/**
 * A shot's in-shot glitches on the song's clock, valid ones only:
 * `[{ atSec, style, lengthSec? }]` with `atSec` in song seconds, kept inside
 * the shot when its end is known.
 */
function shotGlitchesOnSong(scene) {
  if (!Array.isArray(scene?.glitches) || !Number.isFinite(scene.startSec)) return [];
  const span = Number.isFinite(scene.endSec) ? scene.endSec - scene.startSec : Infinity;
  return scene.glitches
    .filter((g) => g && isTransition(g.style) && Number.isFinite(g.atSec))
    .slice(0, MUSIC_VIDEO_SHOT_GLITCH_LIMIT)
    .map((g) => ({
      atSec: scene.startSec + Math.min(Math.max(0, g.atSec), Math.max(0, span - 0.001)),
      style: g.style,
      ...(Number.isFinite(g.lengthSec) && g.lengthSec > 0 ? { lengthSec: g.lengthSec } : {}),
    }));
}

/**
 * A scene's chosen glitches, only the ones that are set:
 * `{ transitionIn?, transitionOut?, shotGlitches? }` (`shotGlitches` on the song's clock).
 */
export function sceneTransitions(scene) {
  const shotGlitches = shotGlitchesOnSong(scene);
  return {
    ...(isTransition(scene?.transitionIn) ? { transitionIn: scene.transitionIn } : {}),
    ...(isTransition(scene?.transitionOut) ? { transitionOut: scene.transitionOut } : {}),
    ...(shotGlitches.length ? { shotGlitches } : {}),
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

/** A block given in fractions of the frame as even pixels kept inside it: `{ x, y, w, h }`. */
export function blockBox(x, y, w, h, width, height) {
  const px = Math.max(0, Math.min(width - 2, even(x * width)));
  const py = Math.max(0, Math.min(height - 2, even(y * height)));
  return { x: px, y: py, w: Math.max(0, Math.min(width - px, even(w * width))), h: Math.max(0, Math.min(height - py, even(h * height))) };
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
    for (const sw of p.swaps || []) {
      const box = blockBox(sw.x1, sw.y1, sw.w, sw.h, width, height);
      const to = blockBox(sw.x2, sw.y2, sw.w, sw.h, width, height);
      const w = Math.min(box.w, to.w);
      const h = Math.min(box.h, to.h);
      if (w >= 2 && h >= 2) add(`swaprect=w=${w}:h=${h}:x1=${box.x}:y1=${box.y}:x2=${to.x}:y2=${to.y}`);
    }
    const fringe = Math.min(255, Math.round((p.chroma || 0) * width / 2));
    if (fringe > 0) add(`chromashift=cbh=${fringe}:crh=${-fringe}`);
    const bright = p.bright ?? 1;
    const sat = p.sat ?? 1;
    if (bright !== 1 || sat !== 1) {
      const chroma = `'clip((val-128)*${num(bright * sat)}+128,0,255)'`;
      add(`lutyuv=y='clip(val*${num(bright)},0,255)':u=${chroma}:v=${chroma}`);
    }
    for (const b of p.blocks || []) {
      const box = blockBox(b.x, b.y, b.w, b.h, width, height);
      if (box.w >= 2 && box.h >= 2) add(`drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=0x${b.color}@${num(b.alpha)}:t=fill`);
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

/**
 * The glitched frames of the shots' in-shot glitches, in the cut transitions'
 * shape (`[{ frame, style, index }]`). `pieces` are timeline sections carrying
 * `sceneId`, `partner?` and `shotGlitches` (song seconds, from
 * `sceneTransitions`) and `startFrame`/`endFrame`; a glitch paints only on
 * its own shot's pieces, so it never spills into the next shot or over an
 * intercut partner, and a partner borrowing the shot's footage adds none. A `lengthSec` stretches
 * the style's frames over that many frames, holding each a little longer.
 */
export function shotGlitchFrames(pieces, fps) {
  // Each shot's own pieces: a glitch paints only while the shot is on screen.
  const shots = new Map();
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || piece.partner || !Array.isArray(piece.shotGlitches)) continue;
    if (!shots.has(piece.sceneId)) shots.set(piece.sceneId, { glitches: piece.shotGlitches, ranges: [] });
    shots.get(piece.sceneId).ranges.push([piece.startFrame, piece.endFrame]);
  }
  const out = [];
  for (const { glitches, ranges } of shots.values()) {
    const onScreen = (frame) => ranges.some(([a, b]) => frame >= a && frame < b);
    for (const g of glitches) {
      const style = MUSIC_VIDEO_TRANSITION_STYLES[g.style];
      if (!style) continue;
      const count = style.frames.length;
      const length = g.lengthSec ? Math.max(1, Math.round(g.lengthSec * fps)) : count;
      // The frame showing at that moment, as the player counts it.
      const start = Math.floor(g.atSec * fps + 1e-6);
      for (let i = 0; i < length; i++) {
        if (onScreen(start + i)) out.push({ frame: start + i, style: g.style, index: Math.floor((i * count) / length) });
      }
    }
  }
  return out;
}

/** The storyboard's in-shot glitch frames on `fps` (the animatic's counterpart of the render's pieces). */
export function sceneShotGlitchFrames(scenes, fps, { endSec = null } = {}) {
  return shotGlitchFrames(sceneTransitionSections(scenes, fps, { endSec }), fps);
}

/** Glitch frame lists as one, sorted by frame: an earlier list keeps a frame two of them reach. */
export function mergeGlitchFrames(...lists) {
  const taken = new Map();
  for (const list of lists) for (const g of list || []) if (!taken.has(g.frame)) taken.set(g.frame, g);
  return [...taken.values()].sort((a, b) => a.frame - b.frame);
}
