/**
 * Universe Character — LLM expansion.
 *
 * One LLM call that fleshes out blank fields on a universe canon character
 * without clobbering populated content. Strict "fill blanks only" semantics:
 *   - key absent from LLM response → preserve existing value
 *   - key present with empty string/array → IGNORED (no-op; expand flow has
 *     no "clear" intent — an empty proposal just means the LLM had nothing
 *     to add). Distinct from the AGENTS.md merge convention used for
 *     direct-user PATCHes, where empty CAN mean clear.
 *   - key present with non-empty value → fill ONLY when target field is blank.
 */

import { buildStyleClause } from './universeCanon.js';
import { runCanonEntryExpand } from './universeCanonExpandRunner.js';
import { BIBLE_KIND, sanitizeBibleField, PSYCHOLOGY_DRIVE_AXES } from '../lib/storyBible.js';
import { BIBLE_EXPAND_FIELDS, bibleFieldIsBlank, SLIDER_AXES } from '../lib/universeBibleCompleteness.js';

// Adding a new extended field on `sanitizeCharacter` requires adding it to
// `BIBLE_EXPAND_FIELDS.character` too — otherwise the expand response key is
// silently dropped. Sourced from there rather than restated here so the
// completeness scan that decides WHICH characters still need an expand and the
// merge that applies one can never disagree about the field set. Re-exported
// because the vision-driven expand (`universeVisionExpand.js`) fills the SAME
// canonical set.
export const STRING_FIELDS = BIBLE_EXPAND_FIELDS.character.strings;
export const LIST_FIELDS = BIBLE_EXPAND_FIELDS.character.lists;
// `relationshipLinks` (#1287) is INTENTIONALLY excluded from both lists: each
// link points at a sibling character by `targetCharacterId`, an id the LLM
// expand call has no way to produce. The `{ ...target }` spread above
// preserves any existing links untouched; the writer authors them in the UI.

// Distinct from universeCanon's peerForPrompt: the expand prompt benefits from
// the extended visual / theme fields for richer distinctness signals.
const peerForExpandPrompt = (entry) => ({
  id: entry.id,
  name: entry.name,
  role: entry.role || '',
  pronouns: entry.pronouns || '',
  physicalDescription: entry.physicalDescription || '',
  visualNotes: entry.visualNotes || '',
  coreTheme: entry.coreTheme || '',
});

// The flat prose leaves of the psychology profile. `drives` and `assessment`
// are merged separately below (nested object / author ruling).
const PSYCHOLOGY_STRING_FIELDS = Object.freeze([
  'theoryOfControl', 'strategy', 'protectiveBenefit', 'presentCost',
  'testingPressure', 'candidateChange', 'assessmentNote',
]);

const isAbsent = (v) => v === undefined || v === null;
// Exported so the vision-expand path can compute the same "which fields are
// still blank" set it narrows the LLM ask to.
export const isBlankString = (v) => typeof v !== 'string' || v.trim() === '';
export const isBlankArray = (v) => !Array.isArray(v) || v.length === 0;

/**
 * Pure no-clobber merge of an LLM payload onto a character. Exported so the
 * route tests can exercise the merge semantics without an LLM round-trip.
 */
