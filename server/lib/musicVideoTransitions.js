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

export const MUSIC_VIDEO_TRANSITIONS = Object.freeze(['vhs-glitch', 'channel-change', 'vhs-tracking', 'vhs-dropout', 'camera-flash', 'color-block', 'vhs-rewind',
  'film-burn', 'light-leak', 'gate-jump', 'shutter', 'film-scratches', 'color-split']);

export const MUSIC_VIDEO_TRANSITION_LABELS = Object.freeze({
  'vhs-glitch': 'VHS glitch',
  'channel-change': 'Channel change',
  'vhs-tracking': 'Tracking roll',
  'vhs-dropout': 'Dropout flash',
  'camera-flash': 'Camera flash',
  'color-block': 'Color blocks',
  'vhs-rewind': 'Rewind / fast-forward',
  'film-burn': 'Film burn',
  'light-leak': 'Light leak',
  'gate-jump': 'Gate jump',
  'shutter': 'Shutter',
  'film-scratches': 'Film scratches',
  'color-split': 'Color split',
});

// A shot also carries glitches at any moment inside it (`scene.glitches`):
// `{ atSec, style, lengthSec?, strength?, everySec?, count?, color?, edge? }`,
// `atSec` counted from the shot's start and `lengthSec` stretching the style's
// frames (unset plays them once). `strength` (0..1, absent = 1) scales the
// effect and 0 switches it off; `count` plays it that many times `everySec`
// apart on the song's clock, never past the shot. A light leak also takes a
// `color` (#rrggbb) and the `edge` it washes in from. Every one of these is
// optional, so an effect saved before them plays exactly as it did.
export const MUSIC_VIDEO_SHOT_GLITCH_LIMIT = 8;
export const MUSIC_VIDEO_GLITCH_LENGTHS = Object.freeze([0.125, 0.25, 0.5, 1, 2]);
export const MUSIC_VIDEO_GLITCH_REPEAT_LIMIT = 64;
export const MUSIC_VIDEO_GLITCH_REPEAT_SEC = Object.freeze({ min: 0.125, max: 30 });
export const MUSIC_VIDEO_GLITCH_EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);
// The styles that take a color and an entry edge.
export const MUSIC_VIDEO_TINTED_GLITCHES = Object.freeze(['light-leak']);

