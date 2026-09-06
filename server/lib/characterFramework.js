/**
 * Canonical narrative-character framework field list — the Ghost → Wound →
 * Lie → Want → Need chain plus the declared arc type, secrets, motivations,
 * and structured relationship links.
 *
 * A PURE LEAF (imports only `bibleLimits.js`) so three otherwise-unrelated
 * consumers can share one definition instead of three hand-mirrored copies:
 *
 *   - `server/lib/storyBible.js`      — re-exports `CHARACTER_ARC_TYPES`
 *   - `server/services/writersRoom/characters.js` — store `editableFields`
 *   - `client/src/lib/characterFramework.js` — the editor field descriptors
 *     rendered by both the Universe cast editor and the Writers Room bible
 *
 * Everything here is OPTIONAL on a character. A blank string / null / empty
 * array is the legacy shape, and clearing a field is a real authored action —
 * never treat "absent" and "present but empty" as the same thing (see the
 * absent-vs-intentionally-empty rule in AGENTS.md).
 */

import { BIBLE_LIMITS } from './bibleLimits.js';

// Declared character arc type (#2175). A positive arc overcomes the Lie and
// embraces the Truth; a negative arc is consumed by the Lie; a flat arc holds
// a truth the character already knows and changes the world around them
// instead. Unset (null) keeps the field absent for every pre-#2175 record.
// Defined here rather than in `storyBible.js` so the browser bundle can read
// the list without pulling `crypto` + `fileUtils`; `storyBible.js` re-exports
// it so every existing importer keeps working.
export const CHARACTER_ARC_TYPES = Object.freeze(['positive', 'negative', 'flat']);

// The prose half of the framework, in authoring order: what they pursue, the
// origin damage, the belief it produced, and the two competing resolutions.
export const CHARACTER_FRAMEWORK_TEXT_FIELDS = Object.freeze([
  'motivations', 'ghost', 'wound', 'lie', 'need', 'want',
]);

// Per-field caps, keyed by field name, so a Zod schema or an editor can size
// its inputs without re-deriving the `<FIELD>_MAX` naming convention.
export const CHARACTER_FRAMEWORK_LIMITS = Object.freeze({
  motivations: BIBLE_LIMITS.MOTIVATIONS_MAX,
  ghost: BIBLE_LIMITS.GHOST_MAX,
  wound: BIBLE_LIMITS.WOUND_MAX,
  lie: BIBLE_LIMITS.LIE_MAX,
  need: BIBLE_LIMITS.NEED_MAX,
  want: BIBLE_LIMITS.WANT_MAX,
});

// Every framework field a writer may author, prose + structured. `secrets` is
// a plain string[]; `relationshipLinks` is the structured character↔character
// link list (#1287); `arcType` is one of CHARACTER_ARC_TYPES or null;
// `psychology` is the optional theory-of-control + drives profile (#6414),
// absent until assessed; `sliders` is the always-present Three-Sliders object
// (#2175) whose axes are null until rated.
export const CHARACTER_FRAMEWORK_FIELDS = Object.freeze([
  ...CHARACTER_FRAMEWORK_TEXT_FIELDS,
  'arcType', 'secrets', 'relationshipLinks', 'psychology', 'sliders',
]);

// Projection used to hand an author-side review the framework it is supposed
// to judge delivery against, without shipping the render-oriented half of the
// profile (physical description, image refs, wardrobes, voice). Entries with
// nothing authored are dropped so an unfilled cast contributes no prompt text
// at all rather than a page of empty keys.
export function pickCharacterFramework(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = { name: typeof entry.name === 'string' ? entry.name : '' };
  for (const field of CHARACTER_FRAMEWORK_TEXT_FIELDS) {
    const value = typeof entry[field] === 'string' ? entry[field].trim() : '';
    if (value) out[field] = value;
  }
  if (typeof entry.role === 'string' && entry.role.trim()) out.role = entry.role.trim();
  if (CHARACTER_ARC_TYPES.includes(entry.arcType)) out.arcType = entry.arcType;
  const secrets = Array.isArray(entry.secrets) ? entry.secrets.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (secrets.length) out.secrets = secrets;
  const links = Array.isArray(entry.relationshipLinks) ? entry.relationshipLinks : [];
  if (links.length) {
    out.relationshipLinks = links.map((l) => ({
      targetCharacterId: l?.targetCharacterId || '',
      type: l?.type || 'custom',
      description: l?.description || '',
    }));
  }
  // `name` alone means the writer has authored no framework for this
  // character — the caller drops it rather than prompting against a husk.
  return Object.keys(out).length > 1 ? out : null;
}