export function applyExpansion(target, content) {
  if (!target || typeof target !== 'object' || !content || typeof content !== 'object') {
    return { merged: target, updatedFields: [] };
  }
  const merged = { ...target };
  const updatedFields = [];
  for (const field of STRING_FIELDS) {
    if (!(field in content)) continue;
    const proposed = content[field];
    if (isAbsent(proposed) || typeof proposed !== 'string') continue;
    if (!bibleFieldIsBlank(target, field)) continue;
    if (isBlankString(proposed)) continue;
    merged[field] = proposed.trim();
    updatedFields.push(field);
  }
  for (const field of LIST_FIELDS) {
    if (!(field in content)) continue;
    const proposed = content[field];
    if (isAbsent(proposed) || !Array.isArray(proposed)) continue;
    if (!bibleFieldIsBlank(target, field)) continue;
    if (isBlankArray(proposed)) continue;
    // Sanitize the proposed list before recording the update: the bible
    // sanitizer drops rows missing required keys (stats without `label`,
    // props/expressions/gestures without `name`, palette without `name`), so a
    // raw acceptance would report `updatedFields: ['stats']` while the persisted
    // character actually saves `stats: []`. Skip the field when nothing survives.
    const cleaned = sanitizeBibleField('character', target, field, proposed);
    if (!Array.isArray(cleaned) || cleaned.length === 0) continue;
    merged[field] = cleaned;
    updatedFields.push(field);
  }
  // arcType — a bare enum string, filled only when the target has no arc type.
  // Sanitized so an unrecognized value (folded to null by trimEnum) never
  // records a spurious update.
  if ('arcType' in content && !isBlankString(content.arcType) && bibleFieldIsBlank(target, 'arcType')) {
    const cleaned = sanitizeBibleField('character', target, 'arcType', content.arcType);
    if (cleaned) {
      merged.arcType = cleaned;
      updatedFields.push('arcType');
    }
  }
  // sliders — a { proactivity, likability, competence } object. Fill each axis
  // ONLY when the target's axis is unset (null), preserving any the user already
  // rated. Sanitize the proposal so an out-of-range value collapses to null and
  // never records a bogus update.
  if (content.sliders && typeof content.sliders === 'object') {
    const proposed = sanitizeBibleField('character', target, 'sliders', content.sliders) || {};
    const existing = (target.sliders && typeof target.sliders === 'object') ? target.sliders : {};
    const nextSliders = { ...existing };
    let changed = false;
    for (const axis of SLIDER_AXES) {
      if (existing[axis] == null && proposed[axis] != null) {
        nextSliders[axis] = proposed[axis];
        changed = true;
      }
    }
    if (changed) {
      merged.sliders = nextSliders;
      updatedFields.push('sliders');
    }
  }
  // psychology (#6414) — a nested profile merged LEAF by leaf, not wholesale.
  // A partial proposal must never replace a populated leaf, and must never
  // drop the leaves the author already wrote (which is what assigning the
  // sanitized proposal directly would do). Same fill-blanks-only contract as
  // the sliders above, one level deeper.
  if (content.psychology && typeof content.psychology === 'object' && !Array.isArray(content.psychology)) {
    const proposed = sanitizeBibleField('character', target, 'psychology', content.psychology);
    if (proposed) {
      const existing = (target.psychology && typeof target.psychology === 'object' && !Array.isArray(target.psychology))
        ? target.psychology
        : {};
      const next = { ...existing };
      let changed = false;
      for (const field of PSYCHOLOGY_STRING_FIELDS) {
        if (!isBlankString(existing[field]) || isBlankString(proposed[field])) continue;
        next[field] = proposed[field];
        changed = true;
      }
      // An `assessment` ruling is the author's call; only fill it when unset.
      if (!existing.assessment && proposed.assessment) {
        next.assessment = proposed.assessment;
        changed = true;
      }
      const nextDrives = { ...(existing.drives && typeof existing.drives === 'object' ? existing.drives : {}) };
      for (const axis of PSYCHOLOGY_DRIVE_AXES) {
        const existingAxis = nextDrives[axis] && typeof nextDrives[axis] === 'object' ? nextDrives[axis] : {};
        const proposedAxis = proposed.drives?.[axis] || {};
        const mergedAxis = { ...existingAxis };
        for (const leaf of ['desire', 'fear']) {
          if (!isBlankString(existingAxis[leaf]) || isBlankString(proposedAxis[leaf])) continue;
          mergedAxis[leaf] = proposedAxis[leaf];
          changed = true;
        }
        nextDrives[axis] = mergedAxis;
      }
      if (changed) {
        merged.psychology = { ...next, drives: nextDrives };
        updatedFields.push('psychology');
      }
    }
  }
  return { merged, updatedFields };
}

/**
 * Fill blank fields on one canon character. The lock checks, the re-derive of
 * the merge inside the write queue, and the return shape all live in
 * `universeCanonExpandRunner.js` — shared with the place/object expand, which
 * needs the same three contracts.
 */
export async function expandUniverseCharacter(universeId, entryId, options = {}) {
  return runCanonEntryExpand({
    universeId,
    kind: BIBLE_KIND.CHARACTER,
    entryId,
    templateName: 'universe-character-expand',
    buildVariables: ({ universe, target, peers }) => ({
      styleClause: buildStyleClause(universe),
      characterJson: JSON.stringify(target),
      peersJson: JSON.stringify(peers.map(peerForExpandPrompt)),
    }),
    applyMerge: applyExpansion,
    options,
    emptyError: {
      code: 'UNIVERSE_CHARACTER_EXPAND_EMPTY',
      message: 'LLM returned an empty character expansion',
    },
  });
}