// Each style's frames, in order, and how many of them come before the cut
// (`lead`, the outgoing shot's last frames). Per frame:
//   shift   whole-frame horizontal slip (signed fraction of width)
//   roll    whole-frame vertical roll (signed fraction of height), a TV losing vertical hold
//   tears   bands slipped sideways: { y, h } fractions of height, shift of width
//   chroma  colour fringe width (fraction of width)
//   bright  brightness multiplier; sat a saturation multiplier
//   noise   snow strength: 0..1 over the picture, up to 1.6 for a dead channel's static
//   lines   scanline darkness, 0..1
//   bar     a bright tracking band { y, h, alpha }; bars, several thin ones
//   smears  bands slipped sideways and smeared: { y, h } fractions of height,
//           shift of width, blur the horizontal smear (a fraction of width)
//   swaps   macroblocks traded places: { x1, y1, x2, y2, w, h } fractions of the frame
//   blocks  solid colour macroblocks: { x, y, w, h } fractions, color 'rrggbb', alpha
//   glows   light washing in from an edge: { side: left|right|top|bottom, size }
//           (fraction of the frame), color 'rrggbb', alpha at the edge fading to none
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
  // A tape scanning in rewind or fast-forward: a wide band of noisy tracking
  // lines rolls through the middle of the picture, slipped sideways and
  // smeared, with thin bright lines along its edges.
  'vhs-rewind': {
    lead: 4,
    frames: [
      { smears: [{ y: 0.46, h: 0.08, shift: 0.06, blur: 0.008 }], bars: [{ y: 0.455, h: 0.008, alpha: 0.7 }, { y: 0.535, h: 0.006, alpha: 0.5 }],
        tears: [{ y: 0.3, h: 0.04, shift: -0.015 }], chroma: 0.006, sat: 0.85, noise: 0.3, lines: 0.3 },
      { smears: [{ y: 0.42, h: 0.14, shift: -0.08, blur: 0.012 }], bars: [{ y: 0.415, h: 0.01, alpha: 0.75 }, { y: 0.555, h: 0.006, alpha: 0.55 }],
        tears: [{ y: 0.64, h: 0.05, shift: 0.02 }], chroma: 0.01, bright: 1.05, sat: 0.8, noise: 0.45, lines: 0.35 },
      { smears: [{ y: 0.44, h: 0.16, shift: 0.1, blur: 0.016 }, { y: 0.66, h: 0.03, shift: -0.04, blur: 0.006 }],
        bars: [{ y: 0.435, h: 0.01, alpha: 0.8 }, { y: 0.5, h: 0.004, alpha: 0.45 }, { y: 0.595, h: 0.008, alpha: 0.65 }],
        chroma: 0.012, bright: 1.1, sat: 0.75, noise: 0.55, lines: 0.4 },
      { smears: [{ y: 0.4, h: 0.18, shift: -0.12, blur: 0.018 }], bars: [{ y: 0.395, h: 0.012, alpha: 0.8 }, { y: 0.575, h: 0.008, alpha: 0.7 }],
        tears: [{ y: 0.24, h: 0.04, shift: 0.02 }], chroma: 0.012, bright: 1.1, sat: 0.75, noise: 0.6, lines: 0.4 },
      { smears: [{ y: 0.43, h: 0.17, shift: 0.11, blur: 0.016 }, { y: 0.3, h: 0.03, shift: 0.03, blur: 0.006 }],
        bars: [{ y: 0.425, h: 0.01, alpha: 0.8 }, { y: 0.52, h: 0.004, alpha: 0.45 }, { y: 0.59, h: 0.01, alpha: 0.7 }],
        chroma: 0.012, bright: 1.1, sat: 0.75, noise: 0.55, lines: 0.4 },
      { smears: [{ y: 0.45, h: 0.12, shift: -0.08, blur: 0.012 }], bars: [{ y: 0.445, h: 0.008, alpha: 0.7 }, { y: 0.565, h: 0.006, alpha: 0.55 }],
        tears: [{ y: 0.7, h: 0.04, shift: -0.02 }], chroma: 0.01, bright: 1.05, sat: 0.8, noise: 0.45, lines: 0.35 },
      { smears: [{ y: 0.49, h: 0.08, shift: 0.05, blur: 0.008 }], bars: [{ y: 0.485, h: 0.006, alpha: 0.6 }],
        chroma: 0.006, sat: 0.9, noise: 0.3, lines: 0.3 },
      { smears: [{ y: 0.52, h: 0.04, shift: -0.02, blur: 0.005 }], chroma: 0.003, noise: 0.15, lines: 0.2 },
    ],
  },
  // Film burning in the gate: a hot orange glow floods in from one side, whites
  // the frame out on the cut and burns away off the other.
  'film-burn': {
    lead: 4,
    frames: [
      { glows: [{ side: 'right', size: 0.2, color: 'ff8a2a', alpha: 0.35 }], bright: 1.05 },
      { glows: [{ side: 'right', size: 0.35, color: 'ff7a1a', alpha: 0.55 }], bright: 1.1, sat: 1.1 },
      { glows: [{ side: 'right', size: 0.55, color: 'ff9a3a', alpha: 0.75 }, { side: 'left', size: 0.15, color: 'ffd27a', alpha: 0.3 }], bright: 1.2, sat: 1.1 },
      { glows: [{ side: 'right', size: 0.8, color: 'ffb050', alpha: 0.9 }], bright: 1.35 },
      { glows: [{ side: 'right', size: 1, color: 'ffc070', alpha: 0.9 }], bar: { y: 0, h: 1, alpha: 0.6 }, bright: 1.4 },
      { glows: [{ side: 'left', size: 0.8, color: 'ffb050', alpha: 0.85 }], bright: 1.3 },
      { glows: [{ side: 'left', size: 0.55, color: 'ff8a2a', alpha: 0.6 }], bright: 1.15 },
      { glows: [{ side: 'left', size: 0.3, color: 'ff6a1a', alpha: 0.4 }], bright: 1.05 },
      { glows: [{ side: 'left', size: 0.12, color: 'ff5a10', alpha: 0.2 }] },
    ],
  },
  // Stray light on the film: a soft amber and rose wash from the top corner swells and fades.
  'light-leak': {
    lead: 5,
    frames: [0.12, 0.22, 0.32, 0.42, 0.5, 0.5, 0.44, 0.36, 0.26, 0.16, 0.08].map((alpha) => ({
      glows: [{ side: 'left', size: 0.6, color: 'ff4f8a', alpha }, { side: 'top', size: 0.5, color: 'ffb347', alpha: alpha * 0.9 }],
      bright: 1 + alpha * 0.3, sat: 1.05,
    })),
  },
  // The film slipping in a projector gate: the picture jumps up a frame line,
  // its black frame bar showing, and drops back into place.
  'gate-jump': {
    lead: 2,
    frames: [
      { roll: 0.06, bright: 0.95 },
      { roll: 0.45, blocks: [{ x: 0, y: 0.43, w: 1, h: 0.05, color: '000000', alpha: 1, seam: true }], bright: 0.9, noise: 0.1 },
      { roll: -0.25, blocks: [{ x: 0, y: 0.73, w: 1, h: 0.05, color: '000000', alpha: 1, seam: true }], bright: 0.95 },
      { roll: 0.05 },
      { bright: 1.05, chroma: 0.002 },
    ],
  },
  // A camera shutter blinking over the cut: black closes in from top and bottom and opens again.
  shutter: {
    lead: 3,
    frames: [0.18, 0.38, 0.5, 0.5, 0.32, 0.12].map((v) => ({
      blocks: [{ x: 0, y: 0, w: 1, h: v, color: '000000', alpha: 1, anchor: 'top' }, { x: 0, y: 1 - v, w: 1, h: v, color: '000000', alpha: 1, anchor: 'bottom' }],
    })),
  },
  // Worn print: thin scratches run down the frame, dust specks flash and the exposure flickers.
  'film-scratches': {
    lead: 2,
    frames: [
      { blocks: [{ x: 0.23, y: 0, w: 0.003, h: 1, color: 'ffffff', alpha: 0.55 }, { x: 0.61, y: 0.3, w: 0.008, h: 0.012, color: '000000', alpha: 0.8 }], bright: 1.08, sat: 0.9 },
      { blocks: [{ x: 0.24, y: 0, w: 0.003, h: 1, color: 'ffffff', alpha: 0.45 }, { x: 0.71, y: 0, w: 0.002, h: 1, color: '000000', alpha: 0.5 },
        { x: 0.38, y: 0.66, w: 0.01, h: 0.014, color: 'ffffff', alpha: 0.8 }], bright: 0.93, sat: 0.9 },
      { blocks: [{ x: 0.72, y: 0, w: 0.002, h: 1, color: '000000', alpha: 0.45 }, { x: 0.15, y: 0.2, w: 0.006, h: 0.01, color: '000000', alpha: 0.8 },
        { x: 0.82, y: 0.78, w: 0.008, h: 0.012, color: '000000', alpha: 0.75 }], bright: 1.06, sat: 0.9 },
      { blocks: [{ x: 0.46, y: 0, w: 0.003, h: 1, color: 'ffffff', alpha: 0.5 }, { x: 0.55, y: 0.45, w: 0.012, h: 0.016, color: 'ffffff', alpha: 0.75 }], bright: 0.95, sat: 0.9 },
      { blocks: [{ x: 0.47, y: 0, w: 0.002, h: 1, color: 'ffffff', alpha: 0.35 }, { x: 0.3, y: 0.86, w: 0.007, h: 0.01, color: '000000', alpha: 0.7 }], bright: 1.04, sat: 0.95 },
      { blocks: [{ x: 0.66, y: 0.12, w: 0.006, h: 0.01, color: '000000', alpha: 0.7 }], bright: 0.98 },
    ],
  },
  // A tube camera losing convergence: red and blue pull apart and snap back.
  'color-split': {
    lead: 2,
    frames: [
      { chroma: 0.03, shift: 0.004, bright: 1.03 },
      { chroma: 0.055, shift: -0.008, bright: 1.06, sat: 1.15 },
      { chroma: 0.04, shift: 0.006, bright: 1.04, sat: 1.1 },
      { chroma: 0.02, bright: 1.02 },
      { chroma: 0.008 },
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
    .map((g) => {
      const strength = Number.isFinite(g.strength) ? Math.min(1, Math.max(0, g.strength)) : 1;
      const repeats = Number.isInteger(g.count) && g.count > 1 && Number.isFinite(g.everySec) && g.everySec >= MUSIC_VIDEO_GLITCH_REPEAT_SEC.min;
      const tinted = MUSIC_VIDEO_TINTED_GLITCHES.includes(g.style);
      return {
        atSec: scene.startSec + Math.min(Math.max(0, g.atSec), Math.max(0, span - 0.001)),
        style: g.style,
        ...(Number.isFinite(g.lengthSec) && g.lengthSec > 0 ? { lengthSec: g.lengthSec } : {}),
        ...(strength < 1 ? { strength } : {}),
        ...(repeats ? { count: Math.min(g.count, MUSIC_VIDEO_GLITCH_REPEAT_LIMIT), everySec: Math.min(g.everySec, MUSIC_VIDEO_GLITCH_REPEAT_SEC.max) } : {}),
        ...(tinted && typeof g.color === 'string' && /^#[0-9a-f]{6}$/i.test(g.color) ? { color: g.color.slice(1).toLowerCase() } : {}),
        ...(tinted && MUSIC_VIDEO_GLITCH_EDGES.includes(g.edge) ? { edge: g.edge } : {}),
      };
    })
    // Strength zero switches an effect off without losing its other settings.
    .filter((g) => g.strength !== 0);
}

/** A hex `rrggbb` moved `amount` of the way toward white. */
const lighten = (color, amount) => [0, 2, 4]
  .map((i) => Math.round(parseInt(color.slice(i, i + 2), 16) + (255 - parseInt(color.slice(i, i + 2), 16)) * amount).toString(16).padStart(2, '0')).join('');

// A style frame at a fraction of its strength: every slip, roll, fringe, snow and
// wash moves toward a clean frame, and shapes keep their place. A gate jump's
// frame line follows its smaller roll; a shutter closes less far.
function scaledGlitchParams(p, k) {
  const out = { ...p };
  for (const key of ['shift', 'roll', 'chroma', 'noise', 'lines']) if (p[key] != null) out[key] = p[key] * k;
  for (const key of ['bright', 'sat']) if (p[key] != null) out[key] = 1 + (p[key] - 1) * k;
  const faded = (list) => list.map((x) => ({ ...x, alpha: x.alpha * k }));
  if (p.tears) out.tears = p.tears.map((t) => ({ ...t, shift: t.shift * k }));
  if (p.smears) out.smears = p.smears.map((sm) => ({ ...sm, shift: sm.shift * k, blur: (sm.blur || 0) * k }));
  if (p.bar) out.bar = { ...p.bar, alpha: p.bar.alpha * k };
  if (p.bars) out.bars = faded(p.bars);
  if (p.glows) out.glows = faded(p.glows);
  if (p.blocks) {
    out.blocks = p.blocks.map((b) => {
      if (b.seam) return { ...b, y: Math.max(0, (out.roll > 0 ? out.roll : 1 + out.roll) - b.h * 0.4) };
      if (b.anchor) return { ...b, h: b.h * k, y: b.anchor === 'bottom' ? 1 - b.h * k : 0 };
      return { ...b, alpha: b.alpha * k };
    });
  }
  return out;
}

/**
 * The parameters one glitch frame paints (`{ frame, style, index, strength?,
 * color?, edge? }`): the style's frame as declared, with a light leak's color
 * and entry edge applied and scaled by its strength. Both players paint this.
 */
export function glitchFrameParams(g) {
  const base = MUSIC_VIDEO_TRANSITION_STYLES[g?.style]?.frames[g.index];
  if (!base) return null;
  let p = base;
  if ((g.color || g.edge) && p.glows) {
    // The leak's own color at its strongest wash and a paler core beside it, both from its edge.
    p = { ...p, glows: p.glows.map((glow, i) => ({ ...glow, ...(g.edge ? { side: g.edge } : {}), ...(g.color ? { color: i === 0 ? g.color : lighten(g.color, 0.45) } : {}) })) };
  }
  return Number.isFinite(g.strength) && g.strength < 1 ? scaledGlitchParams(p, Math.max(0, g.strength)) : p;
}

// The look keys a glitch frame carries past its style and index, kept on every repeated frame.
const glitchLook = (g) => ({
  ...(g.strength != null ? { strength: g.strength } : {}),
  ...(g.color ? { color: g.color } : {}),
  ...(g.edge ? { edge: g.edge } : {}),
});

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
  return hit ? { ...hit, params: glitchFrameParams(hit) } : null;
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

/**
 * A style frame's glows, `{ side, size, color, alpha }`: light at `alpha` on its
 * `side` edge that fades evenly to nothing `size` (a fraction of the frame) in.
 * Both players paint each as one smooth ramp, so a glow looks the same in each.
 */
export function edgeGlows(glows) {
  return (Array.isArray(glows) ? glows : [])
    .map((g) => ({ side: g.side, size: Math.min(1, Math.max(0, g.size || 0)), color: g.color, alpha: Math.min(1, Math.max(0, g.alpha || 0)) }))
    .filter((g) => g.size > 0 && g.alpha > 0);
}

// One `geq` per glow: each pixel moves toward the glow's color by the ramp's strength there.
// The color goes in as limited-range BT.601 YUV, as drawbox paints it.
function glowFilter({ side, size, color, alpha }) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const yuv = [
    16 + 65.481 * r + 128.553 * g + 24.966 * b,
    128 - 37.797 * r - 74.203 * g + 112 * b,
    128 + 112 * r - 93.786 * g - 18.214 * b,
  ].map((v) => Math.round(v));
  const from = side === 'left' ? 'X/W' : side === 'right' ? '(W-1-X)/W' : side === 'top' ? 'Y/H' : '(H-1-Y)/H';
  const strength = `${num(alpha)}*max(0,1-${from}/${num(size)})`;
  const [lum, cb, cr] = yuv.map((v) => `'p(X,Y)+(${v}-p(X,Y))*${strength}'`);
  return `geq=lum=${lum}:cb=${cb}:cr=${cr}`;
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
 * The ffmpeg filter chain (comma-joined, one stream in and one out) that paints
 * `glitches` on a `width`x`height` yuv420p stream counting frames from 0, or null
 * when there are none. Each filter is enabled only on its frames, so every other
 * frame passes through untouched and the stream keeps its length. A smeared band
 * splits off a strip and lays it back with internal `smr…` labels, so the chain
 * appears once in a filter graph.
 */
export function musicVideoTransitionFilter(glitches, { width, height }) {
  if (!Array.isArray(glitches) || glitches.length === 0) return null;
  const groups = new Map();
  for (const g of glitches) {
    const key = `${g.style}:${g.index}:${g.strength ?? 1}:${g.color || ''}:${g.edge || ''}`;
    if (!groups.has(key)) groups.set(key, { params: glitchFrameParams(g), frames: [] });
    groups.get(key).frames.push(g.frame);
  }
  const chain = [];
  let smearId = 0;
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
    // A smeared band: slipped like a tear, then cut out, blurred sideways and laid back on its frames.
    for (const sm of p.smears || []) {
      const y = rows(sm.y);
      const h = Math.min(rows(sm.h), height - y);
      if (h < 2) continue;
      add(slip(sm.shift * width, y, h, width));
      const sigma = Math.max(0.5, Math.round((sm.blur || 0) * width * 10) / 10);
      const id = `smr${smearId++}`;
      chain.push(`split[${id}a][${id}b];[${id}b]crop=w=${width}:h=${h}:x=0:y=${y},gblur=sigma=${num(sigma)}:sigmaV=0.5${enable}[${id}c];`
        + `[${id}a][${id}c]overlay=x=0:y=${y}${enable}`);
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
    for (const glow of edgeGlows(p.glows)) add(glowFilter(glow));
    for (const bar of [...(p.bar ? [p.bar] : []), ...(p.bars || [])]) {
      add(`drawbox=x=0:y=${rows(bar.y)}:w=iw:h=${Math.max(2, rows(bar.h))}:color=white@${num(bar.alpha)}:t=fill`);
    }
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
 * the style's frames over that many frames, holding each a little longer; a `count` plays it again
 * every `everySec`, and its `strength`, `color` and `edge` ride on each frame for `glitchFrameParams`.
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
      const look = glitchLook(g);
      // Each repeat lands on the song clock, so an excerpt or a scrub meets it on the full render's frame.
      for (let r = 0; r < (g.count || 1); r++) {
        // The frame showing at that moment, as the player counts it.
        const start = Math.floor((g.atSec + r * (g.everySec || 0)) * fps + 1e-6);
        for (let i = 0; i < length; i++) {
          if (onScreen(start + i)) out.push({ frame: start + i, style: g.style, index: Math.floor((i * count) / length), ...look });
        }
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
