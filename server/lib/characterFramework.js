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
// link list (#1287); `arcType` is one of CHARACTER_ARC_TYPES or null.
export const CHARACTER_FRAMEWORK_FIELDS = Object.freeze([
  ...CHARACTER_FRAMEWORK_TEXT_FIELDS,
  'arcType', 'secrets', 'relationshipLinks',
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
