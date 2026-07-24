/**
 * Sprites — reference-workflow prompt builders (issue #2896, phase 2).
 *
 * Faithful port of the source pipeline's stage-1/2 prompt contracts
 * (character_workflow.main_prompt + reference_anchors.reference_prompt),
 * genericized for PortOS: no project-specific naming, and the chroma-key
 * background color is a parameter (the source hardcoded magenta) so the
 * per-character key selected at lock time flows into every later prompt.
 *
 * Pure module — no I/O, no imports outside the sibling pure sprite modules —
 * so validation.js and the client can lean on its constants safely.
 */

// Canonical 8-direction order (the source pipeline's RUNTIME_DIRECTION_ORDER)
// — atlas row order in later phases depends on this, so keep it stable.
export const SPRITE_DIRECTIONS = [
  'south',
  'south-east',
  'east',
  'north-east',
  'north',
  'north-west',
  'west',
  'south-west',
];

// Directions that get a derived anchor. `south` is never generated — the
// frozen main reference IS the south anchor.
export const ANCHOR_DIRECTIONS = SPRITE_DIRECTIONS.filter((d) => d !== 'south');

export const anchorIdForDirection = (direction) => `walk-${direction}`;

// Per-direction facing clause — verbatim from the source pipeline.
export const REFERENCE_FACING = {
  east: 'facing due east, a strict right-facing side profile',
  west: 'facing due west, a strict left-facing side profile',
  south: 'facing the viewer (front)',
  north: 'facing directly away from the viewer (back view, no face)',
  'south-east': 'a three-quarter front view angled down and to screen-right',
  'south-west': 'a three-quarter front view angled down and to screen-left',
  'north-east': 'a three-quarter rear view angled up and to screen-right (no face)',
  'north-west': 'a three-quarter rear view angled up and to screen-left (no face)',
};

import { CHROMA_KEYS } from './chromaKey.js';

const KEY_NAMES = Object.fromEntries(CHROMA_KEYS.map((k) => [k.hex, k.name]));

/** "magenta (#FF00FF)" — the phrase both prompt templates embed. */
export function keyColorPhrase(hex) {
  const normalized = typeof hex === 'string' ? hex.toUpperCase() : '';
  const name = KEY_NAMES[normalized];
  return name ? `${name} (${normalized})` : normalized || 'magenta (#FF00FF)';
}

// Panels the turnaround sheet carries, left to right (issue #2979). Four
// canonical views — not all eight directions — so each figure keeps enough
// pixels to read: the four three-quarter facings interpolate between adjacent
// panels, and the failure this sheet exists to fix (an accessory teleporting
// between front and back, or swapping sides) is a front/back/left/right
// problem. Order is fixed; the anchor prompt tells the model which panel to
// read a given facing from.
export const TURNAROUND_VIEWS = ['south', 'east', 'north', 'west'];

// How each turnaround panel is described inside the sheet prompt.
const TURNAROUND_PANEL_LABEL = {
  south: 'front view, facing the viewer',
  east: 'right-side profile, facing due east',
  north: 'back view, facing directly away from the viewer (no face)',
  west: 'left-side profile, facing due west',
};

/**
 * Stage-0 prompt (issue #2979): the character turnaround sheet — the identity
 * root every later render descends from. One image, `TURNAROUND_VIEWS.length`
 * panels of the SAME character, so the model that later draws a back or side
 * anchor has actually been shown that side instead of inventing it.
 */
export function buildTurnaroundPrompt({ name, designPrompt, chromaKey }) {
  const description = (typeof designPrompt === 'string' && designPrompt.trim())
    ? designPrompt.trim()
    : 'Use the attached visual reference as the character design.';
  const panels = TURNAROUND_VIEWS
    .map((view, i) => `${i + 1}) ${TURNAROUND_PANEL_LABEL[view] || view}`)
    .join(', ');
  return (
    `Create a character turnaround model sheet for a game character named ${name}. `
    + `Character design: ${description} `
    + `Draw exactly ${TURNAROUND_VIEWS.length} full-body figures of the SAME character in one `
    + `image, evenly spaced left to right in this exact order: ${panels}. `
    + 'Every figure is the identical character in a neutral standing pose, arms relaxed, at '
    + 'the same scale, with feet level on one shared baseline. Identity, proportions, palette, '
    + 'clothing, hairstyle, and accessories must match across all panels, and every accessory '
    + '(bag, strap, pouch, pocket, weapon) must stay on the SAME anatomical side of the body in '
    + 'every panel — an item worn on the character\'s right hip appears on the right hip from '
    + 'the front, from behind, and in both profiles. Flat non-isometric pixel-art game sprite '
    + `reference on a plain exact ${keyColorPhrase(chromaKey)} background. No panel borders, `
    + 'labels, captions, arrows, grid, shadows, scenery, wireframe, or extra characters. '
    + 'Return exactly one PNG.'
  );
}

