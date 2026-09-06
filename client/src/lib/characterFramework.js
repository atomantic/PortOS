/**
 * Shared narrative-character framework definitions for the client editors.
 *
 * Re-exports the canonical field list from the pure server leaf
 * `server/lib/characterFramework.js` (so the store's `editableFields`, the
 * route Zod schemas and the UI can never drift apart) and adds the editor-only
 * descriptors — label, placeholder, and per-field cap — that both cast editors
 * render:
 *
 *   - `client/src/components/universe/CharacterDetailEditor.jsx` (Universe Bible)
 *   - `client/src/components/writers-room/CharactersBible.jsx` (Writers Room),
 *     which adapts these descriptors onto the compact `BibleSection` field
 *     config rather than mounting the full universe media/voice editor.
 */
import {
  CHARACTER_ARC_TYPES,
  CHARACTER_FRAMEWORK_FIELDS,
  CHARACTER_FRAMEWORK_LIMITS,
  CHARACTER_FRAMEWORK_TEXT_FIELDS,
  CHARACTER_PSYCHOLOGY_LIMITS,
  CHARACTER_SLIDER_AXES,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
  RELATIONSHIP_LINK_TYPES,
} from '../../../server/lib/characterFramework.js';
import { BIBLE_LIMITS } from './bibleLimits.js';

export {
  CHARACTER_ARC_TYPES,
  CHARACTER_FRAMEWORK_FIELDS,
  CHARACTER_FRAMEWORK_LIMITS,
  CHARACTER_FRAMEWORK_TEXT_FIELDS,
  CHARACTER_PSYCHOLOGY_LIMITS,
  // The Three Sliders axes (#2175) — an unset axis is null, never 0.
  CHARACTER_SLIDER_AXES,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
  RELATIONSHIP_LINK_TYPES,
};

// Slider bounds, so an editor can build its control without restating 1–10.
export const CHARACTER_SLIDER_MIN = BIBLE_LIMITS.SLIDER_MIN;
export const CHARACTER_SLIDER_MAX = BIBLE_LIMITS.SLIDER_MAX;

// What the writer WANTS and fears losing. Authored beside the framework but
// stored as its own long-form field; the Universe editor renders it in its
// "Personality & motivations" section, Writers Room above the Ghost.
export const CHARACTER_MOTIVATIONS_FIELD = Object.freeze({
  name: 'motivations',
  label: 'Motivations',
  placeholder: 'what they WANT and what they fear losing',
  max: CHARACTER_FRAMEWORK_LIMITS.motivations,
});

// Ghost → Wound → Lie → Need → Want, in authoring order. The Lie is a JUDGMENT
// about a belief and stays optional; the Need may qualify that belief rather
// than be its literal opposite (see the psychology notes in storyBible.js).
export const CHARACTER_FRAMEWORK_EDITOR_FIELDS = Object.freeze([
  { name: 'ghost', label: 'Ghost (backstory wound cause)', placeholder: 'the past event that wounded them — must causally explain the Lie', max: CHARACTER_FRAMEWORK_LIMITS.ghost },
  { name: 'wound', label: 'Wound', placeholder: 'the lasting emotional damage the Ghost left', max: CHARACTER_FRAMEWORK_LIMITS.wound },
  { name: 'lie', label: 'Lie (optional judgment about a belief)', placeholder: 'state in one sentence — "I only matter if I win". Optional: the belief itself can live in the psychology section as a theory of control.', max: CHARACTER_FRAMEWORK_LIMITS.lie },
  { name: 'need', label: 'Need (internal alternative)', placeholder: 'the truth that answers the Lie — "I matter whether I win or lose". It may qualify the belief rather than be its literal opposite.', max: CHARACTER_FRAMEWORK_LIMITS.need },
  { name: 'want', label: 'Want (external goal)', placeholder: 'the concrete goal they pursue — usually conflicts with the Need', max: CHARACTER_FRAMEWORK_LIMITS.want },
]);

// Secrets are a plain string[] on the server (`cleanStringArray`), so an
// editor marshals them per row / per line rather than as prose.
export const CHARACTER_SECRETS_FIELD = Object.freeze({
  name: 'secrets',
  label: 'Secrets',
  placeholder: 'something they hide from others or themselves',
  max: BIBLE_LIMITS.SECRET_MAX,
  maxItems: BIBLE_LIMITS.SECRETS_PER_CHARACTER_MAX,
});

// Psychology profile editor descriptors (#6414), in authoring order — the same
// copy both cast editors render. `status` carries its own hint because the
// label alone reads as wealth or dominance, which it is not.
export const CHARACTER_PSYCHOLOGY_EDITOR_FIELDS = Object.freeze([
  { name: 'theoryOfControl', label: 'Theory of control (one sentence)', placeholder: 'the rule they operate by — "if I stay useful, nobody leaves"', max: CHARACTER_PSYCHOLOGY_LIMITS.theoryOfControl },
  { name: 'strategy', label: 'Strategy it motivates', placeholder: "the behavior the theory produces — \"takes on everyone else's work, never asks for anything\"", max: CHARACTER_PSYCHOLOGY_LIMITS.strategy },
  { name: 'protectiveBenefit', label: 'What it protects', placeholder: 'the real thing it keeps them from feeling or losing', max: CHARACTER_PSYCHOLOGY_LIMITS.protectiveBenefit },
  { name: 'presentCost', label: 'What it costs now', placeholder: 'the price the strategy charges in the present', max: CHARACTER_PSYCHOLOGY_LIMITS.presentCost },
  { name: 'testingPressure', label: 'Anticipated testing pressure', placeholder: 'what would put the theory under load — anticipated, not yet dramatized', max: CHARACTER_PSYCHOLOGY_LIMITS.testingPressure },
  { name: 'candidateChange', label: 'Candidate change', placeholder: 'the revision the theory might undergo if the pressure lands', max: CHARACTER_PSYCHOLOGY_LIMITS.candidateChange },
]);

// The escape-hatch explanation shown only for a non-`assessed` assessment: a
// hive, a weather front, or a deliberately opaque character is a legitimate
// answer, said out loud rather than by leaving the form blank.
export const CHARACTER_PSYCHOLOGY_NOTE_FIELD = Object.freeze({
  name: 'assessmentNote',
  label: 'Why',
  // The Universe editor has room to spell the escape hatch out; the compact
  // Writers Room row editor renders label + placeholder only.
  hint: 'Required for unknown / not-applicable. A hive, a weather front, or an intelligence with no interior is a legitimate answer — say so here rather than inventing a human interior.',
  placeholder: 'why this character has no legible theory of control, or how to read one for a nonhuman',
  max: CHARACTER_PSYCHOLOGY_LIMITS.assessmentNote,
});

export const CHARACTER_PSYCHOLOGY_DRIVE_HINTS = Object.freeze({
  survival: 'staying safe, fed, intact — physical or existential continuity',
  connection: 'being known, kept, belonged to',
  status: 'perceived value to a group — respect, standing, being counted; NOT wealth or dominance',
});

// The two leaves every drive axis carries. Labelled per axis by the editors
// (`survival desire`), so only the placeholder copy lives here.
export const CHARACTER_PSYCHOLOGY_DRIVE_LEAVES = Object.freeze([
  { name: 'desire', placeholder: 'what they reach for on this axis', max: CHARACTER_PSYCHOLOGY_LIMITS.drive },
  { name: 'fear', placeholder: 'what they are bracing against on this axis', max: CHARACTER_PSYCHOLOGY_LIMITS.drive },
]);
