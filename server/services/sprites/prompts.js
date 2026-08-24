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
// Moved to lib/spriteVocabulary.js in #4901; re-exported for existing callers.
export { SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS } from '../../lib/spriteVocabulary.js';
import { SPRITE_DIRECTIONS } from '../../lib/spriteVocabulary.js';

// Directions that get a derived anchor. `south` is never generated — the
// frozen main reference IS the south anchor.


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

// Reference candidates are reviewed before their foreground is normalized onto
// the locked square frame, so generation itself must hold the sprite canvas.
export const SPRITE_REFERENCE_CANVAS_SIZE = 1024;

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
// The four 45-degree facings. Occlusion at 45 degrees is partial, not absolute —
// a front hip bag on the near side still peeks past the hip in a three-quarter
// rear view. Telling the model to erase it outright there makes gear pop in and
// out as the sprite rotates through the 8 anchors, so these facings get hedged
// wording while the cardinals keep the absolute form.
const THREE_QUARTER = new Set(['south-east', 'north-east', 'north-west', 'south-west']);

/**
 * One or two sentences describing what a given facing occludes — the concrete
 * rule that stops the model from mirroring the front view. Exported so the sheet
 * prompt, the derive-anchor prompt, and the tests all read from one vocabulary.
 */
export function viewGeometryClause(direction) {
  const partial = THREE_QUARTER.has(direction);
  const parts = [];
  if (REAR_FACING.has(direction)) {
    const hidden = partial
      ? 'almost entirely hidden by the body — at most a sliver shows past the near hip, along '
        + 'with the parts that genuinely wrap around, such as a strap crossing the back or the '
        + 'rear of a waist belt'
      : 'hidden by the body and must not be drawn — only the parts that genuinely wrap around, '
        + 'such as a strap crossing the back or the rear of a waist belt, stay visible';
    parts.push(
      `This angle is behind the character: ${FRONT_GEAR} is ${hidden}. Draw the back of the head, `
      + 'hair and garment: no face, no eyes, no front closures, buttons, zippers or chest emblems.',
    );
  } else if (FRONT_FACING.has(direction)) {
    parts.push(`This angle is in front of the character: ${BACK_GEAR} is ${partial
      ? 'mostly hidden by the body — at most its shoulder straps and a sliver past the far '
        + 'shoulder show'
      : 'hidden by the body — at most its shoulder straps show over the front'}.`);
  }
  const near = RIGHT_SIDE_TO_VIEWER.has(direction) ? 'right'
    : (LEFT_SIDE_TO_VIEWER.has(direction) ? 'left' : null);
  if (near) {
    const far = near === 'right' ? 'left' : 'right';
    parts.push(partial
      ? `The viewer sees more of the character's ${near} side, so ${near}-side gear reads clearly `
        + `and ${far}-side gear is mostly occluded by the torso.`
      : `The viewer sees the character's ${near} side, so ${near}-side gear reads fully and `
        + `${far}-side gear is occluded by the torso.`);
  }
  return parts.join(' ');
}

// The sheet's candidate/asset id — the `anchorIdForDirection` analogue for the
// one reference artifact that has no direction. Lives here with the other
// target vocabulary so validation.js and the services share one spelling.
export { TURNAROUND_ID } from '../../lib/spriteVocabulary.js';

// --- Corrections (#2964 / #3134, made to actually land by #3216) -------------
//
// `subject` names the ATTACHED image/clip the render derives from ("turnaround",
// "reference", "source image") so each surface reads naturally while the
// instruction shape stays identical everywhere.
//
// Why the original single trailing sentence didn't work: every body pins the
// render to the attachment — an anchor does it in three separate sentences ("keep
// accessories/straps on the same anatomical side as the attached reference",
// "treat the turnaround panels as the source of truth", plus the per-facing
// occlusion rule). A note asking to CHANGE one of those ("hip bag should be on
// the other leg") contradicts the bulk of the prompt, and the model sided with
// the bulk: the corrected re-roll came back identical to the candidate the user
// had just rejected. Two things were needed, both of them:
//
//   1. State precedence. Position last is not authority.
//   2. Target the OUTPUT. "Apply this over the attached reference" pointed the
//      model at a frozen, usually-correct sheet — inviting "nothing to do". The
//      user is describing a defect in the PREVIOUS RENDER.
//
// So the note is stated twice: a lead-in that frames the render before any
// preservation rule is read, and a closing override. One mention buried in a
// ~200-word instruction is exactly what got ignored.
//
// If this ever stops holding, the next step is structural, NOT a third round of
// stronger adjectives: suppress the body clauses the note contradicts (compare
// `refineComicPageRender` in services/pipeline/comicPages.js, which merges the
// user's instruction into the stored prompt so no clause disagrees with it).