// Shared preamble for a render seeded from the locked turnaround sheet: the
// init image is a multi-figure sheet, so the model must be told to read ONE
// panel and emit ONE figure — otherwise it happily returns another sheet.
const fromTurnaroundClause = (facing) => (
  `The attached image is a turnaround model sheet showing the same character from `
  + `${TURNAROUND_VIEWS.length} angles. Read the panel that shows the character ${facing}, and `
  + 'take accessory placement (which anatomical side each bag, strap, pouch, or pocket sits on) '
  + 'from the panels that show that side. Do not reproduce the sheet layout: return one single '
  + 'figure, not multiple figures and not panels. '
);

/**
 * Stage-1 prompt: create the frozen walk-south identity reference from a
 * text description and/or an attached visual reference. `fromTurnaround`
 * switches the copy for the turnaround-first flow (#2979), where the main is
 * derived from the locked sheet like any other direction.
 */
export function buildMainReferencePrompt({ name, designPrompt, chromaKey, fromTurnaround = false }) {
  const description = (typeof designPrompt === 'string' && designPrompt.trim())
    ? designPrompt.trim()
    : 'Use the attached visual reference as the character design.';
  return (
    (fromTurnaround ? fromTurnaroundClause(REFERENCE_FACING.south) : '')
    + `Create the frozen walk-south identity reference for a game character named ${name}. `
    + `Character direction: ${description} `
    + 'Draw exactly one full-body figure facing the viewer in a neutral standing pose, feet '
    + 'level on one baseline, arms relaxed, with a clear readable silhouette. Match the '
    + 'attached visual reference when provided. Preserve physical-left and physical-right '
    + 'accessories exactly. Flat non-isometric pixel-art game sprite reference, centered on '
    + `a plain exact ${keyColorPhrase(chromaKey)} background. No motion, labels, grid, shadows, scenery, `
    + 'wireframe, or extra figures. Return exactly one PNG.'
  );
}

/**
 * Stage-3 motion prompt (issue #2897): the walk-video instruction handed to
 * the grok i2v lane along with the prepared transparent anchor. PortOS's
 * grok video wrapper (videoGen/grok.js buildGrokVideoPrompt) owns the tool
 * mechanics (one image_to_video call, save one MP4), so this carries only
 * the identity/matte/motion constraints — the source pipeline's
 * `animation_prompt` minus its CLI/tool scaffolding.
 */
export function buildWalkVideoPrompt({ name, direction, chromaKey }) {
  const facing = REFERENCE_FACING[direction] || direction;
  return (
    `The source image is the locked directional identity anchor for the game character ${name}, `
    + `${facing}. Animate a walk-in-place loop, walking ${direction}. `
    + 'Preserve identity, palette, proportions, facing, and physical-left and physical-right '
    + 'accessories exactly. Use a locked camera and an exactly uniform, non-emissive '
    + `${keyColorPhrase(chromaKey)} background that acts only as a compositing matte: no rim light, `
    + 'bounce light, reflections, color cast, glow, or shadow on the character. Keep a stable '
    + 'pivot and ground line with loop-friendly walk-in-place motion. No scenery, no text, no '
    + 'labels, no camera motion, no extra figures.'
  );
}

/**
 * Stage-2 prompt: derive one directional anchor from the attached reference —
 * the locked turnaround sheet (`fromTurnaround`, the #2979 standard) or, on a
 * legacy record with no sheet, the frozen main. `correctionPrompt` is optional
 * free-text the user adds when re-rolling a candidate that came out wrong (e.g.
 * "no pocket on the right sleeve") — appended as an explicit, high-priority
 * correction so the re-roll diverges from the previous render instead of
 * reproducing the same mistake.
 */
export function buildAnchorPrompt({ name, direction, chromaKey, correctionPrompt, fromTurnaround = false }) {
  const facing = REFERENCE_FACING[direction] || direction;
  const correction = (typeof correctionPrompt === 'string' && correctionPrompt.trim())
    ? ` Important correction — apply this over the attached reference: ${correctionPrompt.trim()}`
    : '';
  return (
    (fromTurnaround ? fromTurnaroundClause(facing) : '')
    + `Redraw the attached ${name} character as one `
    + `full-body figure in a neutral standing pose, ${facing}. Keep the exact same `
    + 'identity, proportions, palette, clothing, hairstyle, and accessories/straps on the '
    + 'same anatomical side as the attached reference. Flat, non-isometric view; a '
    + `single centered figure; plain flat ${keyColorPhrase(chromaKey)} background; no labels, no `
    + 'grid lines, no wireframe or guide colors. Return exactly one PNG.'
    + correction
  );
}
