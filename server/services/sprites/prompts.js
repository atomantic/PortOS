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

/**
 * Stage-1 prompt: create the frozen walk-south identity reference from a
 * text description and/or an attached visual reference.
 */
export function buildMainReferencePrompt({ name, designPrompt, chromaKey }) {
  const description = (typeof designPrompt === 'string' && designPrompt.trim())
    ? designPrompt.trim()
    : 'Use the attached visual reference as the character design.';
  return (
    `Create the frozen walk-south identity reference for a game character named ${name}. `
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
 * Stage-2 prompt: derive one directional anchor from the attached frozen
 * main reference. `correctionPrompt` is optional free-text the user adds when
 * re-rolling a candidate that came out wrong (e.g. "no pocket on the right
 * sleeve") — appended as an explicit, high-priority correction so the re-roll
 * diverges from the previous render instead of reproducing the same mistake.
 */
export function buildAnchorPrompt({ name, direction, chromaKey, correctionPrompt }) {
  const facing = REFERENCE_FACING[direction] || direction;
  const correction = (typeof correctionPrompt === 'string' && correctionPrompt.trim())
    ? ` Important correction — apply this over the attached reference: ${correctionPrompt.trim()}`
    : '';
  return (
    `Redraw the attached ${name} character as one `
    + `full-body figure in a neutral standing pose, ${facing}. Keep the exact same `
    + 'identity, proportions, palette, clothing, hairstyle, and accessories/straps on the '
    + 'same anatomical side as the attached reference. Flat, non-isometric view; a '
    + `single centered figure; plain flat ${keyColorPhrase(chromaKey)} background; no labels, no `
    + 'grid lines, no wireframe or guide colors. Return exactly one PNG.'
    + correction
  );
}