// Users type notes as fragments, and both halves quote the note mid-paragraph, so
// terminate it — otherwise it runs into the next sentence ("…other leg Make that
// fix…") and the boundary between the user's words and ours disappears.
const asSentence = (note) => (/[.!?]$/.test(note) ? note : `${note}.`);

/**
 * Per-medium copy for the two halves. The medium is explicit rather than shared
 * because the sandwich has to overrule the body's pin-to-the-attachment clauses
 * WITHOUT also overruling its motion instruction: "keep everything else
 * identical [to the attached still]" is exactly right for an image and exactly
 * wrong for an image-to-video render, where every frame after the first is
 * SUPPOSED to differ from the attachment. A video surface inheriting the image
 * wording is told to hold still — trading the ignored-correction bug for a
 * frozen clip. `keepRest` closes the lead-in's sentence; `keepRestClosing`
 * closes the override's.
 */
const CORRECTION_MEDIA = Object.freeze({
  image: {
    noun: 'image',
    keepRest: 'and keep everything else identical',
    keepRestClosing: (subject) => `everything it does not mention stays as the attached ${subject} shows it`,
  },
  animation: {
    noun: 'animation',
    keepRest: 'and leave the rest of the animation exactly as the instructions below describe it',
    keepRestClosing: (subject) => 'the motion described above still happens in full, and every other detail of '
      + `identity and appearance stays as the attached ${subject} shows it`,
  },
});

const leadInFor = (note, subject, medium) => (
  `This is a corrected re-render: a previous attempt at this exact ${medium.noun} was rejected. `
  + `Required fix: ${note} Make that fix in the ${medium.noun} you produce. It takes priority over any `
  + `instruction below to match or preserve the attached ${subject} — change what the fix names, `
  + `${medium.keepRest}. `
);

const overrideFor = (note, subject, medium) => (
  ` Required fix (highest priority — this overrides any conflicting instruction above): ${note}`
  + ` The previous render was rejected for exactly this, so an ${medium.noun} that does not visibly`
  + ' reflect this fix is a failed render. Change only what the fix names;'
  + ` ${medium.keepRestClosing(subject)}.`
);

/**
 * Wrap a built prompt body in the correction sandwich — the ONLY way a builder
 * takes a correction. The two halves stay private so a surface cannot ship with
 * one of them wired and not the other; that half-wired state is precisely what
 * reads to the user as "the model ignored my feedback".
 *
 * `target` names both what the render DERIVES from (`subject` — "turnaround",
 * "reference", "source image", so each surface reads naturally) and what it
 * PRODUCES (`output` — a key of `CORRECTION_MEDIA`). Both are required and named
 * at every call site: an optional medium defaulting to `image` is how a video
 * builder silently ends up with wording that forbids motion.
 *
 * An absent, blank, or non-string note returns `body` untouched. That is the hard
 * contract every surface depends on: a whitespace-only note must leave the prompt
 * byte-identical to a blind regenerate.
 */
export function applyCorrection(body, correctionPrompt, { subject, output } = {}) {
  const medium = CORRECTION_MEDIA[output];
  // Fail fast, and BEFORE the blank-note early return — a builder that names an
  // unknown medium has to break on the blind path too, not lie dormant until a
  // user actually types a note.
  if (!medium) {
    throw new TypeError(
      `applyCorrection: unknown output medium "${output}" `
      + `(expected ${Object.keys(CORRECTION_MEDIA).join(' | ')})`,
    );
  }
  const raw = typeof correctionPrompt === 'string' ? correctionPrompt.trim() : '';
  if (!raw) return body;
  const note = asSentence(raw);
  return leadInFor(note, subject, medium) + body + overrideFor(note, subject, medium);
}

/**
 * Stage-0 prompt (issue #2979): the character turnaround sheet — the identity
 * root every later render descends from. One image, `TURNAROUND_VIEWS.length`
 * panels of the SAME character, so the model that later draws a back or side
 * anchor has actually been shown that side instead of inventing it.
 */
export function buildTurnaroundPrompt({ name, designPrompt, chromaKey, correctionPrompt }) {
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
  return applyCorrection(
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
    // This sentence governs WHICH SIDE and WHERE IN FRAME only; whether the item
    // is visible at all is deferred to the per-panel rules. Stating visibility
    // here too would contradict them (a front-worn bag is placed "toward the
    // viewer's right in the back panel" by this rule but erased by Panel 3's).
    + 'Every accessory (bag, strap, pouch, pocket, weapon) stays on the SAME anatomical side of '
    + 'the body in every panel — an item worn on the character\'s right hip is never moved to '
    + 'the left hip. Wherever it is visible, the turn shifts it across the frame: toward the '
    + 'viewer\'s left in the front panel, toward the viewer\'s right in the back panel. Whether '
    + 'it is visible at all in a given panel is decided by that panel\'s rule below. '
    + `${panelRules} `
    + 'Flat non-isometric pixel-art game sprite '
    + `reference on a plain exact ${keyColorPhrase(chromaKey)} background on a square 1:1 canvas. No panel borders, `
    + 'labels, captions, arrows, grid, shadows, scenery, wireframe, or extra characters. '
    + 'Return exactly one PNG.',
    correctionPrompt,
    { subject: 'turnaround', output: 'image' },
  );
}

