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
} from '../../../server/lib/characterFramework.js';
import { BIBLE_LIMITS } from './bibleLimits.js';

export {
  CHARACTER_ARC_TYPES,
  CHARACTER_FRAMEWORK_FIELDS,
  CHARACTER_FRAMEWORK_LIMITS,
  CHARACTER_FRAMEWORK_TEXT_FIELDS,
};

// The Three Sliders axes (#2175). Mirrors `sanitizeCharacterSliders` in
// server/lib/storyBible.js — an unset axis is null, never 0.
export const CHARACTER_SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

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
