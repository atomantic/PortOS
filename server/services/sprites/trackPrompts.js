/**
 * Per-track image-to-video prompt resolution (#3136, #3152): one call answering
 * "what do I send the provider for this track?". The built-in `walk` resolves
 * through the compiled builder; every other track through its stored
 * `promptTemplate`. An unknown id throws (same boundary as `getAnimationTrack`):
 * silently sending the walk prompt for a mis-keyed track would render a gait loop
 * and pass every later check.
 *
 * Exactly one prompt source per track: dispatch keys on `row.builtin`, not
 * compiled-first-then-template, or a user's edit to a seeded template would
 * silently do nothing. `trackPrompts.test.js` pins the seeded templates
 * byte-for-byte against the compiled `buildScannerPrompt`/`buildAmbientVideoPrompt`
 * (kept exported from `prompts.js` as that reference, not a live fallback).
 *
 * Separate from `prompts.js` (pure prompt TEXT catalog) so wording tests stay
 * routing-free. Pure apart from the cached store read in `animationTrackStore.js`.
 */

import { buildWalkVideoPrompt, applyCorrection, keyColorPhrase } from './prompts.js';
import { WALK_TRACK, isAnimationTrack } from './animationTracks.js';
import { getEffectiveAnimationTracks } from './animationTrackStore.js';

// Compiled builders (`walk` alone since #3152). Each takes the same superset
// argument object and reads only what it needs.
const TRACK_VIDEO_PROMPTS = Object.freeze({
  [WALK_TRACK]: buildWalkVideoPrompt,
});

/**
 * Placeholders a stored `promptTemplate` may interpolate. `chromaKey` is the raw
 * hex and `chromaKeyPhrase` the named form ("magenta (#FF00FF)"): both exist
 * because the seeded scanner and ambient wordings embed different ones.
 * `correctionPrompt` is deliberately NOT a placeholder: `applyCorrection` frames
 * it as an override of the base wording, and mid-sentence interpolation would
 * bury it (#3216).
 */
const templateVariables = ({ name, kind, direction, chromaKey }) => ({
  name: name ?? '',
  kind: kind ?? '',
  direction: direction ?? '',
  chromaKey: chromaKey ?? '',
  chromaKeyPhrase: keyColorPhrase(chromaKey),
});

/**
 * Interpolate `{{variable}}` placeholders. An UNKNOWN placeholder stays literal:
 * the user sees the prompt back, and a visible `{{drection}}` is a findable typo
 * where a silently-dropped clause reads as the model ignoring them. Whitespace
 * inside the braces is tolerated.
 */
export function renderPromptTemplate(template, args) {
  const vars = templateVariables(args || {});
  return String(template).replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (match, key) => (
    Object.hasOwn(vars, key) ? vars[key] : match
  ));
}

/** The image-to-video instruction for one track's render. Throws on an unknown track. */
export function buildTrackVideoPrompt(trackId, args) {
  const tracks = getEffectiveAnimationTracks();
  const row = isAnimationTrack(trackId, tracks) ? tracks[trackId] : undefined;
  if (!row) {
    throw new Error(
      `No image-to-video prompt is registered for animation track '${String(trackId)}' `
      + `— known tracks: ${Object.keys(tracks).join(', ')}.`,
    );
  }
  if (!row.builtin) {
    return applyCorrection(
      renderPromptTemplate(row.promptTemplate, args),
      args?.correctionPrompt,
      // Animation wording overrides the template's preserve-the-source clauses
      // without cancelling its motion.
      { subject: 'source image', output: 'animation' },
    );
  }
  const build = TRACK_VIDEO_PROMPTS[trackId];
  // Unreachable today (`walk` is the only builtin); report a registry/code
  // mismatch by name instead of `undefined(args)`.
  if (!build) {
    throw new Error(`Builtin animation track '${String(trackId)}' has no compiled image-to-video prompt builder.`);
  }
  return build(args);
}

/**
 * The i2v prompt for `trackId`, or `null` for an unknown track (a run may name a
 * track a newer peer wrote or the user deleted); for the provenance rebuild in
 * `assetPrompt.js`. Any other failure (bad template, builder mismatch) still throws.
 */
export function tryBuildTrackVideoPrompt(trackId, args) {
  if (!isAnimationTrack(trackId, getEffectiveAnimationTracks())) return null;
  return buildTrackVideoPrompt(trackId, args);
}
