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

// --- View geometry (issue #3004) -------------------------------------------
// The turnaround's dominant failure mode is that the model MIRRORS the front
// figure instead of rotating the character: a hip bag worn on the FRONT of the
// hip reappears on the character's back in the north panel, a face survives
// into the back view, and profile panels show gear that the torso should be
// hiding. "Same anatomical side" alone doesn't fix it — that rule is about the
// left/right axis, and this bug is on the front/back (depth) axis. So each
// facing carries an explicit statement of what that angle actually exposes.

const FRONT_GEAR = 'gear mounted on the front of the body (a hip bag or pouch worn at the front, '
  + 'belt buckle, chest pack, front pockets, lanyard, a holster on the front of the thigh)';
const BACK_GEAR = 'gear mounted on the back of the body (backpack, quiver, a weapon sheathed '
  + 'across the back, a hood hanging down)';

// Which half of the depth axis the camera is behind, per direction.
const REAR_FACING = new Set(['north', 'north-east', 'north-west']);
const FRONT_FACING = new Set(['south', 'south-east', 'south-west']);
// Which side of the body turns toward the viewer. Facing due east the character
// looks screen-right, so the viewer stands off their RIGHT shoulder (face east,
// south is on your right); facing west it is the left side.
const RIGHT_SIDE_TO_VIEWER = new Set(['east', 'south-east', 'north-east']);
const LEFT_SIDE_TO_VIEWER = new Set(['west', 'south-west', 'north-west']);

/**
 * One sentence describing what a given facing occludes — the concrete rule that
 * stops the model from mirroring the front view. Exported so the sheet prompt,
 * the derive-anchor prompt, and the tests all read from one vocabulary.
 */
export function viewGeometryClause(direction) {
  const parts = [];
  if (REAR_FACING.has(direction)) {
    parts.push(
      `This angle is behind the character: ${FRONT_GEAR} is hidden by the body and must not be `
      + 'drawn — only the parts that genuinely wrap around, such as a strap crossing the back or '
      + 'the rear of a waist belt, stay visible. Draw the back of the head, hair and garment: no '
      + 'face, no eyes, no front closures, buttons, zippers or chest emblems.',
    );
  } else if (FRONT_FACING.has(direction)) {
    parts.push(`This angle is in front of the character: ${BACK_GEAR} is hidden by the body — at `
      + 'most its shoulder straps show over the front.');
  }
  if (RIGHT_SIDE_TO_VIEWER.has(direction)) {
    parts.push('The viewer sees the character\'s right side, so right-side gear reads fully and '
      + 'left-side gear is occluded by the torso.');
  } else if (LEFT_SIDE_TO_VIEWER.has(direction)) {
    parts.push('The viewer sees the character\'s left side, so left-side gear reads fully and '
      + 'right-side gear is occluded by the torso.');
  }
  return parts.join(' ');
}