// Framework projection for a whole cast, empty entries removed. Returns `[]`
// (not null) when nobody has a framework yet, so a caller can use array
// emptiness as its "omit the section" signal.
export function pickCastFramework(characters) {
  if (!Array.isArray(characters)) return [];
  return characters.map(pickCharacterFramework).filter(Boolean);
}

// Optional structured psychology profile (#6414) — the character's operating
// rule and the three drives it manages. Defined here, beside the rest of the
// framework, so the Zod schemas, the Universe cast editor and the Writers Room
// bible read one list instead of hand-mirroring the axes in each. `status`
// means PERCEIVED VALUE TO A GROUP — not wealth, not dominance — which is why
// the axis carries its own editor hint rather than relying on the label.
export const PSYCHOLOGY_DRIVE_AXES = Object.freeze(['survival', 'connection', 'status']);

// An author may rule the profile out rather than leave it blank: `unknown` and
// `not-applicable` both expect an explanation in `assessmentNote`, which is
// what makes the entry read as ASSESSED instead of unfilled.
export const PSYCHOLOGY_ASSESSMENTS = Object.freeze(['assessed', 'unknown', 'not-applicable']);

// The prose half of the profile, in authoring order. `assessmentNote` is NOT
// here: it is the escape-hatch explanation, shown only for a non-`assessed`
// assessment, and it is capped separately below.
export const CHARACTER_PSYCHOLOGY_TEXT_FIELDS = Object.freeze([
  'theoryOfControl', 'strategy', 'protectiveBenefit', 'presentCost',
  'testingPressure', 'candidateChange',
]);

// Per-field caps for the profile. `assessmentNote` and `drive` (shared by every
// drive `desire` / `fear` leaf) sit alongside the prose fields so a schema or an
// editor can size every input from one map.
export const CHARACTER_PSYCHOLOGY_LIMITS = Object.freeze({
  theoryOfControl: BIBLE_LIMITS.THEORY_OF_CONTROL_MAX,
  strategy: BIBLE_LIMITS.PSYCHOLOGY_STRATEGY_MAX,
  protectiveBenefit: BIBLE_LIMITS.PSYCHOLOGY_PROTECTION_MAX,
  presentCost: BIBLE_LIMITS.PSYCHOLOGY_COST_MAX,
  testingPressure: BIBLE_LIMITS.PSYCHOLOGY_PRESSURE_MAX,
  candidateChange: BIBLE_LIMITS.PSYCHOLOGY_CHANGE_MAX,
  assessmentNote: BIBLE_LIMITS.PSYCHOLOGY_NOTE_MAX,
  drive: BIBLE_LIMITS.PSYCHOLOGY_DRIVE_FIELD_MAX,
});

// The Three Sliders (#2175) — integers in [SLIDER_MIN, SLIDER_MAX], each null
// when the axis was never rated (distinct from a deliberate low rating).
export const CHARACTER_SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

// Structured relationship-link archetypes (#1287). An unrecognized value
// (legacy record, newer peer) coerces to `custom` in the sanitizer rather than
// dropping the link, so this list bounds the EDITOR's choices, not the wire.
export const RELATIONSHIP_LINK_TYPES = Object.freeze([
  'ally', 'antagonist', 'rival', 'mentor', 'love-interest', 'family', 'custom',
]);