// Shared preamble for a render seeded from the locked turnaround sheet: the
// init image is a multi-figure sheet, so the model must be told to read ONE
// panel and emit ONE figure — otherwise it happily returns another sheet.
// The sheet only carries the four cardinal panels, so a three-quarter facing has
// no panel of its own. Naming one anyway ("read the panel that shows a
// three-quarter rear view…") points the model at a panel that isn't there and it
// silently picks one — the invent-the-unseen-side failure the sheet exists to
// prevent. Send those facings to the two cardinals they sit between instead.
const INTERPOLATE_FROM = {
  'south-east': ['south', 'east'],
  'north-east': ['north', 'east'],
  'north-west': ['north', 'west'],
  'south-west': ['south', 'west'],
};

const fromTurnaroundClause = (direction) => {
  const pair = INTERPOLATE_FROM[direction];
  const read = pair
    ? 'The sheet has no panel at this exact angle: read the panels showing the character '
      + `${REFERENCE_FACING[pair[0]]} and ${REFERENCE_FACING[pair[1]]}, and interpolate between `
      + 'them rather than inventing a side the sheet never shows'
    : `Read the panel that shows the character ${REFERENCE_FACING[direction] || direction}`;
  return (
    `The attached image is a turnaround model sheet showing the same character from `
    + `${TURNAROUND_VIEWS.length} angles. ${read}, and `
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
 * derived from the locked sheet like any other direction. `correctionPrompt`
 * (#3134) is the optional re-roll note — the same additive correction the
 * turnaround and anchors already take, so a bad main can be described rather
 * than only re-rolled blind.
 */
export function buildMainReferencePrompt({ name, designPrompt, chromaKey, correctionPrompt, fromTurnaround = false }) {
  const description = (typeof designPrompt === 'string' && designPrompt.trim())
    ? designPrompt.trim()
    : 'Use the attached visual reference as the character design.';
  return applyCorrection(
    (fromTurnaround ? fromTurnaroundClause('south') : '')
    + `Create the frozen walk-south identity reference for a game character named ${name}. `
    + `Character direction: ${description} `
    + 'Draw exactly one full-body figure facing the viewer in a neutral standing pose, feet '
    + 'level on one baseline, arms relaxed, with a clear readable silhouette. Match the '
    + 'attached visual reference when provided. Preserve physical-left and physical-right '
    + `accessories exactly. ${geometryRule('south')}Flat non-isometric pixel-art game sprite reference, centered on `
    + `a plain exact ${keyColorPhrase(chromaKey)} background on a square 1:1 canvas. No motion, labels, grid, shadows, scenery, `
    + 'wireframe, or extra figures. Return exactly one PNG.',
    correctionPrompt,
    // The main derives from the sheet when there is one, so name the sheet as
    // the attachment the untouched details come from; a legacy record has only
    // its own reference attached.
    { subject: fromTurnaround ? 'turnaround' : 'reference', output: 'image' },
  );
}

/**
 * The identity root for a place/object ambient loop. Unlike a character it has
 * no facing or turnaround: this one locked still is both the idle cell and the
 * image-to-video source, so it must be legible on its own. `correctionPrompt`
 * (#3134) is additive — distinct from `designPrompt`, which REPLACES the design
 * outright: a correction keeps the design and fixes one thing about the render.
 */
export function buildAmbientReferencePrompt({ name, kind, designPrompt, chromaKey, correctionPrompt }) {
  const description = (typeof designPrompt === 'string' && designPrompt.trim())
    ? designPrompt.trim()
    : 'Use the attached visual reference as the design.';
  return applyCorrection(
    `Create one centered game-sprite ${kind} named ${name}. Design: ${description} `
    + 'Show its at-rest state with a clear readable silhouette. Match the attached visual reference when provided. '
    + `Use a plain exact ${keyColorPhrase(chromaKey)} background on a square 1:1 canvas. No people, scenery, text, labels, grid, `
    + 'camera angle, shadows, wireframe, or extra objects. Return exactly one PNG.',
    correctionPrompt,
    { subject: 'reference', output: 'image' },
  );
}

/**
 * Ambient image-to-video instruction: preserve the still while moving only its
 * natural loop detail. `correctionPrompt` (#3134) describes what the previous
 * loop got wrong (e.g. "the branches barely move" / "the flame drifts off the
 * trunk") so a re-roll diverges instead of reproducing it.
 */
export function buildAmbientVideoPrompt({ name, kind, chromaKey, correctionPrompt }) {
  return applyCorrection(
    `The source image is the locked at-rest ${kind} sprite ${name}. Animate one subtle seamless ambient loop `
    + '(for example wind, water, flame, or a gentle flicker appropriate to the source), then return to the exact starting pose. '
    + 'Preserve its identity, silhouette, palette, scale, and centered ground position. Use a locked camera and an exactly '
    + `uniform non-emissive ${keyColorPhrase(chromaKey)} background only as a compositing matte: no scenery, text, labels, `
    + 'camera movement, cuts, added objects, or people.',
    correctionPrompt,
    { subject: 'source image', output: 'animation' },
  );
}

/**
 * Stage-3 motion prompt (issue #2897): the walk-video instruction handed to
 * the grok i2v lane along with the prepared transparent anchor. PortOS's
 * grok video wrapper (videoGen/grok.js buildGrokVideoPrompt) owns the tool
 * mechanics (one image_to_video call, save one MP4), so this carries only
 * the identity/matte/motion constraints — the source pipeline's
 * `animation_prompt` minus its CLI/tool scaffolding.
 *
 * `correctionPrompt` (#3134) is the optional re-roll note describing what the
 * previous clip got wrong (e.g. "the legs barely lift", "the cape clips through
 * the pack") — same additive contract as the reference builders.
 */
export function buildWalkVideoPrompt({ name, direction, chromaKey, correctionPrompt }) {
  const facing = REFERENCE_FACING[direction] || direction;
  return applyCorrection(
    `The source image is the locked directional identity anchor for the game character ${name}, `
    + `${facing}. Animate a walk-in-place loop, walking ${direction}. `
    + 'Preserve identity, palette, proportions, facing, and physical-left and physical-right '
    + 'accessories exactly. Do not turn the character and do not add gear that the source image '
    + 'does not show — anything hidden behind the body there stays hidden for the whole loop. '
    + 'Use a locked camera and an exactly uniform, non-emissive '
    + `${keyColorPhrase(chromaKey)} background that acts only as a compositing matte: no rim light, `
    + 'bounce light, reflections, color cast, glow, or shadow on the character. Keep a stable '
    + 'pivot and ground line with loop-friendly walk-in-place motion. No scenery, no text, no '
    + 'labels, no camera motion, no extra figures.',
    correctionPrompt,
    { subject: 'source image', output: 'animation' },
  );
}

/**
 * The named scanner action track's i2v instruction (#3134 promoted it out of
 * `services/sprites/scanner.js` so every stage's prompt lives in this one pure
 * module — which is also what lets `assetPrompt.js` rebuild a scanner run's
 * provenance with the builder that actually produced it instead of the walk's).
 *
 * The wording is unchanged from the version that lived in `scanner.js`, so an
 * existing scanner run's rebuilt provenance prompt still matches what was sent.
 */
export function buildScannerPrompt({ name, direction, chromaKey, correctionPrompt }) {
  return applyCorrection(
    `Create a short, seamless scanner action for ${name}, facing ${direction}. `
    + 'The character raises a handheld scanner, makes one deliberate sweep, then returns to the exact starting pose. '
    + `Keep the character centered, full body visible, and animate only over a solid ${chromaKey} background. `
    + 'No text, UI, scenery, camera movement, cuts, or additional characters.',
    correctionPrompt,
    { subject: 'source image', output: 'animation' },
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
  return applyCorrection(
    (fromTurnaround ? fromTurnaroundClause(direction) : '')
    + `Redraw the attached ${name} character as one `
    + `full-body figure in a neutral standing pose, ${facing}. Keep the exact same `
    + 'identity, proportions, palette, clothing, hairstyle, and accessories/straps on the '
    + 'same anatomical side as the attached reference. Treat the turnaround panels as the source of truth: '
    + 'identify each accessory\'s anatomical side and depth placement there, then draw it only where this '
    + 'facing can physically reveal it. This is a rotation of the character, '
    + `not a mirrored copy of the reference. ${geometryRule(direction)}Flat, non-isometric view; a `
    + `single centered figure on a square 1:1 canvas; plain flat ${keyColorPhrase(chromaKey)} background; no labels, no `
    + 'grid lines, no wireframe or guide colors. Return exactly one PNG.',
    correctionPrompt,
    { subject: 'reference', output: 'image' },
  );
}