// The sheet's candidate/asset id — the `anchorIdForDirection` analogue for the
// one reference artifact that has no direction. Lives here with the other
// target vocabulary so validation.js and the services share one spelling.
export const TURNAROUND_ID = 'turnaround';

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
  // Panels are described with the SAME facing clauses the derive prompts use
  // (`fromTurnaroundClause` below tells the model to find "the panel that shows
  // the character <facing>") — two vocabularies would let the sheet's labels
  // drift out of sync with the prompt that points into it.
  const panels = TURNAROUND_VIEWS
    .map((view, i) => `${i + 1}) ${REFERENCE_FACING[view] || view}`)
    .join(', ');
  // Per-panel geometry: what each angle exposes and what it must hide. Without
  // this the model mirrors panel 1 and every front-mounted item survives into
  // the back view (issue #3004).
  const panelRules = TURNAROUND_VIEWS
    .map((view, i) => `Panel ${i + 1} (${REFERENCE_FACING[view] || view}): ${viewGeometryClause(view)}`)
    .join(' ');
  return (
    `Create a character turnaround model sheet for a game character named ${name}. `
    + `Character design: ${description} `
    + `Draw exactly ${TURNAROUND_VIEWS.length} full-body figures of the SAME character in one `
    + `image, evenly spaced left to right in this exact order: ${panels}. `
    + 'Every figure is the identical character in a neutral standing pose, arms relaxed, at '
    + 'the same scale, with feet level on one shared baseline. Identity, proportions, palette, '
    + 'clothing, hairstyle, and accessories must match across all panels. '
    // Rotation, not reflection — stated before the per-panel rules because it is
    // the single instruction that kills the mirrored-front-view failure.
    + `The panels are one character physically rotated in place about a vertical axis through `
    + `${TURNAROUND_VIEWS.length} even steps of a full 360-degree turn. No panel is a horizontal `
    + 'flip, mirror, or copy of another panel: draw each one from the geometry that angle '
    + 'actually exposes, including the parts of the body and gear it hides. '
    // Left/right axis (unchanged rule) — now paired with the screen-position
    // consequence, so "same side" can't be satisfied by never moving the item.
    + 'Every accessory (bag, strap, pouch, pocket, weapon) stays on the SAME anatomical side of '
    + 'the body in every panel — an item worn on the character\'s right hip is on the right hip '
    + 'from the front, from behind, and in both profiles. Because the character turns, that item '
    + 'is drawn toward the viewer\'s left in the front panel and toward the viewer\'s right in '
    + 'the back panel. '
    + `${panelRules} `
    + 'Flat non-isometric pixel-art game sprite '
    + `reference on a plain exact ${keyColorPhrase(chromaKey)} background. No panel borders, `
    + 'labels, captions, arrows, grid, shadows, scenery, wireframe, or extra characters. '
    + 'Return exactly one PNG.'
  );
}

// Shared preamble for a render seeded from the locked turnaround sheet: the
// init image is a multi-figure sheet, so the model must be told to read ONE
// panel and emit ONE figure — otherwise it happily returns another sheet.
const fromTurnaroundClause = (direction) => {
  const facing = REFERENCE_FACING[direction] || direction;
  return (
    `The attached image is a turnaround model sheet showing the same character from `
    + `${TURNAROUND_VIEWS.length} angles. Read the panel that shows the character ${facing}, and `
    + 'take accessory placement (which anatomical side each bag, strap, pouch, or pocket sits on) '
    + 'from the panels that show that side. Do not reproduce the sheet layout: return one single '
    + 'figure, not multiple figures and not panels. '
  );
};

// Depth/side geometry appended to every derive prompt. The sheet can still be
// imperfect, and the derive step is a second chance to keep a front-mounted bag
// off the character's back (issue #3004).
const geometryRule = (direction) => {
  const clause = viewGeometryClause(direction);
  return clause ? `${clause} ` : '';
};

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
    (fromTurnaround ? fromTurnaroundClause('south') : '')
    + `Create the frozen walk-south identity reference for a game character named ${name}. `
    + `Character direction: ${description} `
    + 'Draw exactly one full-body figure facing the viewer in a neutral standing pose, feet '
    + 'level on one baseline, arms relaxed, with a clear readable silhouette. Match the '
    + 'attached visual reference when provided. Preserve physical-left and physical-right '
    + `accessories exactly. ${geometryRule('south')}Flat non-isometric pixel-art game sprite reference, centered on `
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
    + 'accessories exactly. Do not turn the character and do not add gear that the source image '
    + 'does not show — anything hidden behind the body there stays hidden for the whole loop. '
    + 'Use a locked camera and an exactly uniform, non-emissive '
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
    (fromTurnaround ? fromTurnaroundClause(direction) : '')
    + `Redraw the attached ${name} character as one `
    + `full-body figure in a neutral standing pose, ${facing}. Keep the exact same `
    + 'identity, proportions, palette, clothing, hairstyle, and accessories/straps on the '
    + 'same anatomical side as the attached reference. This is a rotation of the character, '
    + `not a mirrored copy of the reference. ${geometryRule(direction)}Flat, non-isometric view; a `
    + `single centered figure; plain flat ${keyColorPhrase(chromaKey)} background; no labels, no `
    + 'grid lines, no wireframe or guide colors. Return exactly one PNG.'
    + correction
  );
}
